import type { Db } from "@loopkit/db";
import { wfInstance } from "@loopkit/db/schema";
import { and, desc, eq, gte, lte, asc, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type {
  InstanceQueryParams,
  InstanceSortField,
  InstanceSortOrder,
  WorkflowInstance,
} from "ts-workflow-engine-lite";

import { normalizeInstanceDates, reviveInstanceDates } from "./serde";

export async function save(db: Db, instance: WorkflowInstance): Promise<void> {
  const normalized = normalizeInstanceDates(instance);
  const version = normalized.version ?? 1;
  const row = {
    instanceId: normalized.instanceId,
    workflowId: normalized.workflowId,
    status: normalized.status,
    parentInstanceId: normalized.parentInstanceId ?? null,
    version,
    createdAt: normalized.createdAt as Date,
    updatedAt: normalized.updatedAt as Date,
    data: { ...normalized, version },
  };

  await db
    .insert(wfInstance)
    .values(row)
    .onConflictDoUpdate({
      target: wfInstance.instanceId,
      set: {
        workflowId: row.workflowId,
        status: row.status,
        parentInstanceId: row.parentInstanceId,
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        data: row.data,
      },
    });
}

/**
 * Compare-and-swap: the caller passes the version it expects is currently
 * stored, and this function increments it on success. This mirrors
 * MemoryStorage.casUpdateInstance exactly — `instance.version` here is the
 * *expected current* version, not the version to write.
 *
 * The version must be written in two places that stay in sync: the `version`
 * column (what the WHERE clause CASes on next time) and inside `data`
 * (what loadInstance()/queryInstances() hand back to the engine, which
 * reads instance.version out of the object). Diverge them and every CAS
 * after the first one fails.
 */
export async function cas(db: Db, instance: WorkflowInstance): Promise<boolean> {
  const normalized = normalizeInstanceDates(instance);
  const expected = normalized.version ?? 1;
  const nextVersion = expected + 1;

  const result = await db
    .update(wfInstance)
    .set({
      workflowId: normalized.workflowId,
      status: normalized.status,
      parentInstanceId: normalized.parentInstanceId ?? null,
      version: nextVersion,
      createdAt: normalized.createdAt as Date,
      updatedAt: normalized.updatedAt as Date,
      data: { ...normalized, version: nextVersion },
    })
    .where(and(eq(wfInstance.instanceId, instance.instanceId), eq(wfInstance.version, expected)));

  return (result.rowCount ?? 0) > 0;
}

export async function load(db: Db, instanceId: string): Promise<WorkflowInstance | null> {
  const [row] = await db
    .select()
    .from(wfInstance)
    .where(eq(wfInstance.instanceId, instanceId))
    .limit(1);
  if (!row) return null;
  return reviveInstanceDates(row.data);
}

export async function remove(db: Db, instanceId: string): Promise<void> {
  await db.delete(wfInstance).where(eq(wfInstance.instanceId, instanceId));
}

export async function list(db: Db): Promise<string[]> {
  const rows = await db.select({ instanceId: wfInstance.instanceId }).from(wfInstance);
  return rows.map((r) => r.instanceId);
}

const SORT_COLUMNS: Record<InstanceSortField, AnyPgColumn> = {
  createdAt: wfInstance.createdAt,
  updatedAt: wfInstance.updatedAt,
  status: wfInstance.status,
};

export async function query(
  db: Db,
  params: InstanceQueryParams,
): Promise<{ instances: WorkflowInstance[]; total: number }> {
  const conditions = [];
  if (params.workflowId) conditions.push(eq(wfInstance.workflowId, params.workflowId));
  if (params.status) conditions.push(eq(wfInstance.status, params.status));
  if (params.parentInstanceId)
    conditions.push(eq(wfInstance.parentInstanceId, params.parentInstanceId));
  if (params.startTime) conditions.push(gte(wfInstance.createdAt, new Date(params.startTime)));
  if (params.endTime) conditions.push(lte(wfInstance.createdAt, new Date(params.endTime)));
  const where: SQL | undefined = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(wfInstance)
    .where(where);
  const total = countRow?.count ?? 0;

  const sortBy: InstanceSortField = params.sortBy ?? "createdAt";
  const sortOrder: InstanceSortOrder = params.sortOrder ?? "desc";
  const sortColumn = SORT_COLUMNS[sortBy];
  const direction = sortOrder === "asc" ? asc : desc;

  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  // Sort BEFORE pagination (LIMIT/OFFSET on an ORDER BY query does this
  // correctly at the SQL level) with instanceId as a tie-breaker so paging
  // is stable/reproducible across pages when the sort key has duplicates —
  // matching MemoryStorage.sortInstances's decorate-sort-undecorate
  // tie-break behavior.
  const rows = await db
    .select()
    .from(wfInstance)
    .where(where)
    .orderBy(direction(sortColumn), asc(wfInstance.instanceId))
    .limit(pageSize)
    .offset(offset);

  return {
    instances: rows.map((r) => reviveInstanceDates(r.data)),
    total,
  };
}
