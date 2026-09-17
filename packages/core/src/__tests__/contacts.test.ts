import { workspace } from "@loopkit/db/schema";
import { beforeEach, describe, expect, it } from "vitest";

import { recordContactEvent, upsertContact } from "../contacts";
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
