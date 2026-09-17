/**
 * Storage tables backing the DrizzleStorageProvider (@loopkit/engine-storage),
 * the StorageProvider implementation the workflow engine (ts-workflow-engine-lite)
 * is bootstrapped with. See src/storage/StorageProvider.ts in that package for
 * the interface these tables satisfy.
 *
 * Design choice: the engine treats a WorkflowInstance as an opaque object it
 * reads and rewrites wholesale on every node transition (it does not query
 * into context/history/state). Normalizing those into child tables buys
 * nothing and turns the hottest write path into a multi-statement
 * transaction. Instead we store the whole instance as one jsonb blob and
 * only promote the columns queryInstances() actually filters/sorts on to
 * real columns, indexed to match its query shapes exactly.
 */
import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// wf_instance — the hottest table. version is CAS: casUpdateInstance() does
// `UPDATE ... SET version = $expected + 1 WHERE id = $id AND version = $expected`.
// The version written here MUST also be reflected inside `data` (the engine
// reads instance.version back out of the loaded object) — mismatched, every
// CAS after the first one fails and the engine DLQs everything.
// ---------------------------------------------------------------------------
export const wfInstance = pgTable(
  "wf_instance",
  {
    instanceId: text("instance_id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    status: text("status").notNull(),
    parentInstanceId: text("parent_instance_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    // Full WorkflowInstance (context, history, state, retries, ...).
    data: jsonb("data").notNull(),
  },
  (t) => [
    // Exactly the queryInstances() query shapes: equality on
    // (workflowId | status | parentInstanceId) + sort-before-paginate on
    // createdAt/updatedAt. StorageProvider.ts is explicit that sorting must
    // happen before pagination in the storage layer, so these all carry an
    // ordered second column.
    index("wf_instance_wf_created_idx").on(t.workflowId, t.createdAt.desc()),
    index("wf_instance_status_created_idx").on(t.status, t.createdAt.desc()),
    index("wf_instance_parent_idx").on(t.parentInstanceId),
    index("wf_instance_created_idx").on(t.createdAt.desc()),
    index("wf_instance_updated_idx").on(t.updatedAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// wf_workflow / wf_workflow_meta / wf_workflow_version
// ---------------------------------------------------------------------------
export const wfWorkflow = pgTable("wf_workflow", {
  workflowId: text("workflow_id").primaryKey(),
  definition: jsonb("definition").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const wfWorkflowMeta = pgTable("wf_workflow_meta", {
  workflowId: text("workflow_id").primaryKey(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
  data: jsonb("data").notNull(), // StoredWorkflow (incl. releasePolicy/canary/promotionRules)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const wfWorkflowVersion = pgTable(
  "wf_workflow_version",
  {
    workflowId: text("workflow_id").notNull(),
    version: integer("version").notNull(),
    data: jsonb("data").notNull(), // StoredWorkflowVersion
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.version] })],
);

// ---------------------------------------------------------------------------
// wf_event_wait — loadAllEventWaitingStates() scans this whole table once at
// engine startup and (in @loopkit/engine) whenever the in-memory
// instanceId -> eventType correlation index needs rebuilding. Keep it small:
// rows are deleted as soon as a wait resolves (deleteEventWaitingState).
// ---------------------------------------------------------------------------
export const wfEventWait = pgTable(
  "wf_event_wait",
  {
    instanceId: text("instance_id").notNull(),
    nodeId: text("node_id").notNull(),
    eventType: text("event_type").notNull(),
    deadline: bigint("deadline", { mode: "number" }),
    data: jsonb("data").notNull(), // EventWaitingState
  },
  (t) => [
    // Matches loadEventWaitingState(instanceId, nodeId) exactly.
    primaryKey({ columns: [t.instanceId, t.nodeId] }),
    index("wf_event_wait_type_idx").on(t.eventType),
  ],
);

// ---------------------------------------------------------------------------
// wf_event — durable event history (queryEvents / saveEvent / loadEvent).
// ---------------------------------------------------------------------------
export const wfEvent = pgTable(
  "wf_event",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    eventType: text("event_type").notNull(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    payload: jsonb("payload"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("wf_event_instance_ts_idx").on(t.instanceId, t.timestamp.desc()),
    index("wf_event_type_ts_idx").on(t.eventType, t.timestamp.desc()),
  ],
);

// ---------------------------------------------------------------------------
// wf_node_metric — one row per (instanceId, nodeId), NOT one blob per
// instance. updateNodeMetrics(instanceId, nodeId, metrics) is called on
// every node transition; a single InstanceMetrics blob per instance would
// make that a read-modify-write under concurrency. Per-node rows also make
// this directly usable for reporting later (e.g. "how many contacts are
// sitting on node X across all journeys" is one indexed query) without
// touching the engine's own (non-persistent) AnalyticsCollector.
// ---------------------------------------------------------------------------
export const wfNodeMetric = pgTable(
  "wf_node_metric",
  {
    instanceId: text("instance_id").notNull(),
    nodeId: text("node_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    nodeType: text("node_type"),
    status: text("status"),
    startTime: bigint("start_time", { mode: "number" }),
    endTime: bigint("end_time", { mode: "number" }),
    duration: integer("duration"),
    retryCount: integer("retry_count").notNull().default(0),
    data: jsonb("data").notNull(), // NodeMetrics
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.instanceId, t.nodeId] }),
    index("wf_node_metric_wf_node_idx").on(t.workflowId, t.nodeId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Optional-capability tables. Implemented even though StorageProvider marks
// their methods optional: skipping saveDeadLetterEntry makes the DLQ
// memory-only, i.e. silent data loss on exactly the failures you most want
// to inspect. cleanupStaleInstances needs somewhere to delete from.
// ---------------------------------------------------------------------------
export const wfDlq = pgTable("wf_dlq", {
  id: text("id").primaryKey(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const wfHeartbeat = pgTable(
  "wf_heartbeat",
  {
    instanceId: text("instance_id").notNull(),
    nodeId: text("node_id").notNull(),
    deadline: bigint("deadline", { mode: "number" }).notNull(),
    data: jsonb("data").notNull(), // HeartbeatState
  },
  (t) => [
    primaryKey({ columns: [t.instanceId, t.nodeId] }),
    index("wf_heartbeat_deadline_idx").on(t.deadline),
  ],
);

export const wfWebhook = pgTable("wf_webhook", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // "registration" | "delivery"
  data: jsonb("data").notNull(),
});

export const wfInstanceRelations = relations(wfInstance, ({ many }) => ({
  eventWaits: many(wfEventWait),
  nodeMetrics: many(wfNodeMetric),
}));
