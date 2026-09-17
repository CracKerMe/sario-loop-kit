import type { Db } from "@loopkit/db";
import { wfWorkflow, wfWorkflowMeta, wfWorkflowVersion } from "@loopkit/db/schema";
import { and, asc, eq } from "drizzle-orm";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
  WorkflowDefinition,
} from "ts-workflow-engine-lite";

// --- plain workflow definitions (StorageCore) -------------------------------

export async function save(db: Db, workflow: WorkflowDefinition): Promise<void> {
  await db
    .insert(wfWorkflow)
    .values({ workflowId: workflow.id, definition: workflow })
    .onConflictDoUpdate({
      target: wfWorkflow.workflowId,
      set: { definition: workflow, updatedAt: new Date() },
    });
}

export async function load(db: Db, workflowId: string): Promise<WorkflowDefinition | null> {
  const [row] = await db
    .select()
    .from(wfWorkflow)
    .where(eq(wfWorkflow.workflowId, workflowId))
    .limit(1);
  return row ? (row.definition as WorkflowDefinition) : null;
}

export async function remove(db: Db, workflowId: string): Promise<void> {
  await db.delete(wfWorkflow).where(eq(wfWorkflow.workflowId, workflowId));
}

export async function list(db: Db): Promise<string[]> {
  const rows = await db.select({ workflowId: wfWorkflow.workflowId }).from(wfWorkflow);
  return rows.map((r) => r.workflowId);
}

// --- workflow-with-metadata (WorkflowMetadataStorage) -----------------------

export async function saveWithMetadata(db: Db, workflow: StoredWorkflow): Promise<void> {
  await db
    .insert(wfWorkflowMeta)
    .values({
      workflowId: workflow.id,
      name: workflow.name,
      version: workflow.version,
      data: workflow,
      createdAt: new Date(workflow.createdAt),
      updatedAt: new Date(workflow.updatedAt),
    })
    .onConflictDoUpdate({
      target: wfWorkflowMeta.workflowId,
      set: {
        name: workflow.name,
        version: workflow.version,
        data: workflow,
        updatedAt: new Date(workflow.updatedAt),
      },
    });
}

export async function loadWithMetadata(db: Db, workflowId: string): Promise<StoredWorkflow | null> {
  const [row] = await db
    .select()
    .from(wfWorkflowMeta)
    .where(eq(wfWorkflowMeta.workflowId, workflowId))
    .limit(1);
  return row ? (row.data as StoredWorkflow) : null;
}

export async function listWithMetadata(db: Db): Promise<StoredWorkflow[]> {
  const rows = await db.select().from(wfWorkflowMeta);
  return rows.map((r) => r.data as StoredWorkflow);
}

// --- workflow versions -------------------------------------------------------

export async function saveVersion(db: Db, version: StoredWorkflowVersion): Promise<void> {
  await db
    .insert(wfWorkflowVersion)
    .values({
      workflowId: version.id,
      version: version.version,
      data: version,
      createdAt: new Date(version.createdAt),
    })
    .onConflictDoUpdate({
      target: [wfWorkflowVersion.workflowId, wfWorkflowVersion.version],
      set: { data: version },
    });
}

export async function loadVersion(
  db: Db,
  workflowId: string,
  version: number,
): Promise<StoredWorkflowVersion | null> {
  const [row] = await db
    .select()
    .from(wfWorkflowVersion)
    .where(
      and(eq(wfWorkflowVersion.workflowId, workflowId), eq(wfWorkflowVersion.version, version)),
    )
    .limit(1);
  return row ? (row.data as StoredWorkflowVersion) : null;
}

export async function listVersions(db: Db, workflowId: string): Promise<number[]> {
  const rows = await db
    .select({ version: wfWorkflowVersion.version })
    .from(wfWorkflowVersion)
    .where(eq(wfWorkflowVersion.workflowId, workflowId))
    .orderBy(asc(wfWorkflowVersion.version));
  return rows.map((r) => r.version);
}
