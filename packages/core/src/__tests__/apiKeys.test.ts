import { apiKey, workspace } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createApiKey,
  expandScopes,
  hasScope,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateApiKey,
  verifyApiKey,
} from "../apiKeys";
import { resetTables, testDb } from "./testDb";

const db = testDb();

describe("API keys", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  });

  it("creates a key with the lk_live_ prefix and default agent scopes", async () => {
    const created = await createApiKey(db, "ws-1", { name: "ingest key" });
    expect(created.key).toMatch(/^lk_live_/);
    expect(created.prefix).toMatch(/^lk_live_/);
    expect(created.scopes).toEqual(["contacts:write", "events:write"]);
  });

  it("accepts explicit scopes, description, and expiry", async () => {
    const created = await createApiKey(db, "ws-1", {
      name: "crm sync",
      description: "Read-only CRM pull",
      scopes: ["contacts:read"],
      expiresInDays: 30,
    });
    expect(created.scopes).toEqual(["contacts:read"]);
    expect(created.description).toBe("Read-only CRM pull");
    expect(created.expiresAt).toBeInstanceOf(Date);
  });

  it("verifies a freshly-created key and resolves its workspace", async () => {
    const created = await createApiKey(db, "ws-1", { name: "ingest key" });
    const verified = await verifyApiKey(db, created.key);
    expect(verified?.workspaceId).toBe("ws-1");
  });

  it("rejects a key that was never issued", async () => {
    const verified = await verifyApiKey(db, "lk_live_totallyMadeUpKeyThatDoesNotExist12");
    expect(verified).toBeNull();
  });

  it("rejects a key with the wrong prefix outright, without a DB round trip", async () => {
    const verified = await verifyApiKey(db, "sk_live_not_a_loopkit_key");
    expect(verified).toBeNull();
  });

  it("rejects a revoked key", async () => {
    const created = await createApiKey(db, "ws-1", { name: "ingest key" });
    await revokeApiKey(db, "ws-1", created.id);
    const verified = await verifyApiKey(db, created.key);
    expect(verified).toBeNull();
  });

  it("does not revoke keys that belong to another workspace", async () => {
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
    const created = await createApiKey(db, "ws-1", { name: "tenant key" });
    const revoked = await revokeApiKey(db, "ws-2", created.id);
    expect(revoked).toBe(false);
    const verified = await verifyApiKey(db, created.key);
    expect(verified?.workspaceId).toBe("ws-1");
  });

  it("never stores the plaintext key", async () => {
    const created = await createApiKey(db, "ws-1", { name: "ingest key" });
    const [row] = await db.select().from(apiKey).where(eq(apiKey.id, created.id));
    expect(row?.hash).not.toBe(created.key);
    expect(JSON.stringify(row)).not.toContain(created.key);
  });

  it("rejects an expired key", async () => {
    const created = await createApiKey(db, "ws-1", {
      name: "temp",
      expiresAt: new Date(Date.now() - 1000),
    });
    const verified = await verifyApiKey(db, created.key);
    expect(verified).toBeNull();
  });

  it("rotates a key secret while keeping the same identity", async () => {
    const created = await createApiKey(db, "ws-1", {
      name: "agent",
      scopes: ["contacts:read"],
      description: "keep me",
    });
    const rotated = await rotateApiKey(db, "ws-1", created.id);
    expect(rotated?.id).toBe(created.id);
    expect(rotated?.key).not.toBe(created.key);
    expect(rotated?.name).toBe("agent");
    expect(rotated?.scopes).toEqual(["contacts:read"]);
    expect(rotated?.description).toBe("keep me");

    expect(await verifyApiKey(db, created.key)).toBeNull();
    const verified = await verifyApiKey(db, rotated!.key);
    expect(verified?.id).toBe(created.id);
  });

  it("updates name, description, and scopes", async () => {
    const created = await createApiKey(db, "ws-1", { name: "old" });
    const updated = await updateApiKey(db, "ws-1", created.id, {
      name: "new",
      description: "updated",
      scopes: ["contacts:read", "events:write"],
    });
    expect(updated?.name).toBe("new");
    expect(updated?.description).toBe("updated");
    expect(updated?.scopes).toEqual(["contacts:read", "events:write"]);
  });

  it("lists only non-revoked keys for the workspace", async () => {
    const a = await createApiKey(db, "ws-1", { name: "a" });
    await createApiKey(db, "ws-1", { name: "b" });
    await revokeApiKey(db, "ws-1", a.id);
    const rows = await listApiKeys(db, "ws-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("b");
  });

  it("expands legacy ingest scope and evaluates hasScope", () => {
    expect(expandScopes(["ingest"])).toEqual(["contacts:write", "events:write"]);
    expect(hasScope(["ingest"], ["events:write"])).toBe(true);
    expect(hasScope(["ingest"], ["contacts:read"])).toBe(false);
    expect(hasScope(["contacts:read"], ["contacts:read"])).toBe(true);
  });
});
