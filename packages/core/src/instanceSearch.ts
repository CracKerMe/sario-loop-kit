import type { Db } from "@loopkit/db";
import { contact, journey, journeyRun, wfEventWait, wfInstance } from "@loopkit/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

/**
 * Instance search — the dashboard's answer to "where is this contact stuck?"
 * and "who is waiting for this event?".
 *
 * The engine's own queryInstances() can only filter on columns it knows
 * about (workflowId/status/parentInstanceId) and has no workspace concept.
 * The join key it misses lives in OUR schema: journey_run.instance_id is
 * the engine instanceId, and journey_run carries workspaceId + contactId.
 * So this search is driven from journey_run and enriched from the engine
 * tables:
 *
 *  - wf_instance.data  → currentNodes (the authoritative "stuck at"),
 *    engine status. One jsonb read per matched row, bounded by limit.
 *  - wf_event_wait     → what a running instance is waiting for (node +
 *    event type). Rows are deleted as soon as a wait resolves, so a row
 *    here means "waiting right now".
 */
export interface InstanceSearchQuery {
  /** Exact journey_run.contactId. */
  contactId?: string;
  /** Exact contact email (case-insensitive). Resolved to contact ids first. */
  email?: string;
  journeyId?: string;
  /** journey_run.status — pending/running/completed/failed/cancelled/exited. */
  status?: (typeof journeyRun.$inferSelect)["status"];
  /** Only runs whose instance currently waits on this event type. */
  waitingEvent?: string;
  /** Default 50, capped at 200. */
  limit?: number;
}

export interface InstanceSearchRow {
  run: {
    id: string;
    instanceId: string;
    status: string;
    journeyVersion: number;
    enteredAt: Date;
    exitedAt: Date | null;
    exitReason: string | null;
  };
  journey: { id: string; name: string };
  contact: { id: string; email: string | null };
  /** Engine's authoritative in-flight nodes; null when the engine blob is gone. */
  currentNodes: string[] | null;
  engineStatus: string | null;
  /** Present only while a wait is pending — "stuck on X waiting for Y". */
  waitingFor: { nodeId: string; eventType: string }[];
}

export async function searchInstances(
  db: Db,
  workspaceId: string,
  query: InstanceSearchQuery,
): Promise<InstanceSearchRow[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);

  const conditions = [eq(journeyRun.workspaceId, workspaceId)];
  if (query.contactId) conditions.push(eq(journeyRun.contactId, query.contactId));
  if (query.journeyId) conditions.push(eq(journeyRun.journeyId, query.journeyId));
  if (query.status) conditions.push(eq(journeyRun.status, query.status));

  if (query.email) {
    const emailRows = await db
      .select({ id: contact.id })
      .from(contact)
      .where(
        and(
          eq(contact.workspaceId, workspaceId),
          sql`lower(${contact.email}) = lower(${query.email})`,
        ),
      );
    const ids = emailRows.map((r) => r.id);
    if (ids.length === 0) return [];
    conditions.push(inArray(journeyRun.contactId, ids));
  }

  // waitingEvent narrows the run set before enrichment: it is the one
  // filter that originates from an engine-only table.
  if (query.waitingEvent) {
    const waitRows = await db
      .select({ instanceId: wfEventWait.instanceId })
      .from(wfEventWait)
      .where(eq(wfEventWait.eventType, query.waitingEvent));
    const ids = waitRows.map((r) => r.instanceId);
    if (ids.length === 0) return [];
    conditions.push(inArray(journeyRun.instanceId, ids));
  }

  const rows = await db
    .select({
      id: journeyRun.id,
      instanceId: journeyRun.instanceId,
      status: journeyRun.status,
      journeyVersion: journeyRun.journeyVersion,
      enteredAt: journeyRun.enteredAt,
      exitedAt: journeyRun.exitedAt,
      exitReason: journeyRun.exitReason,
      journeyId: journey.id,
      journeyName: journey.name,
      contactId: journeyRun.contactId,
      contactEmail: contact.email,
    })
    .from(journeyRun)
    .innerJoin(journey, eq(journey.id, journeyRun.journeyId))
    .leftJoin(contact, eq(contact.id, journeyRun.contactId))
    .where(and(...conditions))
    .orderBy(desc(journeyRun.enteredAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const instanceIds = rows.map((r) => r.instanceId);

  const [waitRows, engineRows] = await Promise.all([
    db
      .select({
        instanceId: wfEventWait.instanceId,
        nodeId: wfEventWait.nodeId,
        eventType: wfEventWait.eventType,
      })
      .from(wfEventWait)
      .where(inArray(wfEventWait.instanceId, instanceIds)),
    db
      .select({
        instanceId: wfInstance.instanceId,
        status: wfInstance.status,
        data: wfInstance.data,
      })
      .from(wfInstance)
      .where(inArray(wfInstance.instanceId, instanceIds)),
  ]);

  const waitsByInstance = new Map<string, { nodeId: string; eventType: string }[]>();
  for (const w of waitRows) {
    const list = waitsByInstance.get(w.instanceId) ?? [];
    list.push({ nodeId: w.nodeId, eventType: w.eventType });
    waitsByInstance.set(w.instanceId, list);
  }
  const engineByInstance = new Map(engineRows.map((e) => [e.instanceId, e]));

  return rows.map((r) => {
    const engine = engineByInstance.get(r.instanceId);
    const engineData = engine?.data as { currentNodes?: unknown } | null | undefined;
    const currentNodes = Array.isArray(engineData?.currentNodes)
      ? (engineData.currentNodes as unknown[]).filter((n): n is string => typeof n === "string")
      : null;
    return {
      run: {
        id: r.id,
        instanceId: r.instanceId,
        status: r.status,
        journeyVersion: r.journeyVersion,
        enteredAt: r.enteredAt,
        exitedAt: r.exitedAt,
        exitReason: r.exitReason,
      },
      journey: { id: r.journeyId, name: r.journeyName },
      // journey_run.contactId is NOT NULL + FK — the leftJoin's nullable
      // contact row is only for the email column.
      contact: { id: r.contactId, email: r.contactEmail },
      currentNodes: currentNodes && currentNodes.length > 0 ? currentNodes : null,
      engineStatus: engine?.status ?? null,
      waitingFor: waitsByInstance.get(r.instanceId) ?? [],
    };
  });
}
