import { relations, sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { contact } from "./contacts";
import { workspace } from "./workspace";

/**
 * A one-off broadcast to a saved segment — the `Campaign` half of
 * "journey vs campaign" that the product was missing entirely.
 *
 * ## Why sending is modeled as an engine fan-out, not a second sender
 *
 * The tempting implementation is a `sendCampaign()` loop that walks the
 * recipient list and calls the email provider. That would be a second,
 * parallel sending path with its own retry policy, its own idempotency, its
 * own failure handling and its own DLQ — four things that already exist and
 * are already tested on the journey path, reimplemented worse.
 *
 * Instead a campaign compiles to a trivial one-node engine workflow (see
 * @loopkit/engine's campaignWorkflow.ts) and each recipient becomes an
 * engine *instance*. Everything the engine already guarantees then applies
 * for free:
 *
 *  - `email_send`'s unique `(workspaceId, idempotencyKey)` index makes a
 *    recipient's send exactly-once even across process restarts, because
 *    the key is `(campaignId, recipientId)` — see @loopkit/email's channel.
 *  - A provider failure becomes a thrown notification error, so the engine's
 *    retry policy and DLQ engage without a line of campaign-specific code.
 *  - Per-instance state survives a restart, which is what makes
 *    `POST /:id/resume` a real recovery path rather than a re-send gamble.
 *
 * ## The recipient table is the queue
 *
 * `campaign_recipient` is materialized up front (status `pending`) and
 * drained in bounded batches. It is deliberately not a "log written after
 * the fact": the pending rows ARE the work list, which is why a crash
 * mid-campaign is recoverable by re-running the drain over `pending` rows
 * instead of diffing two systems.
 */
export const campaign = pgTable(
  "campaign",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * `draft`   — being composed; nothing resolved yet
     * `scheduled` — audience materialized and filter frozen (same as
     *             `queued`'s materialization step), waiting for
     *             `scheduledAt` to arrive. The campaign scheduler poller
     *             (apps/server's campaignRunner.ts) promotes it to `queued`
     *             and starts the drain once due — see scheduledAt below.
     * `queued`  — recipients materialized, drain not started
     * `sending` — drain in progress
     * `paused`  — drain stopped deliberately; resumable
     * `sent`    — every recipient reached a terminal state
     * `cancelled` — operator stopped it; pending rows are abandoned
     * `failed`  — the drain itself errored (not individual sends)
     */
    status: text("status")
      .$type<
        "draft" | "scheduled" | "queued" | "sending" | "sent" | "paused" | "cancelled" | "failed"
      >()
      .notNull()
      .default("draft"),
    /** Deliberately NOT a foreign key: a sent campaign's record must outlive
     *  its template, and template deletion should never erase send history. */
    templateId: text("template_id"),
    /**
     * Set to NULL rather than cascading if the audience is deleted — the
     * campaign keeps its own frozen filter (below) and stays readable.
     */
    audienceId: text("audience_id"),
    /**
     * The audience's filter, copied at launch.
     *
     * This is the single most important column here. Once a campaign is
     * queued, who receives it must be decided: if the drain re-read the
     * audience, then editing a saved segment mid-send would change the
     * recipient set of an in-flight broadcast — some recipients getting one
     * version of intent, some another, with no way to reconstruct afterwards
     * who was actually targeted. Freezing the filter at launch makes the
     * campaign a historical record instead of a live query.
     */
    filter: jsonb("filter").$type<unknown>(),
    subject: text("subject"), // optional per-campaign override of the template's
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    replyTo: text("reply_to"),
    preheader: text("preheader"),
    utm: jsonb("utm").$type<{ source?: string; medium?: string; campaign?: string }>(),
    /** Segment size at launch, before sendability filtering. */
    audienceMemberCount: integer("audience_member_count"),
    /** Of those, how many were mailable (subscribed, not suppressed). */
    audienceSendableCount: integer("audience_sendable_count"),
    /**
     * When a `scheduled` campaign should start draining. Set by
     * `scheduleCampaign()` alongside materialization (the audience is
     * resolved and frozen at schedule time, not at fire time — see that
     * function's doc comment for why). Cleared when the campaign is
     * unscheduled back to `draft`, or once it starts sending.
     */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    recipientCount: integer("recipient_count").notNull().default(0),
    queuedCount: integer("queued_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    launchedAt: timestamp("launched_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("campaign_ws_status_idx").on(t.workspaceId, t.status, t.createdAt.desc()),
    // At most one non-terminal campaign per workspace+name? No — names are
    // labels, and blocking a re-send after a typo'd name is pure friction.
    index("campaign_ws_name_idx").on(t.workspaceId, t.name),
    // The scheduler poller's query: "which scheduled campaigns are due".
    // Partial so it stays tiny — most campaigns are never `scheduled`.
    index("campaign_scheduled_idx")
      .on(t.status, t.scheduledAt)
      .where(sql`${t.status} = 'scheduled'`),
  ],
);

/**
 * One row per intended recipient. `(campaignId, contactId)` is unique so a
 * resumed or double-clicked launch cannot double-materialize the audience —
 * the fan-out's idempotency starts here, before the engine is involved.
 */
export const campaignRecipient = pgTable(
  "campaign_recipient",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Denormalized so a send report survives the contact row's deletion. */
    email: text("email").notNull(),
    /**
     * `pending` — materialized, no engine instance yet
     * `queued`  — an engine instance owns this send (its idempotency key is
     *             `campaignId:recipientId`, which is what makes a re-drain
     *             safe rather than a duplicate)
     * `sent` / `failed` / `skipped`
     */
    status: text("status")
      .$type<"pending" | "queued" | "sent" | "skipped" | "failed">()
      .notNull()
      .default("pending"),
    /** e.g. "unsubscribed", "suppressed" — why a recipient was never queued. */
    skipReason: text("skip_reason"),
    /** The engine instanceId, filled after engine.start() returns. */
    instanceId: text("instance_id"),
    emailSendId: text("email_send_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("campaign_recipient_uidx").on(t.campaignId, t.contactId),
    // The drain's query: "next N pending recipients for this campaign".
    index("campaign_recipient_drain_idx")
      .on(t.campaignId, t.status, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index("campaign_recipient_contact_idx").on(t.contactId),
  ],
);

export const campaignRelations = relations(campaign, ({ many, one }) => ({
  recipients: many(campaignRecipient),
  workspace: one(workspace, {
    fields: [campaign.workspaceId],
    references: [workspace.id],
  }),
}));

export const campaignRecipientRelations = relations(campaignRecipient, ({ one }) => ({
  campaign: one(campaign, {
    fields: [campaignRecipient.campaignId],
    references: [campaign.id],
  }),
  contact: one(contact, {
    fields: [campaignRecipient.contactId],
    references: [contact.id],
  }),
}));
