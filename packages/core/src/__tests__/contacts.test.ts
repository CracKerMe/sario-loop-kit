import { workspace } from "@loopkit/db/schema";
import { beforeEach, describe, expect, it } from "vitest";

import {
  bulkUpdateContacts,
  exportContacts,
  listContacts,
  recordContactEvent,
  unsubscribeContact,
  upsertContact,
} from "../contacts";
import { resetTables, testDb } from "./testDb";

const db = testDb();

describe("upsertContact", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  });

  it("creates a new contact", async () => {
    const c = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      properties: { firstName: "Sam" },
    });
    expect(c.email).toBe("sam@example.com");
    expect(c.properties).toMatchObject({ firstName: "Sam" });
  });

  it("returns the camelCase Contact shape, not raw snake_case column names — upsertContact goes through db.execute(sql`...`), which returns columns exactly as Postgres names them, and must map them explicitly", async () => {
    const c = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      userId: "user-abc",
    });
    expect(c.workspaceId).toBe("ws-1");
    expect(c.userId).toBe("user-abc");
    expect(c.subscribed).toBe(true);
    // The raw snake_case keys must NOT be present on the returned object.
    expect(c).not.toHaveProperty("workspace_id");
    expect(c).not.toHaveProperty("user_id");
  });

  it("upserts by case-insensitive email — a repeat call with different casing hits the same row", async () => {
    const first = await upsertContact(db, { workspaceId: "ws-1", email: "sam@example.com" });
    const second = await upsertContact(db, { workspaceId: "ws-1", email: "SAM@EXAMPLE.COM" });
    expect(second.id).toBe(first.id);
  });

  it("merges properties on repeat upserts rather than replacing them", async () => {
    await upsertContact(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      properties: { firstName: "Sam" },
    });
    const second = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      properties: { plan: "pro" },
    });
    expect(second.properties).toMatchObject({ firstName: "Sam", plan: "pro" });
  });

  it("lets a later upsert overwrite a property from an earlier one", async () => {
    await upsertContact(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      properties: { plan: "free" },
    });
    const second = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      properties: { plan: "pro" },
    });
    expect(second.properties.plan).toBe("pro");
  });

  it("scopes contacts by workspace — same email in a different workspace is a distinct contact", async () => {
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
    const a = await upsertContact(db, { workspaceId: "ws-1", email: "sam@example.com" });
    const b = await upsertContact(db, { workspaceId: "ws-2", email: "sam@example.com" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("recordContactEvent", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  });

  it("records an event", async () => {
    const contact = await upsertContact(db, { workspaceId: "ws-1", email: "sam@example.com" });
    const result = await recordContactEvent(db, {
      workspaceId: "ws-1",
      contactId: contact.id,
      name: "order.placed",
    });
    expect(result).not.toBeNull();
  });

  it("is idempotent by idempotencyKey — a redelivered event is a no-op", async () => {
    const contact = await upsertContact(db, { workspaceId: "ws-1", email: "sam@example.com" });
    const first = await recordContactEvent(db, {
      workspaceId: "ws-1",
      contactId: contact.id,
      name: "order.placed",
      idempotencyKey: "order-123",
    });
    const second = await recordContactEvent(db, {
      workspaceId: "ws-1",
      contactId: contact.id,
      name: "order.placed",
      idempotencyKey: "order-123",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // dedup: no row returned on the second insert
  });

  it("without an idempotencyKey, each call records a separate event", async () => {
    const contact = await upsertContact(db, { workspaceId: "ws-1", email: "sam@example.com" });
    const first = await recordContactEvent(db, {
      workspaceId: "ws-1",
      contactId: contact.id,
      name: "page.viewed",
    });
    const second = await recordContactEvent(db, {
      workspaceId: "ws-1",
      contactId: contact.id,
      name: "page.viewed",
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });
});

describe("listContacts", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  });

  it("returns the total alongside the page", async () => {
    for (const email of ["a@x.co", "b@x.co", "c@x.co"]) {
      await upsertContact(db, { workspaceId: "ws-1", email });
    }
    const page1 = await listContacts(db, { workspaceId: "ws-1", page: 1, pageSize: 2 });
    expect(page1.total).toBe(3);
    expect(page1.contacts).toHaveLength(2);

    const page2 = await listContacts(db, { workspaceId: "ws-1", page: 2, pageSize: 2 });
    expect(page2.total).toBe(3);
    expect(page2.contacts).toHaveLength(1);
  });

  it("filters by subscription status", async () => {
    const keep = await upsertContact(db, { workspaceId: "ws-1", email: "keep@x.co" });
    await upsertContact(db, { workspaceId: "ws-1", email: "gone@x.co" });
    await unsubscribeContact(db, "ws-1", keep.id);

    const subscribed = await listContacts(db, { workspaceId: "ws-1", status: "subscribed" });
    expect(subscribed.total).toBe(1);
    expect(subscribed.contacts[0]!.email).toBe("gone@x.co");

    const unsubscribed = await listContacts(db, { workspaceId: "ws-1", status: "unsubscribed" });
    expect(unsubscribed.total).toBe(1);
    expect(unsubscribed.contacts[0]!.email).toBe("keep@x.co");
  });

  it("matches the query against email, userId and properties text, case-insensitively", async () => {
    await upsertContact(db, {
      workspaceId: "ws-1",
      email: "hunter@x.co",
      userId: "ext-77",
      properties: { plan: "pro" },
    });
    await upsertContact(db, { workspaceId: "ws-1", email: "other@x.co" });

    for (const q of ["HUNTER", "ext-77", "PRO", "plan"]) {
      const res = await listContacts(db, { workspaceId: "ws-1", query: q });
      expect(res.total, `query "${q}"`).toBe(1);
      expect(res.contacts[0]!.email).toBe("hunter@x.co");
    }
  });

  it("treats LIKE wildcards in the query as literals, not patterns", async () => {
    await upsertContact(db, { workspaceId: "ws-1", email: "hunter@x.co" });
    await upsertContact(db, { workspaceId: "ws-1", email: "hunter2@x.co" });
    // A literal "%" matches nothing — the query escapes user wildcards.
    const res = await listContacts(db, { workspaceId: "ws-1", query: "%" });
    expect(res.total).toBe(0);
  });

  it("scopes listing by workspace", async () => {
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
    await upsertContact(db, { workspaceId: "ws-1", email: "a@x.co" });
    await upsertContact(db, { workspaceId: "ws-2", email: "b@x.co" });

    const res = await listContacts(db, { workspaceId: "ws-1" });
    expect(res.total).toBe(1);
    expect(res.contacts[0]!.email).toBe("a@x.co");
  });
});

describe("exportContacts", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  });

  it("returns every matching contact without pagination", async () => {
    for (const email of ["a@x.co", "b@x.co", "c@x.co"]) {
      await upsertContact(db, { workspaceId: "ws-1", email, properties: { tier: "gold" } });
    }
    const all = await exportContacts(db, { workspaceId: "ws-1" });
    expect(all).toHaveLength(3);

    const filtered = await exportContacts(db, { workspaceId: "ws-1", query: "gold" });
    expect(filtered).toHaveLength(3);
  });
});

describe("bulkUpdateContacts", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  });

  it("unsubscribes and resubscribes in one call", async () => {
    const ids: string[] = [];
    for (const email of ["a@x.co", "b@x.co"]) {
      ids.push((await upsertContact(db, { workspaceId: "ws-1", email })).id);
    }

    expect(
      (await bulkUpdateContacts(db, { workspaceId: "ws-1", ids, action: "unsubscribe" })).affected,
    ).toBe(2);
    const after = await listContacts(db, { workspaceId: "ws-1", status: "unsubscribed" });
    expect(after.total).toBe(2);

    expect(
      (await bulkUpdateContacts(db, { workspaceId: "ws-1", ids, action: "resubscribe" })).affected,
    ).toBe(2);
    expect((await listContacts(db, { workspaceId: "ws-1", status: "subscribed" })).total).toBe(2);
  });

  it("deletes contacts and cascades their events", async () => {
    const c = await upsertContact(db, { workspaceId: "ws-1", email: "a@x.co" });
    await recordContactEvent(db, { workspaceId: "ws-1", contactId: c.id, name: "e" });

    expect(
      (await bulkUpdateContacts(db, { workspaceId: "ws-1", ids: [c.id], action: "delete" }))
        .affected,
    ).toBe(1);
    expect((await listContacts(db, { workspaceId: "ws-1" })).total).toBe(0);
  });

  it("never touches contacts outside the workspace — ids are scoped, not trusted", async () => {
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
    const mine = await upsertContact(db, { workspaceId: "ws-1", email: "mine@x.co" });
    const theirs = await upsertContact(db, { workspaceId: "ws-2", email: "theirs@x.co" });

    const res = await bulkUpdateContacts(db, {
      workspaceId: "ws-1",
      ids: [mine.id, theirs.id],
      action: "delete",
    });
    expect(res.affected).toBe(1);
    expect((await listContacts(db, { workspaceId: "ws-2" })).total).toBe(1);
  });

  it("is a no-op for an empty id list", async () => {
    expect(
      (await bulkUpdateContacts(db, { workspaceId: "ws-1", ids: [], action: "delete" })).affected,
    ).toBe(0);
  });
});
