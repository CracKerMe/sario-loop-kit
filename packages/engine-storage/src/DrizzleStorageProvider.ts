import type { Db } from "@loopkit/db";
import { wfInstance } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import type {
  EventQueryParams,
  EventRecord,
  EventWaitingState,
  HeartbeatState,
  InstanceMetrics,
  InstanceQueryParams,
  NodeMetrics,
  StorageProvider,
  StoredWorkflow,
  StoredWorkflowVersion,
  WorkflowDefinition,
  WorkflowInstance,
} from "ts-workflow-engine-lite";

import * as eventWaits from "./eventWaits";
import * as events from "./events";
import * as instances from "./instances";
import * as metrics from "./metrics";
import * as optional from "./optional";
import * as workflows from "./workflows";

/**
 * StorageProvider backed by Postgres via Drizzle, sharing the connection
 * pool @loopkit/db owns rather than creating its own.
 *
 * Structure: this class is a thin, mechanical delegation layer (~30
 * one-line methods) — the actual per-concern logic lives in sibling
 * modules (instances/workflows/eventWaits/events/metrics/optional) as
 * free functions taking `db` explicitly, so each concern can be unit
 * tested (and read) independently of the class.
 *
 * `close()` is deliberately a no-op: destroyContainer() calls it, and this
 * adapter does not own the pool — @loopkit/db does, shut down by the
 * process's own shutdown hook. Closing the shared pool here would take
 * the rest of the app down with the engine.
 */
export class DrizzleStorageProvider implements StorageProvider {
  #connected = false;

  constructor(private readonly db: Db) {}

  async connect(): Promise<void> {
    if (this.#connected) return;
    // Cheap connectivity check; throws if the pool can't reach the DB.
    await this.db.execute(/* sql */ `select 1`);
    this.#connected = true;
  }

  async close(): Promise<void> {
    // Intentional no-op — see class doc comment.
  }

  // --- StorageCore: instances ----------------------------------------------

  saveInstance(instance: WorkflowInstance): Promise<void> {
    return instances.save(this.db, instance);
  }

  casUpdateInstance(instance: WorkflowInstance): Promise<boolean> {
    return instances.cas(this.db, instance);
  }

  loadInstance(instanceId: string): Promise<WorkflowInstance | null> {
    return instances.load(this.db, instanceId);
  }

  deleteInstance(instanceId: string): Promise<void> {
    return instances.remove(this.db, instanceId);
  }

  listInstances(): Promise<string[]> {
    return instances.list(this.db);
  }

  queryInstances(
    params: InstanceQueryParams,
  ): Promise<{ instances: WorkflowInstance[]; total: number }> {
    return instances.query(this.db, params);
  }

  // --- StorageCore: workflow definitions ------------------------------------

  saveWorkflow(workflow: WorkflowDefinition): Promise<void> {
    return workflows.save(this.db, workflow);
  }

  loadWorkflow(workflowId: string): Promise<WorkflowDefinition | null> {
    return workflows.load(this.db, workflowId);
  }

  deleteWorkflow(workflowId: string): Promise<void> {
    return workflows.remove(this.db, workflowId);
  }

  listWorkflows(): Promise<string[]> {
    return workflows.list(this.db);
  }

  // --- StorageCore: event waiting state -------------------------------------

  saveEventWaitingState(state: EventWaitingState): Promise<void> {
    return eventWaits.save(this.db, state);
  }

  loadEventWaitingState(instanceId: string, nodeId: string): Promise<EventWaitingState | null> {
    return eventWaits.load(this.db, instanceId, nodeId);
  }

  loadAllEventWaitingStates(): Promise<EventWaitingState[]> {
    return eventWaits.loadAll(this.db);
  }

  deleteEventWaitingState(instanceId: string, nodeId: string): Promise<void> {
    return eventWaits.remove(this.db, instanceId, nodeId);
  }

  // --- workflow metadata / versions ------------------------------------------

  saveWorkflowWithMetadata(workflow: StoredWorkflow): Promise<void> {
    return workflows.saveWithMetadata(this.db, workflow);
  }

  loadWorkflowWithMetadata(workflowId: string): Promise<StoredWorkflow | null> {
    return workflows.loadWithMetadata(this.db, workflowId);
  }

  listWorkflowsWithMetadata(): Promise<StoredWorkflow[]> {
    return workflows.listWithMetadata(this.db);
  }

  saveWorkflowVersion(version: StoredWorkflowVersion): Promise<void> {
    return workflows.saveVersion(this.db, version);
  }

  loadWorkflowVersion(workflowId: string, version: number): Promise<StoredWorkflowVersion | null> {
    return workflows.loadVersion(this.db, workflowId, version);
  }

  listWorkflowVersions(workflowId: string): Promise<number[]> {
    return workflows.listVersions(this.db, workflowId);
  }

  // --- instance metrics --------------------------------------------------------

  saveInstanceMetrics(instanceMetrics: InstanceMetrics): Promise<void> {
    return metrics.save(this.db, instanceMetrics);
  }

  loadInstanceMetrics(instanceId: string): Promise<InstanceMetrics | null> {
    return metrics.load(this.db, instanceId);
  }

  deleteInstanceMetrics(instanceId: string): Promise<void> {
    return metrics.remove(this.db, instanceId);
  }

  async updateNodeMetrics(
    instanceId: string,
    nodeId: string,
    nodeMetrics: NodeMetrics,
  ): Promise<void> {
    // StorageProvider's updateNodeMetrics doesn't receive a workflowId;
    // MemoryStorage derives it from the already-stored InstanceMetrics or
    // the live instance. We do the equivalent lookup so wf_node_metric's
    // workflow_id column (used by the funnel index) stays populated.
    const [row] = await this.db
      .select({ workflowId: wfInstance.workflowId })
      .from(wfInstance)
      .where(eq(wfInstance.instanceId, instanceId))
      .limit(1);
    await metrics.updateNode(this.db, instanceId, nodeId, nodeMetrics, row?.workflowId ?? "");
  }

  // --- event history ----------------------------------------------------------

  saveEvent(event: EventRecord): Promise<void> {
    return events.save(this.db, event);
  }

  loadEvent(eventId: string): Promise<EventRecord | null> {
    return events.load(this.db, eventId);
  }

  queryEvents(params: EventQueryParams): Promise<{ events: EventRecord[]; total: number }> {
    return events.query(this.db, params);
  }

  deleteEvent(eventId: string): Promise<void> {
    return events.remove(this.db, eventId);
  }

  // --- heartbeats (optional capability, implemented) ---------------------------

  saveHeartbeat(state: HeartbeatState): Promise<void> {
    return optional.saveHeartbeat(this.db, state);
  }

  loadAllHeartbeats(): Promise<HeartbeatState[]> {
    return optional.loadAllHeartbeats(this.db);
  }

  deleteHeartbeat(instanceId: string, nodeId: string): Promise<void> {
    return optional.deleteHeartbeat(this.db, instanceId, nodeId);
  }

  // --- cleanup (optional capability, implemented) -------------------------------

  cleanupStaleEvents(retentionDays: number): Promise<number> {
    return optional.cleanupStaleEvents(this.db, retentionDays);
  }

  cleanupExpiredHeartbeats(): Promise<number> {
    return optional.cleanupExpiredHeartbeats(this.db);
  }

  cleanupStaleInstances(maxAgeMs: number): Promise<number> {
    return optional.cleanupStaleInstances(this.db, maxAgeMs);
  }

  // --- DLQ (optional capability, implemented — skipping it makes the -----------
  // --- engine's DLQ memory-only, i.e. silent data loss) -------------------------

  saveDeadLetterEntry(entry: unknown): Promise<void> {
    return optional.saveDeadLetterEntry(this.db, entry);
  }

  loadAllDeadLetterEntries(): Promise<unknown[]> {
    return optional.loadAllDeadLetterEntries(this.db);
  }

  deleteDeadLetterEntry(id: string): Promise<void> {
    return optional.deleteDeadLetterEntry(this.db, id);
  }

  // --- webhooks (optional capability, implemented) --------------------------------

  saveWebhookEntry(entry: unknown): Promise<void> {
    return optional.saveWebhookEntry(this.db, entry);
  }

  loadAllWebhookEntries(): Promise<unknown[]> {
    return optional.loadAllWebhookEntries(this.db);
  }

  deleteWebhookEntry(id: string): Promise<void> {
    return optional.deleteWebhookEntry(this.db, id);
  }

  saveWebhookDeliveryEntry(entry: unknown): Promise<void> {
    return optional.saveWebhookDeliveryEntry(this.db, entry);
  }

  loadAllWebhookDeliveryEntries(): Promise<unknown[]> {
    return optional.loadAllWebhookDeliveryEntries(this.db);
  }

  deleteWebhookDeliveryEntry(id: string): Promise<void> {
    return optional.deleteWebhookDeliveryEntry(this.db, id);
  }

  // getClient() intentionally left undefined — StorageProvider marks it
  // optional and nothing in the engine calls it on the hot path.
}
