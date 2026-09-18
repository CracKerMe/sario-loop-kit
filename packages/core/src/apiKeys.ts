import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@loopkit/db";
import { apiKey } from "@loopkit/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Machine-readable scope catalog — also served via GET /v1/api-keys/meta. */
export const API_KEY_SCOPES = [
  {
    id: "contacts:read",
    label: "Contacts read",
    description: "List and fetch contacts",
    endpoints: ["GET /v1/contacts", "GET /v1/contacts/:id"],
  },
  {
    id: "contacts:write",
    label: "Contacts write",
    description: "Upsert contacts and unsubscribe",
    endpoints: ["POST /v1/contacts", "POST /v1/contacts/:id/unsubscribe"],
  },
  {
    id: "events:write",
    label: "Events write",
    description: "Record lifecycle events that wake journeys",
    endpoints: ["POST /v1/events"],
  },
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]["id"] | "ingest";

export const DEFAULT_API_KEY_SCOPES: string[] = ["contacts:write", "events:write"];

/** Named presets the dashboard offers when creating a key. */
export const API_KEY_PRESETS = [
  {
    id: "agent-ingest",
    label: "Agent ingest",
    description: "AI agents / backend upsert contacts and emit events",
    scopes: DEFAULT_API_KEY_SCOPES,
  },
  {
    id: "contacts-read",
    label: "Read-only",
    description: "Analytics or CRM sync that must not mutate contacts",
    scopes: ["contacts:read"],
  },
  {
    id: "events-only",
    label: "Events only",
    description: "Fire journey signals without creating contacts yourself",
    scopes: ["events:write"],
  },
  {
    id: "full",
    label: "Full access",
    description: "Read and write contacts, plus emit events",
    scopes: ["contacts:read", "contacts:write", "events:write"],
  },
] as const;

/**
 * Legacy `ingest` means “upsert contacts + emit events”.
 * Expanded at auth time so old keys keep working after finer scopes landed.
 */
export function expandScopes(scopes: string[]): string[] {
  const out = new Set<string>();
  for (const s of scopes) {
    if (s === "ingest") {
      out.add("contacts:write");
      out.add("events:write");
    } else {
      out.add(s);
    }
  }
  return [...out];
}

export function hasScope(scopes: string[], required: string[]): boolean {
  const expanded = expandScopes(scopes);
  return required.some((r) => expanded.includes(r));
}

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[bytes[i]! % BASE62.length];
  return out;
}

function hash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!scopes?.length) return [...DEFAULT_API_KEY_SCOPES];
  const expanded = expandScopes(scopes);
  const known = new Set<string>([...API_KEY_SCOPES.map((s) => s.id), "ingest"]);
  const filtered = expanded.filter((s) => known.has(s));
  return filtered.length ? filtered : [...DEFAULT_API_KEY_SCOPES];
}

export interface ApiKeyDto {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  scopes: string[];
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  expiresAt: Date | string | null;
}

export interface CreatedApiKey extends ApiKeyDto {
  /** The full key — shown to the caller exactly once, never stored. */
  key: string;
}

export interface CreateApiKeyInput {
  name: string;
  description?: string | null;
  scopes?: string[];
  /** Absolute expiry; takes precedence over expiresInDays when both set. */
  expiresAt?: Date | null;
  expiresInDays?: number | null;
}

function resolveExpiresAt(input: CreateApiKeyInput): Date | null {
  if (input.expiresAt !== undefined) return input.expiresAt;
  if (input.expiresInDays && input.expiresInDays > 0) {
    return new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
  }
  return null;
}

function issueSecret(): { key: string; prefix: string; hash: string } {
  const secret = randomBase62(32);
  const key = `lk_live_${secret}`;
  return {
    key,
    prefix: `lk_live_${secret.slice(0, 4)}`,
    hash: hash(key),
  };
}

/**
 * `lk_live_<32 base62>` — high-entropy enough that a plain indexed
 * equality lookup on sha256(key) is sufficient; no slow KDF (bcrypt/
 * argon2) needed the way it would be for a low-entropy user password.
 */
export async function createApiKey(
  db: Db,
  workspaceId: string,
  input: string | CreateApiKeyInput,
): Promise<CreatedApiKey> {
  const normalized: CreateApiKeyInput = typeof input === "string" ? { name: input } : input;
  const name = normalized.name.trim();
  if (!name) throw new Error("api_key_name_required");

  const scopes = normalizeScopes(normalized.scopes);
  const description = normalized.description?.trim() || null;
  const expiresAt = resolveExpiresAt(normalized);
  const secret = issueSecret();
  const id = crypto.randomUUID();

  await db.insert(apiKey).values({
    id,
    workspaceId,
    name,
    description,
    prefix: secret.prefix,
    hash: secret.hash,
    scopes,
    expiresAt,
  });

  return {
    id,
    key: secret.key,
    prefix: secret.prefix,
    name,
    description,
    scopes,
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt,
  };
}

export async function listApiKeys(db: Db, workspaceId: string): Promise<ApiKeyDto[]> {
  const rows = await db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      description: apiKey.description,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
    })
    .from(apiKey)
    .where(and(eq(apiKey.workspaceId, workspaceId), isNull(apiKey.revokedAt)))
    .orderBy(desc(apiKey.createdAt));
  return rows;
}

export async function getApiKey(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<ApiKeyDto | null> {
  const [row] = await db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      description: apiKey.description,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
    })
    .from(apiKey)
    .where(and(eq(apiKey.id, id), eq(apiKey.workspaceId, workspaceId), isNull(apiKey.revokedAt)))
    .limit(1);
  return row ?? null;
}

export interface UpdateApiKeyInput {
  name?: string;
  description?: string | null;
  scopes?: string[];
}

export async function updateApiKey(
  db: Db,
  workspaceId: string,
  id: string,
  input: UpdateApiKeyInput,
): Promise<ApiKeyDto | null> {
  const existing = await getApiKey(db, workspaceId, id);
  if (!existing) return null;

  const patch: Partial<typeof apiKey.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("api_key_name_required");
    patch.name = name;
  }
  if (input.description !== undefined) {
    patch.description = input.description?.trim() || null;
  }
  if (input.scopes !== undefined) {
    patch.scopes = normalizeScopes(input.scopes);
  }

  if (Object.keys(patch).length > 0) {
    await db
      .update(apiKey)
      .set(patch)
      .where(and(eq(apiKey.id, id), eq(apiKey.workspaceId, workspaceId)));
  }

  return getApiKey(db, workspaceId, id);
}

export interface VerifiedApiKey {
  id: string;
  workspaceId: string;
  scopes: string[];
}

export async function verifyApiKey(db: Db, presentedKey: string): Promise<VerifiedApiKey | null> {
  if (!presentedKey.startsWith("lk_live_")) return null;

  const [row] = await db
    .select({
      id: apiKey.id,
      workspaceId: apiKey.workspaceId,
      scopes: apiKey.scopes,
      expiresAt: apiKey.expiresAt,
    })
    .from(apiKey)
    .where(and(eq(apiKey.hash, hash(presentedKey)), isNull(apiKey.revokedAt)))
    .limit(1);

  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  // Best-effort — a failed write here must never fail authentication.
  void db
    .update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, row.id))
    .catch(() => {});

  return { id: row.id, workspaceId: row.workspaceId, scopes: row.scopes };
}

/**
 * Issue a new secret for an existing key (same id, name, scopes).
 * Callers must surface the plaintext exactly once.
 */
export async function rotateApiKey(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<CreatedApiKey | null> {
  const existing = await getApiKey(db, workspaceId, id);
  if (!existing) return null;

  const secret = issueSecret();
  await db
    .update(apiKey)
    .set({ prefix: secret.prefix, hash: secret.hash, lastUsedAt: null })
    .where(and(eq(apiKey.id, id), eq(apiKey.workspaceId, workspaceId)));

  return { ...existing, key: secret.key, prefix: secret.prefix, lastUsedAt: null };
}

/** Soft-revoke, scoped to the workspace — a stray id from another tenant is a no-op. */
export async function revokeApiKey(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const result = await db
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKey.id, id), eq(apiKey.workspaceId, workspaceId), isNull(apiKey.revokedAt)))
    .returning({ id: apiKey.id });
  return result.length > 0;
}
