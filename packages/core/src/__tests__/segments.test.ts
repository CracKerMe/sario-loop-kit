import { contact, contactEvent, workspace } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { upsertContact } from "../contacts";
import {
  compileAudienceWhere,
  compileSegmentFilter,
  contactMatchesSegmentFilter,
  describeSegmentFilter,
  MAX_SEGMENT_DEPTH,
  SegmentCompileError,
  validateSegmentFilter,
  type SegmentFilter,
} from "../segments";
import { addSuppression } from "../suppressions";
import { resetTables, testDb } from "./testDb";

const db = testDb();

/** Contact ids matching a filter, sorted — the only thing these tests assert. */
async function matchIds(
  filter: SegmentFilter,
  opts: { excludeUnsendable?: boolean } = {},
): Promise<string[]> {
  const rows = await db
    .select({ id: contact.id })
    .from(contact)
    .where(compileAudienceWhere("ws-1", filter, opts));
  return rows.map((r) => r.id).sort();
}

async function seedContacts(): Promise<void> {
  await upsertContact(db, {
    workspaceId: "ws-1",
    email: "pro@example.com",
    properties: { plan: "pro", seats: 12, company: "Acme Inc", trial: true },
  });
  await upsertContact(db, {
    workspaceId: "ws-1",
    email: "free@example.com",
    properties: { plan: "free", seats: 1, company: "Globex" },
  });
  await upsertContact(db, {
    workspaceId: "ws-1",
    email: "noplan@example.com",
    properties: { company: "Initech" },
  });
  // A contact whose numeric-looking property is actually a string — the row
  // that makes an unguarded `(...)::numeric` cast blow up the whole query.
  await upsertContact(db, {
    workspaceId: "ws-1",
    email: "messy@example.com",
    properties: { plan: "pro", seats: "not-a-number" },
  });
}

/** The seeded contacts keyed by email, for readable assertions. */
async function idsByEmail(): Promise<Record<string, string>> {
  const rows = await db.select({ id: contact.id, email: contact.email }).from(contact);
  return Object.fromEntries(rows.map((r) => [r.email, r.id]));
}

describe("compileSegmentFilter — contact fields", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
    await seedContacts();
  });

  it("matches properties by equality via containment, and excludes missing keys", async () => {
    const ids = await idsByEmail();
    expect(
      await matchIds({ kind: "condition", field: "property.plan", operator: "eq", value: "pro" }),
    ).toEqual([ids["pro@example.com"]!, ids["messy@example.com"]!].sort());
    expect(
      await matchIds({ kind: "condition", field: "property.plan", operator: "neq", value: "pro" }),
    ).toEqual([ids["free@example.com"]!, ids["noplan@example.com"]!].sort());
  });

  it("compares numbers without exploding on a non-numeric value in the same key", async () => {
    const ids = await idsByEmail();
    // `messy@example.com` has seats = "not-a-number". An unguarded cast would
    // make this query throw; the jsonb_typeof guard must skip it instead.
    const matched = await matchIds({
      kind: "condition",
      field: "property.seats",
      operator: "gte",
      value: 10,
    });
    expect(matched).toEqual([ids["pro@example.com"]!]);
  });

  it("supports substring and prefix matching, case-insensitively", async () => {
    const ids = await idsByEmail();
    expect(
      await matchIds({
        kind: "condition",
        field: "property.company",
        operator: "contains",
        value: "acme",
      }),
    ).toEqual([ids["pro@example.com"]!]);
    expect(
      await matchIds({
        kind: "condition",
        field: "property.company",
        operator: "starts_with",
        value: "GLO",
      }),
    ).toEqual([ids["free@example.com"]!]);
  });

  it("treats LIKE metacharacters in a value as literal characters", async () => {
    // A user typing "%" means the percent sign, not "match everything".
    expect(
      await matchIds({
        kind: "condition",
        field: "property.company",
        operator: "contains",
        value: "%",
      }),
    ).toEqual([]);
  });

  it("handles existence operators on properties", async () => {
    const ids = await idsByEmail();
    expect(
      await matchIds({ kind: "condition", field: "property.plan", operator: "exists" }),
    ).toEqual(
      [ids["free@example.com"]!, ids["messy@example.com"]!, ids["pro@example.com"]!].sort(),
    );
    expect(
      await matchIds({ kind: "condition", field: "property.plan", operator: "not_exists" }),
    ).toEqual([ids["noplan@example.com"]!]);
  });

  it("uses the boolean property value as a real boolean", async () => {
    const ids = await idsByEmail();
    expect(
      await matchIds({ kind: "condition", field: "property.trial", operator: "eq", value: true }),
    ).toEqual([ids["pro@example.com"]!]);
  });

  it("matches in / not_in lists", async () => {
    const ids = await idsByEmail();
    const matched = await matchIds({
      kind: "condition",
      field: "property.plan",
      operator: "in",
      value: ["pro", "enterprise"],
    });
    expect(matched).toEqual([ids["pro@example.com"]!, ids["messy@example.com"]!].sort());

    // not_in must include contacts with no such property at all.
    const notMatched = await matchIds({
      kind: "condition",
      field: "property.plan",
      operator: "not_in",
      value: ["pro"],
    });
    expect(notMatched).toEqual([ids["free@example.com"]!, ids["noplan@example.com"]!].sort());
  });

  it("matches email and boolean contact columns", async () => {
    const ids = await idsByEmail();
    expect(
      await matchIds({
        kind: "condition",
        field: "email",
        operator: "ends_with",
        value: "@example.com",
      }),
    ).toHaveLength(4);
    expect(
      await matchIds({ kind: "condition", field: "email", operator: "starts_with", value: "pro@" }),
    ).toEqual([ids["pro@example.com"]!]);
    expect(
      await matchIds({ kind: "condition", field: "subscribed", operator: "eq", value: true }),
    ).toHaveLength(4);
  });
});

describe("compileSegmentFilter — structure", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
    await seedContacts();
  });

  it("composes and / or / not", async () => {
    const ids = await idsByEmail();
    const andFilter: SegmentFilter = {
      op: "and",
      children: [
        { kind: "condition", field: "property.plan", operator: "eq", value: "pro" },
        { kind: "condition", field: "property.seats", operator: "gte", value: 10 },
      ],
    };
    expect(await matchIds(andFilter)).toEqual([ids["pro@example.com"]!]);

    const notFilter: SegmentFilter = {
      op: "not",
      child: { kind: "condition", field: "property.plan", operator: "eq", value: "pro" },
    };
    expect(await matchIds(notFilter)).toEqual(
      [ids["free@example.com"]!, ids["noplan@example.com"]!].sort(),
    );

    const orFilter: SegmentFilter = {
      op: "or",
      children: [
        { kind: "condition", field: "property.company", operator: "eq", value: "Globex" },
        { kind: "condition", field: "property.company", operator: "eq", value: "Initech" },
      ],
    };
    expect(await matchIds(orFilter)).toEqual(
      [ids["free@example.com"]!, ids["noplan@example.com"]!].sort(),
    );
  });

  it("refuses an empty group rather than silently matching everyone", async () => {
    expect(() => compileSegmentFilter({ op: "and", children: [] })).toThrow(SegmentCompileError);
    expect(() => compileSegmentFilter({ op: "or", children: [] })).toThrow(SegmentCompileError);
  });

  it("refuses to compile past the depth limit", async () => {
    let filter: SegmentFilter = {
      kind: "condition",
      field: "subscribed",
      operator: "eq",
      value: true,
    };
    for (let i = 0; i <= MAX_SEGMENT_DEPTH + 1; i++) filter = { op: "not", child: filter };
    expect(() => compileSegmentFilter(filter)).toThrow(SegmentCompileError);
  });

  it("produces a human-readable summary", () => {
    const filter: SegmentFilter = {
      op: "and",
      children: [
        { kind: "condition", field: "property.plan", operator: "eq", value: "pro" },
        { kind: "event", name: "email.opened", occurred: true, withinDays: 30 },
      ],
    };
    expect(describeSegmentFilter(filter)).toBe(
      'property.plan eq pro AND did "email.opened" in the last 30d',
    );
  });
});

describe("compileSegmentFilter — events", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
    await seedContacts();
  });

  async function record(email: string, name: string, daysAgo = 0, count = 1): Promise<void> {
    const ids = await idsByEmail();
    for (let i = 0; i < count; i++) {
      await db.insert(contactEvent).values({
        id: crypto.randomUUID(),
        workspaceId: "ws-1",
        contactId: ids[email]!,
        name,
        occurredAt: new Date(Date.now() - daysAgo * 86_400_000),
      });
    }
  }

  it("matches contacts who did an event, and excludes those who didn't", async () => {
    const ids = await idsByEmail();
    await record("pro@example.com", "email.opened");
    await record("free@example.com", "email.opened", 40);

    const occurred = await matchIds({
      kind: "event",
      name: "email.opened",
      occurred: true,
    });
    expect(occurred).toEqual([ids["free@example.com"]!, ids["pro@example.com"]!].sort());

    const notOccurred = await matchIds({ kind: "event", name: "email.opened", occurred: false });
    expect(notOccurred).toEqual([ids["messy@example.com"]!, ids["noplan@example.com"]!].sort());
  });

  it("treats a contact with no events at all as 'has not done it'", async () => {
    await record("pro@example.com", "order.placed");
    const ids = await idsByEmail();
    const notOccurred = await matchIds({ kind: "event", name: "order.placed", occurred: false });
    expect(notOccurred).not.toContain(ids["pro@example.com"]);
    expect(notOccurred).toHaveLength(3);
  });

  it("honours withinDays", async () => {
    const ids = await idsByEmail();
    await record("pro@example.com", "email.opened", 2);
    await record("free@example.com", "email.opened", 40);

    const recent = await matchIds({
      kind: "event",
      name: "email.opened",
      occurred: true,
      withinDays: 30,
    });
    expect(recent).toEqual([ids["pro@example.com"]!]);
  });

  it("honours minCount", async () => {
    const ids = await idsByEmail();
    await record("pro@example.com", "email.opened", 1, 3);
    await record("free@example.com", "email.opened", 1, 1);

    const frequent = await matchIds({
      kind: "event",
      name: "email.opened",
      occurred: true,
      minCount: 3,
    });
    expect(frequent).toEqual([ids["pro@example.com"]!]);
  });

  it("scopes event matching to the workspace", async () => {
    const ids = await idsByEmail();
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
    const other = await upsertContact(db, { workspaceId: "ws-2", email: "outsider@example.com" });
    await db.insert(contactEvent).values({
      id: crypto.randomUUID(),
      workspaceId: "ws-2",
      contactId: other.id,
      name: "email.opened",
      occurredAt: new Date(),
    });

    const matched = await matchIds({ kind: "event", name: "email.opened", occurred: true });
    expect(matched).toEqual([]);
    expect(matched).not.toContain(ids["pro@example.com"]);
  });
});

describe("compileAudienceWhere — sendability filter", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
    await seedContacts();
  });

  it("excludes unsubscribed and suppressed contacts only when asked", async () => {
    const ids = await idsByEmail();
    // Matches every contact in the workspace, so the only thing separating
    // the two results is the sendability clause itself.
    const everyone: SegmentFilter = { kind: "condition", field: "subscribed", operator: "exists" };

    await upsertContact(db, { workspaceId: "ws-1", email: "opted-out@example.com" });
    await db
      .update(contact)
      .set({ subscribed: false })
      .where(eq(contact.email, "opted-out@example.com"));
    await upsertContact(db, { workspaceId: "ws-1", email: "suppressed@example.com" });
    await addSuppression(db, {
      workspaceId: "ws-1",
      email: "suppressed@example.com",
      reason: "hard_bounce",
    });

    const all = await matchIds(everyone);
    const sendable = await matchIds(everyone, { excludeUnsendable: true });
    const after = await idsByEmail();

    expect(all).toHaveLength(6);
    expect(all).toContain(ids["pro@example.com"]);
    // The two excluded rows are excluded for two different reasons — an
    // opt-out and an address-level suppression — and both must be caught.
    expect(sendable).toHaveLength(4);
    expect(sendable).not.toContain(after["opted-out@example.com"]);
    expect(sendable).not.toContain(after["suppressed@example.com"]);
    expect(sendable).toContain(after["pro@example.com"]);
  });

  it("never leaks another workspace's contacts", async () => {
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
    await upsertContact(db, { workspaceId: "ws-2", email: "outsider@example.com" });
    const rows = await db
      .select({ id: contact.id })
      .from(contact)
      .where(
        compileAudienceWhere("ws-1", {
          kind: "condition",
          field: "subscribed",
          operator: "exists",
        }),
      );
    expect(rows).toHaveLength(4);
  });
});

describe("contactMatchesSegmentFilter — journey entry freeze", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
    await seedContacts();
  });

  it("returns true when the contact matches a frozen audience AST", async () => {
    const ids = await idsByEmail();
    const ok = await contactMatchesSegmentFilter(db, {
      workspaceId: "ws-1",
      contactId: ids["pro@example.com"]!,
      filter: { kind: "condition", field: "property.plan", operator: "eq", value: "pro" },
    });
    expect(ok).toBe(true);
  });

  it("returns false when the contact does not match", async () => {
    const ids = await idsByEmail();
    const ok = await contactMatchesSegmentFilter(db, {
      workspaceId: "ws-1",
      contactId: ids["free@example.com"]!,
      filter: { kind: "condition", field: "property.plan", operator: "eq", value: "pro" },
    });
    expect(ok).toBe(false);
  });

  it("fails closed on an invalid filter", async () => {
    const ids = await idsByEmail();
    const ok = await contactMatchesSegmentFilter(db, {
      workspaceId: "ws-1",
      contactId: ids["pro@example.com"]!,
      filter: { kind: "condition", field: "nope", operator: "eq", value: "x" },
    });
    expect(ok).toBe(false);
  });
});

describe("validateSegmentFilter", () => {
  it("accepts a valid tree", () => {
    const result = validateSegmentFilter({
      op: "and",
      children: [
        { kind: "condition", field: "property.plan", operator: "eq", value: "pro" },
        { kind: "event", name: "order.placed", occurred: false },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects an unknown field", () => {
    const result = validateSegmentFilter({
      kind: "condition",
      field: "property.",
      operator: "eq",
      value: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("unknown field");
  });

  it("rejects an operator that doesn't fit the field type", () => {
    expect(
      validateSegmentFilter({
        kind: "condition",
        field: "subscribed",
        operator: "contains",
        value: "y",
      }).ok,
    ).toBe(false);
    expect(
      validateSegmentFilter({
        kind: "condition",
        field: "createdAt",
        operator: "contains",
        value: "y",
      }).ok,
    ).toBe(false);
    // Ordering on an email address is meaningless, so it is rejected rather
    // than silently compiled into a text comparison nobody wanted.
    const orderingOnEmail = validateSegmentFilter({
      kind: "condition",
      field: "email",
      operator: "gt",
      value: "a",
    });
    expect(orderingOnEmail.ok).toBe(false);
    expect(orderingOnEmail.errors.join()).toContain('not valid for string field "email"');
    // ...but ordering on a property string is allowed, because that is how
    // an ISO-8601 date stored in properties gets compared.
    expect(
      validateSegmentFilter({
        kind: "condition",
        field: "property.signupDate",
        operator: "gte",
        value: "2026-01-01",
      }).ok,
    ).toBe(true);
  });

  it("requires a value for every operator except exists / not_exists", () => {
    const missing = validateSegmentFilter({
      kind: "condition",
      field: "property.plan",
      operator: "eq",
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join()).toContain("requires a value");

    expect(
      validateSegmentFilter({ kind: "condition", field: "property.plan", operator: "exists" }).ok,
    ).toBe(true);
    expect(
      validateSegmentFilter({ kind: "condition", field: "property.plan", operator: "not_exists" })
        .ok,
    ).toBe(true);
  });

  it("requires an array for in / not_in and rejects one elsewhere", () => {
    expect(
      validateSegmentFilter({
        kind: "condition",
        field: "property.plan",
        operator: "in",
        value: "pro",
      }).ok,
    ).toBe(false);
    expect(
      validateSegmentFilter({
        kind: "condition",
        field: "property.plan",
        operator: "eq",
        value: ["pro"],
      }).ok,
    ).toBe(false);
    expect(
      validateSegmentFilter({
        kind: "condition",
        field: "property.plan",
        operator: "in",
        value: ["pro", "free"],
      }).ok,
    ).toBe(true);
  });

  it("rejects a tree deeper than the limit", () => {
    let filter: unknown = { kind: "condition", field: "subscribed", operator: "eq", value: true };
    for (let i = 0; i <= MAX_SEGMENT_DEPTH + 1; i++) filter = { op: "not", child: filter };
    const result = validateSegmentFilter(filter);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("nests deeper");
  });

  it("rejects an empty group and a widowed not", () => {
    expect(validateSegmentFilter({ op: "and", children: [] }).ok).toBe(false);
    expect(validateSegmentFilter({ op: "not" }).ok).toBe(false);
  });

  it("rejects junk", () => {
    for (const junk of [null, undefined, 42, "filter", {}, []]) {
      expect(validateSegmentFilter(junk).ok).toBe(false);
    }
  });

  it("rejects an unknown operator", () => {
    expect(
      validateSegmentFilter({ kind: "condition", field: "email", operator: "regex", value: ".*" })
        .ok,
    ).toBe(false);
  });
});
