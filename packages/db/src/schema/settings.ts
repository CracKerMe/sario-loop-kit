/**
 * Agent-first settings data model — the settings-side twin of
 * journey_intent / journey_agent_message (see schema/journeys.ts).
 *
 * The workspace (not a journey) is the subject here: one intent row per
 * workspace holds the operator's standing brief, the agent-maintained
 * requirement coverage checklist, and a cached plain-language narrative of
 * the current configuration. The narrative is pinned to a *fingerprint* of
 * the configuration snapshot (see routes/settingsAgent.ts) instead of a
 * version number — settings have no version history, but any materialized
 * change (applied proposal or manual edit in a professional panel) moves
 * the fingerprint, which is what marks the narrative stale.
 */
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { workspace } from "./workspace";

export type SettingsRequirementStatus = "covered" | "partial" | "uncovered" | "needs_input";

export interface SettingsRequirementRecord {
  id: string;
  text: string;
  status: SettingsRequirementStatus;
  /** Refs of the proposal changes that implement this requirement. */
  changeRefs: string[];
  note?: string;
}

export const settingsIntent = pgTable("settings_intent", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .unique()
    .references(() => workspace.id, { onDelete: "cascade" }),
  brief: text("brief").notNull().default(""),
  requirements: jsonb("requirements").$type<SettingsRequirementRecord[]>().notNull().default([]),
  narrative: jsonb("narrative").$type<Record<string, unknown> | null>(),
  /** Fingerprint of the configuration snapshot the narrative describes. */
  narrativeFingerprint: text("narrative_fingerprint"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Agent conversation transcript for the settings workbench. `kind` selects
 * the workbench rendering, exactly like journey_agent_message.
 */
export const settingsAgentMessage = pgTable(
  "settings_agent_message",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "agent">().notNull(),
    kind: text("kind").$type<"text" | "proposal" | "question">().notNull().default("text"),
    content: text("content").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("settings_agent_message_ws_idx").on(t.workspaceId, t.createdAt)],
);
