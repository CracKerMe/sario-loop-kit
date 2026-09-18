import type { Db } from "@loopkit/db";
import {
  contact,
  emailSend,
  journey,
  journeyRun,
  journeyVersion,
  wfDlq,
  wfNodeMetric,
} from "@loopkit/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

import type { JourneyGraph } from "@loopkit/journey";

export interface JourneyDetail {
  journey: typeof journey.$inferSelect;
  graph: JourneyGraph | null;
  version: number | null;
  runCounts: Record<string, number>;
}

export async function getJourneyDetail(
  db: Db,
  workspaceId: string,
  journeyId: string,
): Promise<JourneyDetail | null> {
  const [j] = await db.select().from(journey).where(eq(journey.id, journeyId)).limit(1);
  if (!j || j.workspaceId !== workspaceId) return null;

  const [latest] = await db
    .select()
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);

  const runs = await db
    .select({
      status: journeyRun.status,
      count: sql<number>`count(*)::int`,
    })
    .from(journeyRun)
    .where(eq(journeyRun.journeyId, journeyId))
    .groupBy(journeyRun.status);

  const runCounts: Record<string, number> = {};
  for (const row of runs) runCounts[row.status] = Number(row.count);

  return {
    journey: j,
    graph: (latest?.graph as JourneyGraph | undefined) ?? null,
    version: latest?.version ?? null,
    runCounts,
  };
}

export async function listJourneyRuns(db: Db, workspaceId: string, journeyId: string, limit = 100) {
  return db
    .select({
      id: journeyRun.id,
      instanceId: journeyRun.instanceId,
      contactId: journeyRun.contactId,
      status: journeyRun.status,
      journeyVersion: journeyRun.journeyVersion,
      enteredAt: journeyRun.enteredAt,
      exitedAt: journeyRun.exitedAt,
      exitReason: journeyRun.exitReason,
      email: contact.email,
    })
    .from(journeyRun)
    .leftJoin(contact, eq(contact.id, journeyRun.contactId))
    .where(and(eq(journeyRun.journeyId, journeyId), eq(journeyRun.workspaceId, workspaceId)))
    .orderBy(desc(journeyRun.enteredAt))
    .limit(limit);
}

export async function getDashboardStats(db: Db, workspaceId: string) {
  const [contactRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contact)
    .where(eq(contact.workspaceId, workspaceId));

  const journeyRows = await db
    .select({
      status: journey.status,
      count: sql<number>`count(*)::int`,
    })
    .from(journey)
    .where(eq(journey.workspaceId, workspaceId))
    .groupBy(journey.status);

  const statusRuns = await db
    .select({
      status: journeyRun.status,
      count: sql<number>`count(*)::int`,
    })
    .from(journeyRun)
    .where(eq(journeyRun.workspaceId, workspaceId))
    .groupBy(journeyRun.status);

  const [emailRow] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${emailSend.status} = 'sent')::int`,
      delivered: sql<number>`count(*) filter (where ${emailSend.status} = 'delivered')::int`,
      failed: sql<number>`count(*) filter (where ${emailSend.status} = 'failed')::int`,
    })
    .from(emailSend)
    .where(eq(emailSend.workspaceId, workspaceId));

  const journeysByStatus: Record<string, number> = {};
  for (const row of journeyRows) journeysByStatus[row.status] = Number(row.count);

  const runsByStatus: Record<string, number> = {};
  for (const row of statusRuns) runsByStatus[row.status] = Number(row.count);

  return {
    contacts: Number(contactRow?.count ?? 0),
    journeysByStatus,
    journeyRunsByStatus: runsByStatus,
    activeRuns: runsByStatus.running ?? 0,
    emails: {
      sent: Number(emailRow?.sent ?? 0),
      delivered: Number(emailRow?.delivered ?? 0),
      failed: Number(emailRow?.failed ?? 0),
    },
  };
}

export async function listDeadLetters(db: Db, limit = 50) {
  return db.select().from(wfDlq).orderBy(desc(wfDlq.createdAt)).limit(limit);
}

export async function listNodeFunnel(db: Db, workflowId: string) {
  return db
    .select({
      nodeId: wfNodeMetric.nodeId,
      nodeType: wfNodeMetric.nodeType,
      status: wfNodeMetric.status,
      count: sql<number>`count(*)::int`,
    })
    .from(wfNodeMetric)
    .where(eq(wfNodeMetric.workflowId, workflowId))
    .groupBy(wfNodeMetric.nodeId, wfNodeMetric.nodeType, wfNodeMetric.status);
}
