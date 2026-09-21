/**
 * Frequency capping (P1-4) — a per-contact ceiling on marketing sends,
 * independent of and in addition to suppression/unsubscribe.
 *
 * Why this is a real gap without it: a contact can be a member of several
 * audiences and enrolled in several journeys at once, and nothing before
 * this file stopped all of them from firing on the same day. That is a
 * deliverability risk the product's own compliance story (README's "dual
 * gate" section) does not cover — suppression and unsubscribe are about
 * *whether* a contact may be mailed at all, not about *how often* a contact
 * who is perfectly willing gets mailed before they stop being willing.
 *
 * Scope, deliberately narrow: one global (or per-workspace-override) rolling
 * window, checked against `email_send` — the same table, same index
 * (`email_send_contact_idx` on `(contact_id, created_at desc)`) the contact
 * activity page already reads. No new table, no new index.
 */
import type { Db } from "@loopkit/db";
import { emailSend } from "@loopkit/db/schema";
import { and, eq, gte, ne, sql } from "drizzle-orm";

export interface FrequencyCapConfig {
  /** Max marketing sends per contact within `windowHours`. 0/undefined = unlimited. */
  maxPerWindow?: number;
  /** Rolling window size in hours. Default 24. */
  windowHours?: number;
}

export interface FrequencyCapCheck {
  allowed: boolean;
  /** Sends already counted in the current window, for logging/diagnostics. */
  sentInWindow: number;
}

/**
 * Counts this contact's sends in the trailing window and compares against
 * the cap. Counts every row the channel ever inserts for a real attempt —
 * `queued`, `sent`, `delivered`, `bounced`, `complained`, `failed` — because
 * the cap's job is "how many times did we try to reach this inbox", not
 * "how many times did it land".
 *
 * `excludeSendId` matters: the channel inserts the `email_send` row for
 * the send under consideration BEFORE the gate runs (see channel.ts's
 * `send()` — the row must exist first so the idempotency ON CONFLICT has
 * something to conflict against). Without excluding it, checking a cap of
 * N would only ever allow N-1 real sends, because the current attempt's
 * own just-inserted row is already sitting in the count it is being
 * measured against.
 */
export async function checkFrequencyCap(
  db: Db,
  input: {
    workspaceId: string;
    contactId: string;
    config: FrequencyCapConfig;
    excludeSendId?: string;
  },
): Promise<FrequencyCapCheck> {
  const { maxPerWindow, windowHours = 24 } = input.config;
  if (!maxPerWindow || maxPerWindow <= 0) {
    return { allowed: true, sentInWindow: 0 };
  }

  const windowStart = new Date(Date.now() - windowHours * 3_600_000);
  const conditions = [
    eq(emailSend.workspaceId, input.workspaceId),
    eq(emailSend.contactId, input.contactId),
    gte(emailSend.createdAt, windowStart),
  ];
  if (input.excludeSendId) conditions.push(ne(emailSend.id, input.excludeSendId));

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailSend)
    .where(and(...conditions));

  const sentInWindow = Number(row?.count ?? 0);
  return { allowed: sentInWindow < maxPerWindow, sentInWindow };
}
