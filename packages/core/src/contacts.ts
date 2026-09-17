import type { Db } from "@loopkit/db";
import { contact, contactEvent } from "@loopkit/db/schema";
import { and, eq, sql } from "drizzle-orm";

export interface UpsertContactInput {
  workspaceId: string;
  email: string;
  userId?: string;
  properties?: Record<string, unknown>;
}

export interface Contact {
  id: string;
  workspaceId: string;
  email: string;
  userId: string | null;
  properties: Record<string, unknown>;
  subscribed: boolean;
}

/** Raw column names exactly as node-postgres returns them from RETURNING *. */
interface RawContactRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  email: string;
  user_id: string | null;
  properties: Record<string, unknown>;
  subscribed: boolean;
}

function fromRawRow(row: RawContactRow): Contact {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    userId: row.user_id,
    properties: row.properties,
    subscribed: row.subscribed,
  };
}

/**
 * Upserts by (workspaceId, lower(email)) — the same identity the schema's
 * case-insensitive unique index enforces. A second call with new
 * properties merges them into the existing row rather than replacing it,
 * so `POST /v1/contacts` behaves like a partial update on repeat calls
 * (the common ingestion pattern: send whatever you know at the time).
 *
 * Uses raw SQL rather than Drizzle's onConflictDoUpdate() query builder:
 * contact_ws_email_uidx is a unique index on (workspace_id, lower(email))
 * — an expression, not a plain column — and Drizzle's typed `target`
 * only accepts IndexColumn references, not an arbitrary SQL expression,
 * so there is no query-builder path to an ON CONFLICT clause that
 * matches this index.
 *
 * node-postgres's raw db.execute() returns column names exactly as
 * Postgres sends them over the wire (snake_case), not the schema's
 * camelCase — see @loopkit/timers' TimerPoller.claim() for the same
 * class of bug caught there. RETURNING * rows are mapped explicitly via
 * fromRawRow() below rather than cast to the camelCase inferred type.
 */
export async function upsertContact(db: Db, input: UpsertContactInput): Promise<Contact> {
  const id = crypto.randomUUID();
  const properties = JSON.stringify(input.properties ?? {});

  const result = await db.execute<RawContactRow>(sql`
    INSERT INTO ${contact} (id, workspace_id, email, user_id, properties)
    VALUES (${id}, ${input.workspaceId}, ${input.email}, ${input.userId ?? null}, ${properties}::jsonb)
    ON CONFLICT (workspace_id, lower(email)) DO UPDATE SET
      user_id = COALESCE(EXCLUDED.user_id, ${contact}.user_id),
      properties = ${contact}.properties || EXCLUDED.properties,
      updated_at = now()
    RETURNING *
  `);

  const row = result.rows[0];
  if (!row) throw new Error("upsertContact: INSERT ... RETURNING produced no row");
  return fromRawRow(row);
}

export async function getContactById(
  db: Db,
  workspaceId: string,
  contactId: string,
): Promise<Contact | null> {
  const [row] = await db
    .select()
    .from(contact)
    .where(and(eq(contact.workspaceId, workspaceId), eq(contact.id, contactId)))
    .limit(1);
  return row ?? null;
}

export async function unsubscribeContact(
  db: Db,
  workspaceId: string,
  contactId: string,
): Promise<void> {
  await db
    .update(contact)
    .set({ subscribed: false, unsubscribedAt: new Date() })
    .where(and(eq(contact.workspaceId, workspaceId), eq(contact.id, contactId)));
}

export interface RecordEventInput {
  workspaceId: string;
  contactId: string;
  name: string;
  properties?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * Idempotent when idempotencyKey is supplied: a duplicate submission of
 * the same event (a webhook redelivery, a client-side retry) is a no-op
 * rather than double-counting — mirrors the same
 * ON CONFLICT DO NOTHING RETURNING pattern used throughout this codebase
 * for exactly-once-per-key writes over an at-least-once delivery source.
 */
export async function recordContactEvent(
  db: Db,
  input: RecordEventInput,
): Promise<{ id: string } | null> {
  const [row] = await db
    .insert(contactEvent)
    .values({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      name: input.name,
      properties: input.properties ?? {},
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [contactEvent.workspaceId, contactEvent.idempotencyKey],
      where: sql`${contactEvent.idempotencyKey} is not null`,
    })
    .returning({ id: contactEvent.id });

  return row ?? null;
}
