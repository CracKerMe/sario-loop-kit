import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { contact } from "./contacts";
import { workspace } from "./workspace";

export const journey = pgTable(
  "journey",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status")
      .$type<"draft" | "published" | "paused" | "archived">()
      .notNull()
      .default("draft"),
    publishedVersion: integer("published_version"),
    // The engine workflowId this journey publishes to. Stable across
    // journey_version rows — republishing overwrites the same engine
    // workflow definition rather than minting a new workflowId.
    workflowId: text("workflow_id").notNull().unique(),
    trigger: jsonb("trigger").notNull(), // JourneyTrigger
    reentry: text("reentry")
      .$type<"once" | "once_at_a_time" | "always">()
      .notNull()
      .default("once"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("journey_ws_status_idx").on(t.workspaceId, t.status)],
);

export const journeyVersion = pgTable(
  "journey_version",
  {
    journeyId: text("journey_id")
      .notNull()
      .references(() => journey.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // React Flow nodes+edges — the source of truth the builder edits.
    graph: jsonb("graph").notNull(),
    // Cached compile() output (engine WorkflowDefinition), derived from
    // graph. Never hand-edited; recomputed on publish.
    compiled: jsonb("compiled").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.journeyId, t.version] })],
);

/**
 * THE correlation index. `event` nodes in the engine only resume by
 * instanceId — there is no "wake the instance whose contact.email = X"
 * lookup built in. This table is what makes that possible:
 * (journeyId, contactId) -> the engine instanceId currently running that
 * contact through that journey.
 *
 * Re-entry semantics: only "once_at_a_time" gets a DB-level guarantee, via
 * the partial unique index below (one running row per journey+contact at a
 * time). "once" (never re-enter, ever) is enforced in application code
 * inside the same transaction that inserts this row — an unconditional
 * unique index here would make "always" (unlimited re-entry) impossible to
 * add later without a migration.
 */
export const journeyRun = pgTable(
  "journey_run",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    journeyId: text("journey_id")
      .notNull()
      .references(() => journey.id, { onDelete: "cascade" }),
    journeyVersion: integer("journey_version").notNull(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    // Engine instanceId. Filled with a `pending:<runId>` placeholder until
    // engine.start() returns, then updated — see the Phase 5 trigger
    // service for why this two-step insert matters (engine.start() is not
    // transactional with this table).
    instanceId: text("instance_id").notNull().unique(),
    status: text("status")
      .$type<"pending" | "running" | "completed" | "failed" | "cancelled" | "exited">()
      .notNull(),
    /**
     * Set to `true` at insert time only when the journey's reentry mode
     * is "once_at_a_time"; left `null` for "once" (gated in application
     * code, not here) and "always" (never gated — concurrent running
     * rows for the same contact are the whole point). A partial unique
     * index can't reach across to journey.reentry to conditionally
     * apply itself, so this column exists purely to give the index
     * something per-row to test: `journey_run_active_uidx` only
     * constrains rows where this is true, so "always" journeys are
     * structurally exempt rather than needing to pass a status check
     * that would otherwise apply uniformly to every reentry mode.
     */
    activeLock: boolean("active_lock"),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    exitReason: text("exit_reason"),
  },
  (t) => [
    // once_at_a_time: at most one RUNNING row per (journey, contact),
    // among rows that opted into the lock via activeLock.
    uniqueIndex("journey_run_active_uidx")
      .on(t.journeyId, t.contactId)
      .where(sql`${t.activeLock} = true AND ${t.status} = 'running'`),
    index("journey_run_contact_idx").on(t.contactId, t.status),
    index("journey_run_journey_status_idx").on(t.journeyId, t.status),
  ],
);

export const journeyRelations = relations(journey, ({ many }) => ({
  versions: many(journeyVersion),
  runs: many(journeyRun),
}));

export const journeyVersionRelations = relations(journeyVersion, ({ one }) => ({
  journey: one(journey, {
    fields: [journeyVersion.journeyId],
    references: [journey.id],
  }),
}));

export const journeyRunRelations = relations(journeyRun, ({ one }) => ({
  journey: one(journey, {
    fields: [journeyRun.journeyId],
    references: [journey.id],
  }),
  contact: one(contact, {
    fields: [journeyRun.contactId],
    references: [contact.id],
  }),
}));
