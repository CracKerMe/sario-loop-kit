/**
 * Backs @loopkit/timers' PgTimerAdapter (implements the engine's
 * ExternalTimerAdapter interface) and its poller. This is what makes
 * multi-day wait nodes durable — the engine's own in-process setTimeout
 * does not survive a restart mid-wait.
 */
import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const timer = pgTable(
  "timer",
  {
    // Engine-supplied: `wait:{instanceId}:{nodeId}:{deadline}`. Already
    // idempotent on the engine side (shouldSchedule dedups on
    // timerKey+eventType), so ON CONFLICT DO NOTHING on this column is
    // sufficient — never derive/recompute it, only ever read it back.
    timerKey: text("timer_key").primaryKey(),
    instanceId: text("instance_id").notNull(),
    nodeId: text("node_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    eventType: text("event_type").notNull(),
    triggerAt: timestamp("trigger_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status")
      .$type<"pending" | "claimed" | "fired" | "cancelled" | "orphaned">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
  },
  (t) => [
    // The poller's claim query. Partial on status='pending' so the index
    // stays small regardless of how many timers have already fired.
    index("timer_due_idx")
      .on(t.triggerAt)
      .where(sql`${t.status} = 'pending'`),
    index("timer_instance_idx").on(t.instanceId, t.nodeId),
  ],
);
