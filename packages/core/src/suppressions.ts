import type { Db } from "@loopkit/db";
import { suppression } from "@loopkit/db/schema";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

export type SuppressionReason = "hard_bounce" | "complaint" | "manual" | "unsubscribe";

export const SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  "hard_bounce",
  "complaint",
  "manual",
  "unsubscribe",
] as const;

export const SUPPRESSION_REASON_LABELS: Record<SuppressionReason, string> = {
  hard_bounce: "Hard bounce",
  complaint: "Spam complaint",
  manual: "Manual",
  unsubscribe: "Unsubscribed",
};

export interface Suppression {
  id: string;
  workspaceId: string;
  email: string;
  reason: SuppressionReason;
  source: string | null;
  contactId: string | null;
  providerMessageId: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface AddSuppressionInput {
  workspaceId: string;
  email: string;
  reason: SuppressionReason;
  source?: string;
  contactId?: string | null;
  providerMessageId?: string | null;
  note?: string;
  createdBy?: string;
}

/** Raw column names exactly as node-postgres returns them from RETURNING *. */
interface RawSuppressionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  email: string;
  reason: SuppressionReason;
  source: string | null;
  contact_id: string | null;
  provider_message_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Date;
}

function fromRawRow(row: RawSuppressionRow): Suppression {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    reason: row.reason,
    source: row.source,
    contactId: row.contact_id,
    providerMessageId: row.provider_message_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Records an address as unsendable. Idempotent: the workspace-level
 * `(workspace_id, lower(email))` unique index makes a repeat recording a
 * no-op rather than an error, which matters because the callers are
 * at-least-once sources — a provider webhook can be redelivered, and a
 * campaign can re-encounter an address it already suppressed.
 *
 * **First write wins.** An existing row is never overwritten. The first
 * reason is the most informative one (a `hard_bounce` should not be
 * rewritten to `manual` by a later bulk import, and an operator's `manual`
 * block should not be downgraded by an unrelated webhook replay). Upgrading
 * an entry is an explicit remove-then-add, which keeps the audit trail
 * honest.
 *
 * Uses raw SQL rather than Drizzle's onConflictDoNothing() for the same
 * reason as upsertContact: the unique index is on an *expression*
 * (lower(email)), and the query builder's typed `target` only accepts
 * IndexColumn references, so there is no query-builder path to an
 * ON CONFLICT clause that matches it. RETURNING * rows are mapped
 * explicitly (node-postgres sends snake_case, not the schema's camelCase).
 */
export async function addSuppression(
  db: Db,
  input: AddSuppressionInput,
): Promise<{ suppression: Suppression | null; created: boolean }> {
  const id = crypto.randomUUID();
  const result = await db.execute<RawSuppressionRow>(sql`
    INSERT INTO ${suppression}
      (id, workspace_id, email, reason, source, contact_id, provider_message_id, note, created_by)
    VALUES (
      ${id},
      ${input.workspaceId},
      ${input.email.trim().toLowerCase()},
      ${input.reason},
      ${input.source ?? null},
      ${input.contactId ?? null},
      ${input.providerMessageId ?? null},
      ${input.note ?? null},
      ${input.createdBy ?? null}
    )
    ON CONFLICT (workspace_id, lower(email)) DO NOTHING
    RETURNING *
  `);

  const row = result.rows[0];
  if (!row) return { suppression: null, created: false };
  return { suppression: fromRawRow(row), created: true };
}

/**
 * The send-path check. One indexed equality probe on
 * `(workspace_id, lower(email))` — deliberate, because this runs once per
 * email on the hot path.
 */
export async function isEmailSuppressed(
  db: Db,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  return (await getSuppression(db, workspaceId, email)) !== null;
}

/**
 * Same probe, returning the row. Callers that surface *why* an address is
 * blocked (the send path records the reason on `email_send.error`; the
 * compliance UI shows it) need the reason, not just the boolean — and
 * re-querying by email to recover it would double the per-send cost.
 */
export async function getSuppression(
  db: Db,
  workspaceId: string,
  email: string,
): Promise<Suppression | null> {
  const [row] = await db
    .select()
    .from(suppression)
    .where(
      and(
        eq(suppression.workspaceId, workspaceId),
        sql`lower(${suppression.email}) = ${email.trim().toLowerCase()}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Batch variant for audience/campaign resolution — one query, not N. */
export async function filterSuppressedEmails(
  db: Db,
  workspaceId: string,
  emails: string[],
): Promise<Set<string>> {
  const normalized = emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
  if (normalized.length === 0) return new Set();

  const found = new Set<string>();
  // Chunked so a 10k-recipient campaign doesn't build a 10k-element array
  // literal in one statement.
  for (let i = 0; i < normalized.length; i += 500) {
    const chunk = normalized.slice(i, i + 500);
    const rows = await db
      .select({ email: sql<string>`lower(${suppression.email})` })
      .from(suppression)
      .where(
        and(
          eq(suppression.workspaceId, workspaceId),
          inArray(sql`lower(${suppression.email})`, chunk),
        ),
      );
    for (const row of rows) found.add(row.email);
  }
  return found;
}

export async function removeSuppression(
  db: Db,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const rows = await db
    .delete(suppression)
    .where(
      and(
        eq(suppression.workspaceId, workspaceId),
        sql`lower(${suppression.email}) = ${email.trim().toLowerCase()}`,
      ),
    )
    .returning({ id: suppression.id });
  return rows.length > 0;
}

/**
 * By-id removal for the compliance UI, where a row is selected rather than
 * typed. Workspace scoping in the WHERE clause means an id from another
 * workspace deletes nothing instead of leaking or succeeding.
 */
export async function removeSuppressionById(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(suppression)
    .where(and(eq(suppression.workspaceId, workspaceId), eq(suppression.id, id)))
    .returning({ id: suppression.id });
  return rows.length > 0;
}

export interface ListSuppressionsInput {
  workspaceId: string;
  /** Case-insensitive substring match over the address. */
  query?: string;
  reason?: SuppressionReason;
  page?: number; // 1-based
  pageSize?: number;
}

function suppressionListWhere(input: ListSuppressionsInput) {
  const conditions = [eq(suppression.workspaceId, input.workspaceId)];
  const q = input.query?.trim();
  if (q) {
    const pattern = `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    conditions.push(or(ilike(suppression.email, pattern), ilike(suppression.note, pattern))!);
  }
  if (input.reason) conditions.push(eq(suppression.reason, input.reason));
  return and(...conditions)!;
}

export async function listSuppressions(
  db: Db,
  input: ListSuppressionsInput,
): Promise<{ suppressions: Suppression[]; total: number }> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, input.pageSize ?? 50));
  const where = suppressionListWhere(input);

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(suppression)
      .where(where)
      .orderBy(desc(suppression.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(suppression)
      .where(where),
  ]);

  return { suppressions: rows, total: countRow?.count ?? 0 };
}

/** Per-reason counts for the compliance panel; one grouped query. */
export async function countSuppressionsByReason(
  db: Db,
  workspaceId: string,
): Promise<Record<SuppressionReason, number>> {
  const rows = await db
    .select({ reason: suppression.reason, count: sql<number>`count(*)::int` })
    .from(suppression)
    .where(eq(suppression.workspaceId, workspaceId))
    .groupBy(suppression.reason);

  const base: Record<SuppressionReason, number> = {
    hard_bounce: 0,
    complaint: 0,
    manual: 0,
    unsubscribe: 0,
  };
  for (const row of rows) base[row.reason] = row.count;
  return base;
}
