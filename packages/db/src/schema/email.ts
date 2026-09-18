import { relations, sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { campaign } from "./campaigns";
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
  /**
   * The sent artefact. When `source` is `"tiptap"` this is a **derived
   * cache** of `doc`, produced by the server on save — see @loopkit/email-doc.
   * It is stored rather than rendered per send so the send path stays a plain
   * read, and so a render can never fail inside a delivery.
   */
  html: text("html").notNull(),
  textBody: text("text_body"),
  fromName: text("from_name"),
  fromEmail: text("from_email"),
  replyTo: text("reply_to"),
  /**
   * What produced `html`. `"react-email"` and `"mjml"` remain unused reserved
   * hooks from the original schema; `"tiptap"` is the visual editor, and it is
   * the only value for which `doc` is populated.
   */
  source: text("source")
    .$type<"html" | "react-email" | "mjml" | "tiptap">()
    .notNull()
    .default("html"),
  /**
   * The visual editor's ProseMirror JSON — the source of truth when present.
   *
   * Stored as JSON rather than re-parsed from `html` because a rendered email
   * is a table layout with inline styles: parsing it back into a structured
   * document is lossy in exactly the ways that matter (which text was a
   * heading, which `<a>` was a button, where the merge tags were). Storing the
   * document keeps editing idempotent.
   *
   * It is **untrusted input on read as well as on write** — the server
   * validates it with @loopkit/email-doc before rendering, every time.
   */
  doc: jsonb("doc").$type<unknown>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * `idempotencyKey` is the correctness lynchpin of the whole email path: the
 * engine retries a failed `notification` node automatically (via
 * retryPolicy/failureNext), and this unique index is what stops a retry from
 * sending a duplicate email. The channel inserts with ON CONFLICT DO NOTHING
 * RETURNING id — no row back means "already sent, no-op".
 *
 * The key is `${runKey}:${nodeId}` where `runKey` is `journeyRunId` for a
 * journey send and `campaignId` for a campaign send (exactly one is set —
 * see the channel's doc comment). Keyed on journeyRunId rather than
 * instanceId because the engine has no mechanism to expose
 * instance.instanceId to a notification node's own config; `instanceId`
 * below is populated best-effort where available and is not load-bearing.
 *
 * Campaign sends deliberately reuse this same row and index rather than
 * getting their own table: a campaign recipient's send must be exactly-once
 * for exactly the same reason a journey node's is, and a second table would
 * mean a second place for that guarantee to be missing.
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
    /** Set for campaign sends; mutually exclusive with journeyRunId. */
    campaignId: text("campaign_id").references(() => campaign.id, { onDelete: "cascade" }),
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
    index("email_send_campaign_idx").on(t.campaignId, t.createdAt.desc()),
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
  campaign: one(campaign, {
    fields: [emailSend.campaignId],
    references: [campaign.id],
  }),
  deliveries: many(emailDelivery),
}));

export const emailDeliveryRelations = relations(emailDelivery, ({ one }) => ({
  send: one(emailSend, {
    fields: [emailDelivery.sendId],
    references: [emailSend.id],
  }),
}));
