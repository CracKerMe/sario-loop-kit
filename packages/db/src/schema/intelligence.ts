import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { contact } from "./contacts";
import { workspace } from "./workspace";

/**
 * Workspace-level lead scoring rules (Apollo-style fit + engagement score).
 * Recomputed onto `contact.properties.leadScore` / `leadTier` after contact
 * writes and inbound events. Rules are additive; evaluation is deterministic.
 */
export const leadScoreRule = pgTable(
  "lead_score_rule",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    /**
     * property  — contact property comparison (fit)
     * event     — lifecycle event in a window (engagement)
     * page      — website page.viewed path match (intent)
     */
    kind: text("kind").$type<"property" | "event" | "page">().notNull(),
    /** property kind */
    propertyKey: text("property_key"),
    operator: text("operator").$type<
      "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte" | "exists" | "missing"
    >(),
    propertyValue: text("property_value"),
    /** event / page kind */
    eventName: text("event_name"),
    /** page kind: substring match on properties.path */
    pathContains: text("path_contains"),
    /** event window; null = all time */
    windowHours: integer("window_hours"),
    /** Cap how many times the rule can contribute (event/page). null = every hit. */
    maxHits: integer("max_hits"),
    points: integer("points").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("lead_score_rule_ws_idx").on(t.workspaceId, t.sortOrder)],
);

/**
 * Signal plays — "when this happens, do that" automations evaluated on
 * contact_created / event signals after scoring. Actions are JSON so the
 * product can grow new action types without a migration per action.
 */
export const play = pgTable(
  "play",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    /**
     * { kind: "event", name: "page.viewed", pathContains?: string }
     * { kind: "contact_created" }
     * { kind: "score_threshold", min: number }
     */
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    /** Optional SegmentFilter AST against the contact. */
    conditions: jsonb("conditions"),
    /**
     * [{ type: "set_property", key, value }]
     * [{ type: "add_tag", tag }]
     * [{ type: "notify", url, message? }]
     * [{ type: "start_journey", journeyId }]
     */
    actions: jsonb("actions").$type<Array<Record<string, unknown>>>().notNull().default([]),
    runCount: integer("run_count").notNull().default(0),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("play_ws_idx").on(t.workspaceId, t.active)],
);

/** Per-contact play firing state — prevents re-firing the same play immediately. */
export const playContactState = pgTable(
  "play_contact_state",
  {
    playId: text("play_id")
      .notNull()
      .references(() => play.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }).notNull().defaultNow(),
    fireCount: integer("fire_count").notNull().default(1),
  },
  (t) => [uniqueIndex("play_contact_uidx").on(t.playId, t.contactId)],
);

/** Website tracking configuration + high-intent path hints for the UI. */
export const signalSettings = pgTable("signal_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  /** Public tracking key embedded in the site snippet. */
  trackingKey: text("tracking_key").notNull(),
  /** Path substrings treated as high intent (shown in UI; scored via leadScoreRule). */
  highIntentPaths: jsonb("high_intent_paths").$type<string[]>().notNull().default([]),
  /** Team notify webhook for high-intent visits. */
  intentWebhookUrl: text("intent_webhook_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const leadScoreRuleRelations = relations(leadScoreRule, ({ one }) => ({
  workspace: one(workspace, {
    fields: [leadScoreRule.workspaceId],
    references: [workspace.id],
  }),
}));

export const playRelations = relations(play, ({ one }) => ({
  workspace: one(workspace, {
    fields: [play.workspaceId],
    references: [workspace.id],
  }),
}));

export const intelligenceTables = [leadScoreRule, play, playContactState, signalSettings] as const;
