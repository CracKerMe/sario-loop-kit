import type { Db } from "@loopkit/db";
import { contact, contactEvent } from "@loopkit/db/schema";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

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

/**
 * Replaces the editable property bag for one contact. Unlike `upsertContact`,
 * which deliberately merges partial ingestion updates, the dashboard needs a
 * complete replacement so an operator can remove a custom property as well
 * as add or change one.
 */
export async function replaceContactProperties(
  db: Db,
  workspaceId: string,
  contactId: string,
  properties: Record<string, unknown>,
): Promise<Contact | null> {
  const [row] = await db
    .update(contact)
    .set({ properties, updatedAt: new Date() })
    .where(and(eq(contact.workspaceId, workspaceId), eq(contact.id, contactId)))
    .returning();
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

/**
 * The reverse of unsubscribeContact — the preference centre's "opt back in"
 * path. Note what this does NOT do: it does not lift an address-level
 * suppression. Those are separate decisions with separate consequences (see
 * @loopkit/core's suppressions.ts), and the caller must clear the
 * suppression explicitly — which the public endpoint only allows for
 * reason `unsubscribe`.
 */
export async function resubscribeContact(
  db: Db,
  workspaceId: string,
  contactId: string,
): Promise<void> {
  await db
    .update(contact)
    .set({ subscribed: true, unsubscribedAt: null })
    .where(and(eq(contact.workspaceId, workspaceId), eq(contact.id, contactId)));
}

export type ContactStatusFilter = "all" | "subscribed" | "unsubscribed";

export interface ListContactsInput {
  workspaceId: string;
  /** Case-insensitive substring match over email, userId and JSON properties text. */
  query?: string;
  status?: ContactStatusFilter;
  page?: number; // 1-based
  pageSize?: number;
}

function contactListWhere(input: ListContactsInput) {
  const conditions = [eq(contact.workspaceId, input.workspaceId)];
  const q = input.query?.trim();
  if (q) {
    const pattern = `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    conditions.push(
      or(
        ilike(contact.email, pattern),
        ilike(contact.userId, pattern),
        sql`${contact.properties}::text ilike ${pattern}`,
      )!,
    );
  }
  if (input.status === "subscribed") conditions.push(eq(contact.subscribed, true));
  if (input.status === "unsubscribed") conditions.push(eq(contact.subscribed, false));
  return and(...conditions)!;
}

/**
 * Server-side list for the dashboard: filtering happens in SQL (indexed
 * email match + GIN-backed properties text match) so pagination and the
 * total count stay correct as the workspace grows past the old
 * limit-100 endpoint. Defaults preserve the previous page size.
 */
export async function listContacts(
  db: Db,
  input: ListContactsInput,
): Promise<{ contacts: Contact[]; total: number }> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, input.pageSize ?? 100));
  const where = contactListWhere(input);

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(contact)
      .where(where)
      .orderBy(desc(contact.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contact)
      .where(where),
  ]);

  return { contacts: rows, total: countRow?.count ?? 0 };
}

/** Same filters as listContacts but unpaginated, capped for safety. */
export const CONTACT_EXPORT_LIMIT = 10_000;

export async function exportContacts(db: Db, input: ListContactsInput): Promise<Contact[]> {
  const rows = await db
    .select()
    .from(contact)
    .where(contactListWhere(input))
    .orderBy(desc(contact.updatedAt))
    .limit(CONTACT_EXPORT_LIMIT);
  return rows;
}

/** Cap on distinct keys returned — a picker doesn't need an unbounded list. */
const PROPERTY_KEY_LIMIT = 200;

/**
 * Distinct `properties` keys seen across a workspace's contacts, for
 * surfacing real merge-tag paths in the journey/email builder pickers
 * instead of a fixed suggestion list (properties are freeform jsonb, so
 * there's no static schema to read them from).
 */
export async function listContactPropertyKeys(db: Db, workspaceId: string): Promise<string[]> {
  const result = await db.execute<{ key: string }>(sql`
    select distinct jsonb_object_keys(${contact.properties}) as key
    from ${contact}
    where ${contact.workspaceId} = ${workspaceId}
    order by key
    limit ${PROPERTY_KEY_LIMIT}
  `);
  return result.rows.map((r) => r.key);
}

export type ContactBulkAction = "unsubscribe" | "resubscribe" | "delete";

/**
 * Bulk management op in one statement — atomic without an explicit
 * transaction. Workspace scoping in the WHERE clause means ids from
 * another workspace are silently not-affecting rather than leaking.
 * Deleting a contact cascades to its events via the FK.
 */
export async function bulkUpdateContacts(
  db: Db,
  input: { workspaceId: string; ids: string[]; action: ContactBulkAction },
): Promise<{ affected: number }> {
  if (input.ids.length === 0) return { affected: 0 };
  const where = and(eq(contact.workspaceId, input.workspaceId), inArray(contact.id, input.ids));

  switch (input.action) {
    case "unsubscribe": {
      const rows = await db
        .update(contact)
        .set({ subscribed: false, unsubscribedAt: new Date() })
        .where(where)
        .returning({ id: contact.id });
      return { affected: rows.length };
    }
    case "resubscribe": {
      const rows = await db
        .update(contact)
        .set({ subscribed: true, unsubscribedAt: null })
        .where(where)
        .returning({ id: contact.id });
      return { affected: rows.length };
    }
    case "delete": {
      const rows = await db.delete(contact).where(where).returning({ id: contact.id });
      return { affected: rows.length };
    }
  }
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
