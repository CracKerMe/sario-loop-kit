/**
 * Multi-tenant boundary. Every product table (contacts, journeys, email,
 * ...) carries workspaceId from day one — retrofitting multi-tenancy later
 * means touching every query and every index, so it goes in now while
 * there are zero rows.
 */
import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { user } from "./auth";

export const workspace = pgTable("workspace", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const workspaceMember = pgTable(
  "workspace_member",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<"owner" | "admin" | "member">().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_member_ws_user_uidx").on(t.workspaceId, t.userId),
    index("workspace_member_user_idx").on(t.userId),
  ],
);

export const apiKey = pgTable(
  "api_key",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Shown in the UI, e.g. "lk_live_abc1" — never the full key.
    prefix: text("prefix").notNull(),
    // sha256(full key). A high-entropy random key needs only an indexed
    // equality lookup on its hash, not a slow KDF like bcrypt.
    hash: text("hash").notNull(),
    scopes: text("scopes").array().notNull().default(["ingest"]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("api_key_hash_uidx").on(t.hash), index("api_key_ws_idx").on(t.workspaceId)],
);

export const workspaceRelations = relations(workspace, ({ many }) => ({
  members: many(workspaceMember),
  apiKeys: many(apiKey),
}));

export const workspaceMemberRelations = relations(workspaceMember, ({ one }) => ({
  workspace: one(workspace, {
    fields: [workspaceMember.workspaceId],
    references: [workspace.id],
  }),
  user: one(user, {
    fields: [workspaceMember.userId],
    references: [user.id],
  }),
}));

export const apiKeyRelations = relations(apiKey, ({ one }) => ({
  workspace: one(workspace, {
    fields: [apiKey.workspaceId],
    references: [workspace.id],
  }),
}));
