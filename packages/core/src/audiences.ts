import type { Db } from "@loopkit/db";
import { audience, contact } from "@loopkit/db/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Contact } from "./contacts";
import {
  compileAudienceWhere,
  describeSegmentFilter,
  validateSegmentFilter,
  type SegmentFilter,
} from "./segments";

/**
 * Audience CRUD + membership resolution, all routed through segments.ts so
 * that "how many people are in this segment" (a count) and "who exactly gets
 * this campaign" (a resolution) can never disagree — they are the same
 * compiled WHERE clause, evaluated twice.
 *
 * `sendable` vs `total` is a deliberate pair rather than one number. The gap
 * between them is unsubscribed + suppressed contacts, and an operator
 * sending a campaign needs to see the gap before they send, not discover it
 * in the delivery report.
 */

export interface Audience {
  id: string;
  workspaceId: string;
  name: string;
  filter: SegmentFilter;
  createdAt: Date;
  updatedAt: Date;
}

export interface AudienceWithCounts extends Audience {
  /** Everyone matching the filter. */
  memberCount: number;
  /** Matching AND mailable (subscribed, not suppressed). */
  sendableCount: number;
  /** One-line human summary of the filter, for list cards. */
  summary: string;
}

export class AudienceValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`invalid segment filter: ${errors.join("; ")}`);
    this.errors = errors;
  }
}

/** Shared assertion so an invalid AST can never reach the `audience` column. */
function assertValidFilter(filter: unknown): SegmentFilter {
  const result = validateSegmentFilter(filter);
  if (!result.ok) throw new AudienceValidationError(result.errors);
  return filter as SegmentFilter;
}

async function countWhere(db: Db, where: ReturnType<typeof compileAudienceWhere>): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contact)
    .where(where);
  return row?.count ?? 0;
}

export async function createAudience(
  db: Db,
  input: { workspaceId: string; name: string; filter: unknown },
): Promise<{ audience: Audience; memberCount: number; sendableCount: number }> {
  const filter = assertValidFilter(input.filter);

  const [row] = await db
    .insert(audience)
    .values({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      filter,
    })
    .returning();

  const created = row! as Audience;
  const [memberCount, sendableCount] = await Promise.all([
    countWhere(db, compileAudienceWhere(input.workspaceId, filter)),
    countWhere(db, compileAudienceWhere(input.workspaceId, filter, { excludeUnsendable: true })),
  ]);

  return { audience: created, memberCount, sendableCount };
}

export async function getAudience(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<Audience | null> {
  const [row] = await db
    .select()
    .from(audience)
    .where(and(eq(audience.workspaceId, workspaceId), eq(audience.id, id)))
    .limit(1);
  return (row as Audience | undefined) ?? null;
}

/**
 * Audience list with live counts.
 *
 * Counts are two extra queries per audience rather than one clever join.
 * That is a deliberate trade: segment membership is defined by the filter
 * AST and its correlated EXISTS subqueries, and folding N of those into a
 * single statement is how you end up reimplementing segments.ts in SQL
 * aggregates. At the scale a self-hosted workspace actually has (tens of
 * segments, viewed on a page a human opens), N+1 over two indexed counts is
 * cheaper to read and impossible to get subtly wrong.
 */
export async function listAudiences(db: Db, workspaceId: string): Promise<AudienceWithCounts[]> {
  const rows = await db
    .select()
    .from(audience)
    .where(eq(audience.workspaceId, workspaceId))
    .orderBy(desc(audience.updatedAt));

  return Promise.all(
    rows.map(async (row) => {
      const typed = row as Audience;
      const [memberCount, sendableCount] = await Promise.all([
        countWhere(db, compileAudienceWhere(workspaceId, typed.filter)),
        countWhere(
          db,
          compileAudienceWhere(workspaceId, typed.filter, { excludeUnsendable: true }),
        ),
      ]);
      return {
        ...typed,
        memberCount,
        sendableCount,
        summary: describeSegmentFilter(typed.filter),
      };
    }),
  );
}

export async function updateAudience(
  db: Db,
  workspaceId: string,
  id: string,
  patch: { name?: string; filter?: unknown },
): Promise<AudienceWithCounts | null> {
  const values: { name?: string; filter?: SegmentFilter; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.filter !== undefined) values.filter = assertValidFilter(patch.filter);

  const rows = await db
    .update(audience)
    .set(values)
    .where(and(eq(audience.workspaceId, workspaceId), eq(audience.id, id)))
    .returning();

  const row = rows[0] as Audience | undefined;
  if (!row) return null;

  const [memberCount, sendableCount] = await Promise.all([
    countWhere(db, compileAudienceWhere(workspaceId, row.filter)),
    countWhere(db, compileAudienceWhere(workspaceId, row.filter, { excludeUnsendable: true })),
  ]);
  return { ...row, memberCount, sendableCount, summary: describeSegmentFilter(row.filter) };
}

export async function deleteAudience(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(audience)
    .where(and(eq(audience.workspaceId, workspaceId), eq(audience.id, id)))
    .returning({ id: audience.id });
  return rows.length > 0;
}

/**
 * Live estimate for the builder's "N contacts match" readout — takes the
 * *unsaved* filter from the client, which is why it's a separate function
 * from listAudiences' per-row counts.
 */
export async function countAudienceMembers(
  db: Db,
  input: { workspaceId: string; filter: unknown },
): Promise<{ memberCount: number; sendableCount: number }> {
  const filter = assertValidFilter(input.filter);
  const [memberCount, sendableCount] = await Promise.all([
    countWhere(db, compileAudienceWhere(input.workspaceId, filter)),
    countWhere(db, compileAudienceWhere(input.workspaceId, filter, { excludeUnsendable: true })),
  ]);
  return { memberCount, sendableCount };
}

export const AUDIENCE_RESOLVE_LIMIT = 50_000;

/**
 * Resolves an audience to contact rows — the campaign fan-out's input.
 *
 * Ordered by `id` (stable) rather than createdAt so that paging through a
 * 10k-recipient audience while contacts are being created can't skip or
 * repeat rows. Mailable-only by default: this is a *send* path, and the
 * suppression filter belongs here rather than only in the email channel —
 * a recipient we know we cannot send to should never be fanned out at all,
 * because that is what lets the campaign report say "suppressed: 42"
 * instead of silently doing nothing for 42 recipients.
 */
export async function resolveAudienceContacts(
  db: Db,
  input: {
    workspaceId: string;
    filter: unknown;
    limit?: number;
    offset?: number;
    includeUnsendable?: boolean;
  },
): Promise<{ contacts: Contact[]; total: number; truncated: boolean }> {
  const filter = assertValidFilter(input.filter);
  const limit = Math.min(
    AUDIENCE_RESOLVE_LIMIT,
    Math.max(1, input.limit ?? AUDIENCE_RESOLVE_LIMIT),
  );
  const offset = Math.max(0, input.offset ?? 0);
  const where = compileAudienceWhere(input.workspaceId, filter, {
    excludeUnsendable: !input.includeUnsendable,
  });

  const [rows, total] = await Promise.all([
    db.select().from(contact).where(where).orderBy(asc(contact.id)).limit(limit).offset(offset),
    countWhere(db, where),
  ]);

  return {
    contacts: rows as Contact[],
    total,
    truncated: offset + rows.length < total,
  };
}
