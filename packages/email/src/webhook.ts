import { addSuppression } from "@loopkit/core";
import type { Db } from "@loopkit/db";
import { contact, contactEvent, emailDelivery, emailSend } from "@loopkit/db/schema";
import { eq, isNotNull } from "drizzle-orm";

import type { EmailProvider, NormalizedEmailEvent, WebhookRequest } from "./provider";

type HardFailType = "bounced" | "complained";
const HARD_FAIL_TYPES: ReadonlySet<HardFailType> = new Set(["bounced", "complained"]);

function isHardFail(type: NormalizedEmailEvent["type"]): type is HardFailType {
  return HARD_FAIL_TYPES.has(type as HardFailType);
}

export interface WebhookContactEvent {
  workspaceId: string;
  contactId: string;
  name: string;
  properties: Record<string, unknown>;
}

/**
 * Processes a provider webhook end to end: verify + parse (via the
 * provider), dedup by providerEventId, update email_send's status
 * lattice (only forward — see emailSend's schema doc comment: events can
 * arrive out of order, e.g. 'opened' before 'delivered'), suppress the
 * contact on a hard failure, and emit a contact_event so journeys can
 * branch on engagement (`email.opened`, `email.clicked`, ...) — this is
 * the differentiator this whole design exists to enable, and it costs
 * one insert.
 *
 * Returns the contact events that were newly recorded, so the caller can
 * wake waitEvent instances (engine eventBus emit) without re-querying.
 */
export async function processEmailWebhook(
  db: Db,
  provider: EmailProvider,
  request: WebhookRequest,
): Promise<WebhookContactEvent[]> {
  const events = await provider.parseWebhook(request);
  const contactEvents: WebhookContactEvent[] = [];

  for (const event of events) {
    const inserted = await db
      .insert(emailDelivery)
      .values({
        id: crypto.randomUUID(),
        // Backfilled below once the matching email_send row is resolved
        // (nullable so an orphan event — no matching send — still gets
        // recorded and deduped rather than failing the whole insert).
        sendId: null,
        type: event.type,
        url: event.url,
        raw: event.raw,
        occurredAt: event.occurredAt,
        providerEventId: event.providerEventId,
      })
      // The unique index this targets (email_delivery_provider_evt_uidx)
      // is partial (WHERE provider_event_id IS NOT NULL) — Postgres
      // requires ON CONFLICT to restate that predicate to match a
      // partial index, or it errors with "no unique or exclusion
      // constraint matching the ON CONFLICT specification".
      .onConflictDoNothing({
        target: emailDelivery.providerEventId,
        where: isNotNull(emailDelivery.providerEventId),
      })
      .returning({ id: emailDelivery.id });

    if (inserted.length === 0) continue; // already processed — replay dedup

    const [send] = await db
      .select({
        id: emailSend.id,
        contactId: emailSend.contactId,
        status: emailSend.status,
        workspaceId: emailSend.workspaceId,
        toEmail: emailSend.toEmail,
      })
      .from(emailSend)
      .where(eq(emailSend.providerMessageId, event.providerMessageId))
      .limit(1);

    if (!send) continue; // event for a send we don't have a record of (e.g. a transactional send outside Loopkit)

    await db
      .update(emailDelivery)
      .set({ sendId: send.id })
      .where(eq(emailDelivery.id, inserted[0]!.id));

    if (isHardFail(event.type)) {
      await db.update(emailSend).set({ status: event.type }).where(eq(emailSend.id, send.id));
      await db
        .update(contact)
        .set({ subscribed: false, unsubscribedAt: new Date() })
        .where(eq(contact.id, send.contactId));

      // The durable half of this reaction: a workspace-level, address-scoped
      // suppression. `contact.subscribed = false` alone is not enough — the
      // contact row is disposable, and a list re-import brings a bounced
      // address back as a fresh, subscribed contact. The address is what
      // actually must never receive mail again.
      //
      // Idempotent and first-write-wins, so a webhook replay, or a
      // complaint arriving after an earlier bounce, cannot rewrite the
      // reason. Neither call throws on a duplicate — this runs inside a
      // webhook handler where a spurious 500 would make the provider retry.
      await addSuppression(db, {
        workspaceId: send.workspaceId,
        email: send.toEmail,
        reason: event.type === "complained" ? "complaint" : "hard_bounce",
        source: provider.name,
        contactId: send.contactId,
        providerMessageId: event.providerMessageId,
      });
    } else if (
      event.type === "delivered" &&
      send.status !== "bounced" &&
      send.status !== "complained"
    ) {
      await db.update(emailSend).set({ status: "delivered" }).where(eq(emailSend.id, send.id));
    }

    await db.insert(contactEvent).values({
      id: crypto.randomUUID(),
      workspaceId: send.workspaceId,
      contactId: send.contactId,
      name: `email.${event.type}`,
      properties: event.url ? { url: event.url } : {},
      occurredAt: event.occurredAt,
    });

    contactEvents.push({
      workspaceId: send.workspaceId,
      contactId: send.contactId,
      name: `email.${event.type}`,
      properties: event.url ? { url: event.url } : {},
    });
  }

  return contactEvents;
}
