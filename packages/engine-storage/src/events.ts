import type { Db } from "@loopkit/db";
import { wfEvent } from "@loopkit/db/schema";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { EventQueryParams, EventRecord } from "ts-workflow-engine-lite";

export async function save(db: Db, event: EventRecord): Promise<void> {
  await db
    .insert(wfEvent)
    .values({
      id: event.id,
      instanceId: event.instanceId,
      workflowId: event.workflowId,
      eventType: event.eventType,
      timestamp: event.timestamp,
      payload: event.payload ?? null,
      metadata: event.metadata ?? null,
    })
    .onConflictDoUpdate({
      target: wfEvent.id,
      set: {
        instanceId: event.instanceId,
        workflowId: event.workflowId,
        eventType: event.eventType,
        timestamp: event.timestamp,
        payload: event.payload ?? null,
        metadata: event.metadata ?? null,
      },
    });
}

function toRecord(row: typeof wfEvent.$inferSelect): EventRecord {
  return {
    id: row.id,
    instanceId: row.instanceId,
    workflowId: row.workflowId,
    eventType: row.eventType,
    payload: row.payload,
    timestamp: row.timestamp,
    metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
  };
}

export async function load(db: Db, eventId: string): Promise<EventRecord | null> {
  const [row] = await db.select().from(wfEvent).where(eq(wfEvent.id, eventId)).limit(1);
  return row ? toRecord(row) : null;
}

export async function query(
  db: Db,
  params: EventQueryParams,
): Promise<{ events: EventRecord[]; total: number }> {
  const conditions = [];
  if (params.instanceId) conditions.push(eq(wfEvent.instanceId, params.instanceId));
  if (params.eventType) conditions.push(eq(wfEvent.eventType, params.eventType));
  if (params.startTime) conditions.push(gte(wfEvent.timestamp, params.startTime));
  if (params.endTime) conditions.push(lte(wfEvent.timestamp, params.endTime));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(wfEvent)
    .where(where);
  const total = countRow?.count ?? 0;

  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const rows = await db
    .select()
    .from(wfEvent)
    .where(where)
    .orderBy(asc(wfEvent.timestamp), asc(wfEvent.id))
    .limit(pageSize)
    .offset(offset);

  return { events: rows.map(toRecord), total };
}

export async function remove(db: Db, eventId: string): Promise<void> {
  await db.delete(wfEvent).where(eq(wfEvent.id, eventId));
}
