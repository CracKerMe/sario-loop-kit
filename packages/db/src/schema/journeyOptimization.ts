/**
 * AI journey optimization (P3.5) — proposal history + live canary state.
 *
 * `journey_optimization` is append-only evidence: what the funnel looked
 * like when the model was asked, what it proposed, and how the operator
 * disposed of that proposal. `journey_canary` is the short-lived live
 * release window for one accepted proposal (baseline vs canary version,
 * percent, promotion rules, last evaluation).
 */
import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { journey } from "./journeys";
import { workspace } from "./workspace";

export type JourneyOptimizationStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "canary"
  | "promoted"
  | "rolled_back";

export type JourneyCanaryStatus = "active" | "promoted" | "rolled_back";

export const journeyOptimization = pgTable(
  "journey_optimization",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    journeyId: text("journey_id")
      .notNull()
      .references(() => journey.id, { onDelete: "cascade" }),
    /** journey.publishedVersion at the moment signals were collected. */
    baselineVersion: integer("baseline_version"),
    /** Aggregated node funnel + run/email counters the model saw. */
    signals: jsonb("signals").notNull(),
    /** Guarded analysis narrative (summary/diagnosis/expectedImpact). */
    analysis: jsonb("analysis").notNull(),
    /** Full proposed JourneyGraph — already cleared guardAiGraph. */
    proposedGraph: jsonb("proposed_graph").notNull(),
    /** Old node id → new node id for remap-style in-flight migration. */
    nodeMapping: jsonb("node_mapping"),
    canaryPercent: integer("canary_percent").notNull().default(10),
    model: text("model"),
    attempts: integer("attempts"),
    usage: jsonb("usage"),
    status: text("status").$type<JourneyOptimizationStatus>().notNull().default("proposed"),
    /** journey_version.version minted when this proposal was accepted. */
    targetVersion: integer("target_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("journey_opt_journey_idx").on(t.journeyId, t.createdAt.desc())],
);

export const journeyCanary = pgTable("journey_canary", {
  journeyId: text("journey_id")
    .primaryKey()
    .references(() => journey.id, { onDelete: "cascade" }),
  optimizationId: text("optimization_id").references(() => journeyOptimization.id, {
    onDelete: "set null",
  }),
  baselineVersion: integer("baseline_version").notNull(),
  /** journey_version.version of the canary graph (same journey, not a global FK). */
  canaryVersion: integer("canary_version").notNull(),
  percent: integer("percent").notNull(),
  autoPromote: boolean("auto_promote").notNull().default(false),
  minRuns: integer("min_runs").notNull().default(20),
  maxBounceRate: doublePrecision("max_bounce_rate").notNull().default(0.08),
  /** Metric floor the canary must not fall below (relative, 0–1). */
  minCompletionDelta: doublePrecision("min_completion_delta").notNull().default(-0.02),
  status: text("status").$type<JourneyCanaryStatus>().notNull().default("active"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
  lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
  lastEvaluation: jsonb("last_evaluation"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const journeyOptimizationRelations = relations(journeyOptimization, ({ one }) => ({
  journey: one(journey, {
    fields: [journeyOptimization.journeyId],
    references: [journey.id],
  }),
  workspace: one(workspace, {
    fields: [journeyOptimization.workspaceId],
    references: [workspace.id],
  }),
}));

export const journeyCanaryRelations = relations(journeyCanary, ({ one }) => ({
  journey: one(journey, {
    fields: [journeyCanary.journeyId],
    references: [journey.id],
  }),
  optimization: one(journeyOptimization, {
    fields: [journeyCanary.optimizationId],
    references: [journeyOptimization.id],
  }),
}));

/** Convenience for drizzle-kit / test truncates. */
export const journeyOptimizationTables = [journeyOptimization, journeyCanary] as const;
