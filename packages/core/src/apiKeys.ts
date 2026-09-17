import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@loopkit/db";
import { apiKey } from "@loopkit/db/schema";
import { and, eq, isNull } from "drizzle-orm";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[bytes[i]! % BASE62.length];
  return out;
}

function hash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface CreatedApiKey {
  id: string;
  /** The full key — shown to the caller exactly once, never stored. */
  key: string;
  prefix: string;
}

/**
 * `lk_live_<32 base62>` — high-entropy enough that a plain indexed
 * equality lookup on sha256(key) is sufficient; no slow KDF (bcrypt/
 * argon2) needed the way it would be for a low-entropy user password.
 */
export async function createApiKey(
  db: Db,
  workspaceId: string,
  name: string,
  scopes: string[] = ["ingest"],
): Promise<CreatedApiKey> {
  const secret = randomBase62(32);
  const key = `lk_live_${secret}`;
  const prefix = `lk_live_${secret.slice(0, 4)}`;
  const id = crypto.randomUUID();

  await db.insert(apiKey).values({
    id,
    workspaceId,
    name,
    prefix,
    hash: hash(key),
    scopes,
  });

  return { id, key, prefix };
}

export interface VerifiedApiKey {
  id: string;
  workspaceId: string;
  scopes: string[];
}

export async function verifyApiKey(db: Db, presentedKey: string): Promise<VerifiedApiKey | null> {
  if (!presentedKey.startsWith("lk_live_")) return null;

  const [row] = await db
    .select({ id: apiKey.id, workspaceId: apiKey.workspaceId, scopes: apiKey.scopes })
    .from(apiKey)
    .where(and(eq(apiKey.hash, hash(presentedKey)), isNull(apiKey.revokedAt)))
    .limit(1);

  if (!row) return null;

  // Best-effort — a failed write here must never fail authentication.
  void db
    .update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, row.id))
    .catch(() => {});

  return row;
}

export async function revokeApiKey(db: Db, id: string): Promise<void> {
  await db.update(apiKey).set({ revokedAt: new Date() }).where(eq(apiKey.id, id));
}
