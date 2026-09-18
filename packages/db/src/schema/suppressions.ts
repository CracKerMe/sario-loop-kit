import { relations, sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { contact } from "./contacts";
import { workspace } from "./workspace";

/**
 * Workspace-level "never send to this address again" list — the compliance
 * backstop that `contact.subscribed` alone cannot be.
 *
 * Why both exist, and why neither is redundant:
 *
 *  - `contact.subscribed` is *identity-scoped*. It answers "has this
 *    contact opted out?", which is the right question for the preference
 *    centre and the unsubscribe link, and it is what carries the
 *    resubscribe path (a contact can opt back in).
 *  - `suppression` is *address-scoped and permanent*. A hard bounce means
 *    the mailbox does not exist; a complaint means the recipient pressed
 *    "report spam". Neither is an opt-out a human can reverse, and both
 *    must survive the contact being deleted and re-imported (a list
 *    re-import is how a bounced address usually comes back), because
 *    `contact` rows are disposable while send permission is not.
 *
 * Without this table, a re-imported bounced address is a fresh `contact`
 * with `subscribed = true` — and every send to it is a deliverability
 * and reputation cost. That is the hole this table closes.
 *
 * Reasons:
 *  - `hard_bounce`  — provider reported the address as undeliverable
 *  - `complaint`    — recipient marked the message as spam
 *  - `manual`       — a human added it (legal request, known-bad address)
 *  - `unsubscribe`  — address-level opt-out for an address that is not
 *                     (or is no longer) a loopkit contact — e.g. a
 *                     one-click `List-Unsubscribe` POST for an address
 *                     imported and deleted between campaigns
 */
export const suppression = pgTable(
  "suppression",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    // Stored lowercased (the unique index is on lower(email) too, so mixed
    // case can't mint a second row). Display copy is the caller's problem.
    email: text("email").notNull(),
    reason: text("reason")
      .$type<"hard_bounce" | "complaint" | "manual" | "unsubscribe">()
      .notNull(),
    /** Who/what recorded it: "resend", "manual", "unsubscribe-page", "api". */
    source: text("source"),
    /** Best-effort link back to the contact row, if one existed at the time. */
    contactId: text("contact_id").references(() => contact.id, { onDelete: "set null" }),
    /** The provider message that caused it, for audit ("which send bounced?"). */
    providerMessageId: text("provider_message_id"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Expression index (lower(email)), same shape as contact_ws_email_uidx —
    // so the send-path lookup is a single indexed equality probe.
    uniqueIndex("suppression_ws_email_uidx").on(t.workspaceId, sql`lower(${t.email})`),
    index("suppression_ws_reason_idx").on(t.workspaceId, t.reason, t.createdAt.desc()),
  ],
);

export const suppressionRelations = relations(suppression, ({ one }) => ({
  workspace: one(workspace, {
    fields: [suppression.workspaceId],
    references: [workspace.id],
  }),
  contact: one(contact, {
    fields: [suppression.contactId],
    references: [contact.id],
  }),
}));
