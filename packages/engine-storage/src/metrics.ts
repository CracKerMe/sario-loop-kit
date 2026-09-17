import type { Db } from "@loopkit/db";
import { wfNodeMetric } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import type { InstanceMetrics, NodeMetrics } from "ts-workflow-engine-lite";

/**
 * InstanceMetrics is stored as one row per (instanceId, nodeId), not one
 * blob per instance — updateNode() is called on every node transition, and
 * a single-blob design would make that a concurrent read-modify-write.
 * loadInstanceMetrics() reassembles the InstanceMetrics shape by
 * aggregating rows for that instance.
 */
export async function save(db: Db, metrics: InstanceMetrics): Promise<void> {
  const rows = Object.entries(metrics.nodeMetrics).map(([nodeId, nodeMetrics]) => ({
    instanceId: metrics.instanceId,
    nodeId,
    workflowId: metrics.workflowId,
    nodeType: nodeMetrics.nodeType ?? null,
    status: nodeMetrics.status ?? null,
    startTime: nodeMetrics.startTime ?? null,
    endTime: nodeMetrics.endTime ?? null,
    duration: nodeMetrics.duration ?? null,
    retryCount: nodeMetrics.retryCount,
    data: nodeMetrics,
  }));
  if (rows.length === 0) return;

  for (const row of rows) {
    await db
      .insert(wfNodeMetric)
      .values(row)
      .onConflictDoUpdate({
        target: [wfNodeMetric.instanceId, wfNodeMetric.nodeId],
        set: {
          workflowId: row.workflowId,
          nodeType: row.nodeType,
          status: row.status,
          startTime: row.startTime,
          endTime: row.endTime,
          duration: row.duration,
          retryCount: row.retryCount,
          data: row.data,
          updatedAt: new Date(),
        },
      });
  }
}

export async function load(db: Db, instanceId: string): Promise<InstanceMetrics | null> {
  const rows = await db.select().from(wfNodeMetric).where(eq(wfNodeMetric.instanceId, instanceId));
  if (rows.length === 0) return null;

  const nodeMetrics: Record<string, NodeMetrics> = {};
  let createdAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;
  let workflowId = "";
  for (const row of rows) {
    nodeMetrics[row.nodeId] = row.data as NodeMetrics;
    workflowId = row.workflowId;
    const ts = row.updatedAt.getTime();
    if (ts > updatedAt) updatedAt = ts;
    if (ts < createdAt) createdAt = ts;
  }

  return { instanceId, workflowId, nodeMetrics, createdAt, updatedAt };
}

export async function remove(db: Db, instanceId: string): Promise<void> {
  await db.delete(wfNodeMetric).where(eq(wfNodeMetric.instanceId, instanceId));
}

/**
 * updateNodeMetrics() on the StorageProvider interface does not receive a
 * workflowId — MemoryStorage derives it from the already-stored
 * InstanceMetrics record or, failing that, from the live instance.
 * DrizzleStorageProvider.updateNodeMetrics does the equivalent lookup (a
 * read of wf_instance.workflow_id) before calling this, so the
 * (workflowId, nodeId, status) funnel index on wf_node_metric stays
 * populated instead of empty on first write.
 */
export async function updateNode(
  db: Db,
  instanceId: string,
  nodeId: string,
  metrics: NodeMetrics,
  workflowId: string,
): Promise<void> {
  await db
    .insert(wfNodeMetric)
    .values({
      instanceId,
      nodeId,
      workflowId,
      nodeType: metrics.nodeType ?? null,
      status: metrics.status ?? null,
      startTime: metrics.startTime ?? null,
      endTime: metrics.endTime ?? null,
      duration: metrics.duration ?? null,
      retryCount: metrics.retryCount,
      data: metrics,
    })
    .onConflictDoUpdate({
      target: [wfNodeMetric.instanceId, wfNodeMetric.nodeId],
      set: {
        workflowId,
        nodeType: metrics.nodeType ?? null,
        status: metrics.status ?? null,
        startTime: metrics.startTime ?? null,
        endTime: metrics.endTime ?? null,
        duration: metrics.duration ?? null,
        retryCount: metrics.retryCount,
        data: metrics,
        updatedAt: new Date(),
      },
    });
}
