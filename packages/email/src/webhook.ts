import type { Db } from "@loopkit/db";
import { contact, contactEvent, emailDelivery, emailSend } from "@loopkit/db/schema";
import { eq, isNotNull } from "drizzle-orm";

import type { EmailProvider, NormalizedEmailEvent, WebhookRequest } from "./provider";

type HardFailType = "bounced" | "complained";
const HARD_FAIL_TYPES: ReadonlySet<HardFailType> = new Set(["bounced", "complained"]);

function isHardFail(type: NormalizedEmailEvent["type"]): type is HardFailType {
  return HARD_FAIL_TYPES.has(type as HardFailType);
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
 */
export async function processEmailWebhook(
  db: Db,
  provider: EmailProvider,
  request: WebhookRequest,
): Promise<void> {
  const events = await provider.parseWebhook(request);

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
  }
}
