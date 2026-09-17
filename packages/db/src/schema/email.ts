import { relations, sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { contact } from "./contacts";
import { journey, journeyRun } from "./journeys";
import { workspace } from "./workspace";

export const emailTemplate = pgTable("email_template", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  html: text("html").notNull(),
  textBody: text("text_body"),
  fromName: text("from_name"),
  fromEmail: text("from_email"),
  replyTo: text("reply_to"),
  // Non-breaking hook for a future authoring tool (React Email/MJMLM) —
  // v1 only ever writes "html".
  source: text("source").$type<"html" | "react-email" | "mjml">().notNull().default("html"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * `idempotencyKey = ${instanceId}:${nodeId}` is the correctness lynchpin of
 * the whole email path: the engine retries a failed `notification` node
 * automatically (via retryPolicy/failureNext), and this unique index is
 * what stops a retry from sending a duplicate email. The channel inserts
 * with ON CONFLICT DO NOTHING RETURNING id — no row back means "already
 * sent, no-op".
 */
export const emailSend = pgTable(
  "email_send",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    templateId: text("template_id"),
    journeyId: text("journey_id").references(() => journey.id),
    journeyRunId: text("journey_run_id").references(() => journeyRun.id),
    instanceId: text("instance_id"),
    nodeId: text("node_id"),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    provider: text("provider").notNull(), // "resend"
    // The webhook join key.
    providerMessageId: text("provider_message_id"),
    // Status lattice: queued < sent < delivered, with bounced/complained/
    // failed terminal. Never derive from "latest event" — Resend webhook
    // events can arrive out of order (opened before delivered).
    status: text("status")
      .$type<"queued" | "sent" | "delivered" | "bounced" | "complained" | "failed">()
      .notNull(),
    error: text("error"),
    idempotencyKey: text("idempotency_key").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_send_idem_uidx").on(t.workspaceId, t.idempotencyKey),
    uniqueIndex("email_send_provider_msg_uidx")
      .on(t.provider, t.providerMessageId)
      .where(sql`${t.providerMessageId} is not null`),
    index("email_send_journey_idx").on(t.journeyId, t.createdAt.desc()),
    index("email_send_contact_idx").on(t.contactId, t.createdAt.desc()),
  ],
);

/** Append-only delivery event log, joined via providerMessageId. */
export const emailDelivery = pgTable(
  "email_delivery",
  {
    id: text("id").primaryKey(),
    // Nullable: a webhook event can arrive for a provider message this
    // workspace has no email_send record for (e.g. a transactional send
    // issued outside Loopkit, or one Loopkit sent before this table
    // existed) — the event is still recorded and deduped, just left
    // unlinked, rather than the whole webhook call failing.
    sendId: text("send_id").references(() => emailSend.id, { onDelete: "cascade" }),
    type: text("type")
      .$type<"delivered" | "opened" | "clicked" | "bounced" | "complained" | "delivery_delayed">()
      .notNull(),
    url: text("url"),
    raw: jsonb("raw"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    providerEventId: text("provider_event_id"),
  },
  (t) => [
    // Webhook replay dedup — Resend (and most providers) can redeliver.
    uniqueIndex("email_delivery_provider_evt_uidx")
      .on(t.providerEventId)
      .where(sql`${t.providerEventId} is not null`),
    index("email_delivery_send_idx").on(t.sendId, t.occurredAt),
  ],
);

export const emailSendRelations = relations(emailSend, ({ one, many }) => ({
  contact: one(contact, {
    fields: [emailSend.contactId],
    references: [contact.id],
  }),
  deliveries: many(emailDelivery),
}));

export const emailDeliveryRelations = relations(emailDelivery, ({ one }) => ({
  send: one(emailSend, {
    fields: [emailDelivery.sendId],
    references: [emailSend.id],
  }),
}));
