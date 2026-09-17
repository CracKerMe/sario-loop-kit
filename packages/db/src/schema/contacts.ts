import { relations, sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { workspace } from "./workspace";

export const contact = pgTable(
  "contact",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    userId: text("user_id"), // the caller's own id, if they provided one
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    subscribed: boolean("subscribed").notNull().default(true),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("contact_ws_email_uidx").on(t.workspaceId, sql`lower(${t.email})`),
    uniqueIndex("contact_ws_userid_uidx")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.userId} is not null`),
    index("contact_props_gin").using("gin", t.properties),
  ],
);

export const contactEvent = pgTable(
  "contact_event",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // e.g. "order.placed", "email.opened"
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contact_event_contact_time_idx").on(t.contactId, t.occurredAt.desc()),
    index("contact_event_ws_name_time_idx").on(t.workspaceId, t.name, t.occurredAt.desc()),
    uniqueIndex("contact_event_idem_uidx")
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const audience = pgTable("audience", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // SegmentFilter AST, evaluated to SQL by @loopkit/core.
  filter: jsonb("filter").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contactRelations = relations(contact, ({ many }) => ({
  events: many(contactEvent),
}));

export const contactEventRelations = relations(contactEvent, ({ one }) => ({
  contact: one(contact, {
    fields: [contactEvent.contactId],
    references: [contact.id],
  }),
}));
