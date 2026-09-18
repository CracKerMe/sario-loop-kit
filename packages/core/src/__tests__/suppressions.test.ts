import { contact, workspace } from "@loopkit/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { upsertContact } from "../contacts";
import {
  addSuppression,
  countSuppressionsByReason,
  filterSuppressedEmails,
  getSuppression,
  isEmailSuppressed,
  listSuppressions,
  removeSuppression,
  removeSuppressionById,
} from "../suppressions";
import { resetTables, testDb } from "./testDb";

const db = testDb();

describe("suppression list", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
  });

  it("adds an address and reports it as suppressed", async () => {
    const result = await addSuppression(db, {
      workspaceId: "ws-1",
      email: "Sam@Example.com",
      reason: "hard_bounce",
      source: "resend",
      providerMessageId: "msg-1",
    });

    expect(result.created).toBe(true);
    // Normalised on write, so the unique index can't be bypassed by case.
    expect(result.suppression?.email).toBe("sam@example.com");
    expect(await isEmailSuppressed(db, "ws-1", "SAM@example.com")).toBe(true);
    expect(await isEmailSuppressed(db, "ws-1", "  sam@example.com  ")).toBe(true);
    expect(await isEmailSuppressed(db, "ws-1", "other@example.com")).toBe(false);
  });

  it("is idempotent and first-write-wins on the reason", async () => {
    const first = await addSuppression(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      reason: "hard_bounce",
      source: "resend",
    });
    const second = await addSuppression(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      reason: "manual",
      source: "manual",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.suppression).toBeNull(); // no row back = already present

    const row = await getSuppression(db, "ws-1", "sam@example.com");
    expect(row?.reason).toBe("hard_bounce");
    expect(row?.source).toBe("resend");

    const { total } = await listSuppressions(db, { workspaceId: "ws-1" });
    expect(total).toBe(1);
  });

  it("does not leak across workspaces", async () => {
    await addSuppression(db, {
      workspaceId: "ws-2",
      email: "sam@example.com",
      reason: "manual",
    });
    expect(await isEmailSuppressed(db, "ws-1", "sam@example.com")).toBe(false);
    expect(await getSuppression(db, "ws-1", "sam@example.com")).toBeNull();
  });

  it("keeps suppressing after the contact is deleted and re-imported — the whole point of the table", async () => {
    const created = await upsertContact(db, { workspaceId: "ws-1", email: "sam@example.com" });
    await addSuppression(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      reason: "hard_bounce",
      contactId: created.id,
    });

    await db.delete(contact).where(eq(contact.id, created.id));

    // The FK is ON DELETE SET NULL, so the compliance record survives its
    // contact — and a re-import comes back as a fresh subscribed contact,
    // which is exactly the scenario that would otherwise silently resume
    // sending to a dead mailbox.
    const row = await getSuppression(db, "ws-1", "sam@example.com");
    expect(row).not.toBeNull();
    expect(row?.contactId).toBeNull();

    const reimported = await upsertContact(db, { workspaceId: "ws-1", email: "sam@example.com" });
    expect(reimported.subscribed).toBe(true); // the contact row knows nothing
    expect(await isEmailSuppressed(db, "ws-1", reimported.email)).toBe(true); // but the gate holds
  });

  it("filters a batch of addresses in one call", async () => {
    await addSuppression(db, { workspaceId: "ws-1", email: "a@example.com", reason: "manual" });
    await addSuppression(db, { workspaceId: "ws-1", email: "B@example.com", reason: "complaint" });
    await addSuppression(db, { workspaceId: "ws-2", email: "c@example.com", reason: "manual" });

    const blocked = await filterSuppressedEmails(db, "ws-1", [
      "a@example.com",
      "b@example.com",
      "C@example.com", // other workspace
      "d@example.com",
    ]);

    expect([...blocked].sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("returns an empty set for an empty batch without querying", async () => {
    expect((await filterSuppressedEmails(db, "ws-1", [])).size).toBe(0);
    expect((await filterSuppressedEmails(db, "ws-1", ["  ", ""])).size).toBe(0);
  });

  it("removes by email and by id, scoped to the workspace", async () => {
    const added = await addSuppression(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      reason: "manual",
    });
    expect(await removeSuppressionById(db, "ws-2", added.suppression!.id)).toBe(false);
    expect(await removeSuppressionById(db, "ws-1", added.suppression!.id)).toBe(true);

    await addSuppression(db, { workspaceId: "ws-1", email: "kim@example.com", reason: "manual" });
    expect(await removeSuppression(db, "ws-2", "kim@example.com")).toBe(false);
    expect(await removeSuppression(db, "ws-1", "KIM@example.com")).toBe(true);
    expect(await removeSuppression(db, "ws-1", "kim@example.com")).toBe(false); // gone
  });

  it("filters the list by reason and by free-text query", async () => {
    await addSuppression(db, {
      workspaceId: "ws-1",
      email: "a@example.com",
      reason: "hard_bounce",
      note: "mailbox full",
    });
    await addSuppression(db, { workspaceId: "ws-1", email: "b@example.com", reason: "complaint" });
    await addSuppression(db, { workspaceId: "ws-1", email: "c@example.com", reason: "manual" });

    const bounced = await listSuppressions(db, { workspaceId: "ws-1", reason: "hard_bounce" });
    expect(bounced.total).toBe(1);
    expect(bounced.suppressions[0]?.email).toBe("a@example.com");

    const byNote = await listSuppressions(db, { workspaceId: "ws-1", query: "mailbox" });
    expect(byNote.total).toBe(1);

    const byAddress = await listSuppressions(db, { workspaceId: "ws-1", query: "B@EXAMPLE" });
    expect(byAddress.total).toBe(1);
    expect(byAddress.suppressions[0]?.email).toBe("b@example.com");
  });

  it("paginates without changing the total", async () => {
    for (let i = 0; i < 5; i++) {
      await addSuppression(db, {
        workspaceId: "ws-1",
        email: `user${i}@example.com`,
        reason: "manual",
      });
    }
    const page1 = await listSuppressions(db, { workspaceId: "ws-1", page: 1, pageSize: 2 });
    const page3 = await listSuppressions(db, { workspaceId: "ws-1", page: 3, pageSize: 2 });
    expect(page1.suppressions).toHaveLength(2);
    expect(page3.suppressions).toHaveLength(1);
    expect(page1.total).toBe(5);
    expect(page3.total).toBe(5);
  });

  it("counts by reason for the compliance panel", async () => {
    await addSuppression(db, {
      workspaceId: "ws-1",
      email: "a@example.com",
      reason: "hard_bounce",
    });
    await addSuppression(db, {
      workspaceId: "ws-1",
      email: "b@example.com",
      reason: "hard_bounce",
    });
    await addSuppression(db, { workspaceId: "ws-1", email: "c@example.com", reason: "complaint" });
    await addSuppression(db, { workspaceId: "ws-2", email: "d@example.com", reason: "complaint" });

    expect(await countSuppressionsByReason(db, "ws-1")).toEqual({
      hard_bounce: 2,
      complaint: 1,
      manual: 0,
      unsubscribe: 0,
    });
  });

  it("records the manual actor for audit", async () => {
    const result = await addSuppression(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      reason: "manual",
      source: "manual",
      note: "legal request 2026-09",
      createdBy: "user-1",
    });
    expect(result.suppression?.note).toBe("legal request 2026-09");
    expect(result.suppression?.createdBy).toBe("user-1");
  });
});
