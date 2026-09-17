import { apiKey, workspace } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createApiKey, revokeApiKey, verifyApiKey } from "../apiKeys";
import { resetTables, testDb } from "./testDb";

const db = testDb();

describe("API keys", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  });

  it("creates a key with the lk_live_ prefix", async () => {
    const created = await createApiKey(db, "ws-1", "ingest key");
    expect(created.key).toMatch(/^lk_live_/);
    expect(created.prefix).toMatch(/^lk_live_/);
  });

  it("verifies a freshly-created key and resolves its workspace", async () => {
    const created = await createApiKey(db, "ws-1", "ingest key");
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
    const created = await createApiKey(db, "ws-1", "ingest key");
    await revokeApiKey(db, created.id);
    const verified = await verifyApiKey(db, created.key);
    expect(verified).toBeNull();
  });

  it("never stores the plaintext key", async () => {
    const created = await createApiKey(db, "ws-1", "ingest key");
    const [row] = await db.select().from(apiKey).where(eq(apiKey.id, created.id));
    expect(row?.hash).not.toBe(created.key);
    expect(JSON.stringify(row)).not.toContain(created.key);
  });
});
