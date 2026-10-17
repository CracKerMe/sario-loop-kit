import { and, desc, eq } from "drizzle-orm";

import type { Db } from "@loopkit/db";
import {
  company as companyTable,
  contact as contactTable,
  revenueEvent as revenueEventTable,
  task as taskTable,
} from "@loopkit/db/schema";

import { companyNameFromDomain, domainFromEmail } from "@loopkit/db/schema";

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export type TaskKind = "call" | "email" | "meeting" | "review" | "custom";
export type TaskStatus = "open" | "done" | "dismissed";

export type CreateTaskInput = {
  contactId: string;
  title: string;
  body?: string | null;
  kind?: TaskKind;
  priority?: number;
  dueAt?: Date | string | null;
  source?: string;
  sourceId?: string | null;
};

export type TaskRow = typeof taskTable.$inferSelect;

export async function createTask(db: Db, workspaceId: string, input: CreateTaskInput) {
  // Dedup: one open task per (workspace, contact, source, sourceId).
  if (input.source && input.sourceId) {
    const [existing] = await db
      .select()
      .from(taskTable)
      .where(
        and(
          eq(taskTable.workspaceId, workspaceId),
          eq(taskTable.contactId, input.contactId),
          eq(taskTable.source, input.source),
          eq(taskTable.sourceId, input.sourceId),
          eq(taskTable.status, "open"),
        ),
      )
      .limit(1);
    if (existing) return existing;
  }

  const [row] = await db
    .insert(taskTable)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      contactId: input.contactId,
      title: input.title,
      body: input.body ?? null,
      kind: input.kind ?? "review",
      status: "open",
      priority: input.priority ?? 0,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      source: input.source ?? "manual",
      sourceId: input.sourceId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function listTasks(
  db: Db,
  workspaceId: string,
  opts: { status?: TaskStatus; contactId?: string; limit?: number } = {},
) {
  const filters = [eq(taskTable.workspaceId, workspaceId)];
  if (opts.status) filters.push(eq(taskTable.status, opts.status));
  if (opts.contactId) filters.push(eq(taskTable.contactId, opts.contactId));

  return db
    .select({
      id: taskTable.id,
      contactId: taskTable.contactId,
      email: contactTable.email,
      title: taskTable.title,
      body: taskTable.body,
      kind: taskTable.kind,
      status: taskTable.status,
      priority: taskTable.priority,
      dueAt: taskTable.dueAt,
      source: taskTable.source,
      sourceId: taskTable.sourceId,
      completedAt: taskTable.completedAt,
      createdAt: taskTable.createdAt,
    })
    .from(taskTable)
    .innerJoin(contactTable, eq(contactTable.id, taskTable.contactId))
    .where(and(...filters))
    .orderBy(desc(taskTable.priority), desc(taskTable.createdAt))
    .limit(opts.limit ?? 100);
}

export async function completeTask(
  db: Db,
  workspaceId: string,
  taskId: string,
  status: "done" | "dismissed",
) {
  const [row] = await db
    .update(taskTable)
    .set({
      status,
      completedAt: new Date(),
    })
    .where(and(eq(taskTable.workspaceId, workspaceId), eq(taskTable.id, taskId)))
    .returning();
  return row ?? null;
}

export async function taskStats(db: Db, workspaceId: string) {
  const rows = await db
    .select({ status: taskTable.status })
    .from(taskTable)
    .where(eq(taskTable.workspaceId, workspaceId));
  const out = { open: 0, done: 0, dismissed: 0, total: rows.length };
  for (const row of rows) {
    if (row.status === "open") out.open += 1;
    else if (row.status === "done") out.done += 1;
    else out.dismissed += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Companies                                                           */
/* ------------------------------------------------------------------ */

export type CompanyRow = typeof companyTable.$inferSelect;

/**
 * Ensures a company row exists for the contact's email domain and links the
 * contact via `properties.companyId`. No-op for free-mail addresses.
 */
export async function syncContactCompany(
  db: Db,
  workspaceId: string,
  contactId: string,
  email: string,
  explicitName?: string,
): Promise<CompanyRow | null> {
  const domain = domainFromEmail(email);
  if (!domain) return null;

  let [company] = await db
    .select()
    .from(companyTable)
    .where(and(eq(companyTable.workspaceId, workspaceId), eq(companyTable.domain, domain)))
    .limit(1);

  if (!company) {
    const [created] = await db
      .insert(companyTable)
      .values({
        id: crypto.randomUUID(),
        workspaceId,
        domain,
        name: explicitName || companyNameFromDomain(domain),
      })
      .onConflictDoNothing()
      .returning();
    company = created;
    if (!company) {
      const [again] = await db
        .select()
        .from(companyTable)
        .where(and(eq(companyTable.workspaceId, workspaceId), eq(companyTable.domain, domain)))
        .limit(1);
      company = again;
    }
  }

  if (!company) return null;

  const [contact] = await db
    .select({ properties: contactTable.properties })
    .from(contactTable)
    .where(eq(contactTable.id, contactId))
    .limit(1);
  if (contact && contact.properties?.companyId !== company.id) {
    await db
      .update(contactTable)
      .set({
        properties: {
          ...contact.properties,
          companyId: company.id,
          companyDomain: company.domain,
          companyName: company.name,
        },
      })
      .where(eq(contactTable.id, contactId));
  }

  return company;
}

/** Recomputes cached rollups for one company from its contacts + revenue. */
export async function recomputeCompanyRollups(
  db: Db,
  workspaceId: string,
  companyId: string,
): Promise<CompanyRow | null> {
  const [company] = await db
    .select()
    .from(companyTable)
    .where(and(eq(companyTable.workspaceId, workspaceId), eq(companyTable.id, companyId)))
    .limit(1);
  if (!company) return null;

  const contacts = await db
    .select({
      id: contactTable.id,
      email: contactTable.email,
      properties: contactTable.properties,
      updatedAt: contactTable.updatedAt,
    })
    .from(contactTable)
    .where(eq(contactTable.workspaceId, workspaceId));

  const linked = contacts.filter(
    (c) =>
      c.properties?.companyId === companyId ||
      c.properties?.companyDomain === company.domain ||
      domainFromEmail(c.email) === company.domain,
  );

  let hot = 0;
  let scoreSum = 0;
  let lastActivity: Date | null = null;
  for (const c of linked) {
    const score = typeof c.properties?.leadScore === "number" ? c.properties.leadScore : 0;
    scoreSum += score;
    if (c.properties?.leadTier === "hot" || score >= 50) hot += 1;
    if (!lastActivity || c.updatedAt > lastActivity) lastActivity = c.updatedAt;
  }

  const revenueRows = await db
    .select({ amountCents: revenueEventTable.amountCents, contactId: revenueEventTable.contactId })
    .from(revenueEventTable)
    .where(eq(revenueEventTable.workspaceId, workspaceId));
  const linkedIds = new Set(linked.map((c) => c.id));
  const ltvCents = revenueRows
    .filter((r) => linkedIds.has(r.contactId))
    .reduce((sum, r) => sum + r.amountCents, 0);

  const [updated] = await db
    .update(companyTable)
    .set({
      contactCount: linked.length,
      hotLeadCount: hot,
      totalLeadScore: scoreSum,
      totalLtvCents: ltvCents,
      lastActivityAt: lastActivity,
    })
    .where(and(eq(companyTable.workspaceId, workspaceId), eq(companyTable.id, companyId)))
    .returning();
  return updated ?? null;
}

export async function listCompanies(db: Db, workspaceId: string, limit = 100) {
  return db
    .select()
    .from(companyTable)
    .where(eq(companyTable.workspaceId, workspaceId))
    .orderBy(desc(companyTable.lastActivityAt), desc(companyTable.hotLeadCount))
    .limit(limit);
}

export async function getCompany(db: Db, workspaceId: string, companyId: string) {
  const [row] = await db
    .select()
    .from(companyTable)
    .where(and(eq(companyTable.workspaceId, workspaceId), eq(companyTable.id, companyId)))
    .limit(1);
  return row ?? null;
}

export async function listCompanyContacts(db: Db, workspaceId: string, companyId: string) {
  const [company] = await db
    .select()
    .from(companyTable)
    .where(and(eq(companyTable.workspaceId, workspaceId), eq(companyTable.id, companyId)))
    .limit(1);
  if (!company) return [];

  const rows = await db
    .select({
      id: contactTable.id,
      email: contactTable.email,
      properties: contactTable.properties,
      subscribed: contactTable.subscribed,
      createdAt: contactTable.createdAt,
    })
    .from(contactTable)
    .where(eq(contactTable.workspaceId, workspaceId));

  return rows.filter(
    (c) =>
      c.properties?.companyId === company.id ||
      c.properties?.companyDomain === company.domain ||
      domainFromEmail(c.email) === company.domain,
  );
}

/** Open-task helper used by Contact 360 and task queue. */
export async function openTasksForContact(db: Db, workspaceId: string, contactId: string) {
  return db
    .select()
    .from(taskTable)
    .where(
      and(
        eq(taskTable.workspaceId, workspaceId),
        eq(taskTable.contactId, contactId),
        eq(taskTable.status, "open"),
      ),
    )
    .orderBy(desc(taskTable.priority), desc(taskTable.createdAt));
}

export { domainFromEmail, companyNameFromDomain };
