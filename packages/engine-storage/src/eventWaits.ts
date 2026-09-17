import type { Db } from "@loopkit/db";
import { wfEventWait } from "@loopkit/db/schema";
import { and, eq } from "drizzle-orm";
import type { EventWaitingState } from "ts-workflow-engine-lite";

export async function save(db: Db, state: EventWaitingState): Promise<void> {
  await db
    .insert(wfEventWait)
    .values({
      instanceId: state.instanceId,
      nodeId: state.nodeId,
      eventType: state.eventType,
      deadline: state.deadline ?? null,
      data: state,
    })
    .onConflictDoUpdate({
      target: [wfEventWait.instanceId, wfEventWait.nodeId],
      set: { eventType: state.eventType, deadline: state.deadline ?? null, data: state },
    });
}

export async function load(
  db: Db,
  instanceId: string,
  nodeId: string,
): Promise<EventWaitingState | null> {
  const [row] = await db
    .select()
    .from(wfEventWait)
    .where(and(eq(wfEventWait.instanceId, instanceId), eq(wfEventWait.nodeId, nodeId)))
    .limit(1);
  return row ? (row.data as EventWaitingState) : null;
}

export async function loadAll(db: Db): Promise<EventWaitingState[]> {
  const rows = await db.select().from(wfEventWait);
  return rows.map((r) => r.data as EventWaitingState);
}

export async function remove(db: Db, instanceId: string, nodeId: string): Promise<void> {
  await db
    .delete(wfEventWait)
    .where(and(eq(wfEventWait.instanceId, instanceId), eq(wfEventWait.nodeId, nodeId)));
}
