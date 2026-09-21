import type { Db } from "@loopkit/db";
import { audience, campaign, campaignRecipient } from "@loopkit/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { countAudienceMembers, resolveAudienceContacts } from "./audiences";
import { validateSegmentFilter } from "./segments";

/**
 * Campaign lifecycle and the recipient drain.
 *
 * The drain is deliberately *injected* rather than implemented here:
 * starting an engine instance is the one thing this module cannot do
 * without depending on @loopkit/engine, which depends on @loopkit/core (the
 * dependency must point one way). So the caller supplies `startSend`, and
 * every guarantee that matters — idempotency, retries, DLQ — lives on the
 * other side of that seam, in @loopkit/email's channel and the engine.
 *
 * What lives here is the part that must be correct regardless of the
 * transport: what gets materialized, in what order, with what status, and
 * how a crash or a double-click is made harmless.
 */

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "paused"
  | "cancelled"
  | "failed";

export type CampaignRecipientStatus = "pending" | "queued" | "sent" | "skipped" | "failed";

export interface Campaign {
  id: string;
  workspaceId: string;
  name: string;
  status: CampaignStatus;
  templateId: string | null;
  audienceId: string | null;
  filter: unknown;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  preheader: string | null;
  utm: { source?: string; medium?: string; campaign?: string } | null;
  audienceMemberCount: number | null;
  audienceSendableCount: number | null;
  /** When a `scheduled` campaign should start draining. Null otherwise. */
  scheduledAt: Date | null;
  recipientCount: number;
  queuedCount: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  launchedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignRecipient {
  id: string;
  campaignId: string;
  workspaceId: string;
  contactId: string;
  email: string;
  status: CampaignRecipientStatus;
  skipReason: string | null;
  instanceId: string | null;
  emailSendId: string | null;
  error: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

/** How many recipients one drain pass takes on. */
export const CAMPAIGN_DRAIN_BATCH = 100;

/** Rows per INSERT when materializing an audience. */
const MATERIALIZE_CHUNK = 500;

export interface CreateCampaignInput {
  workspaceId: string;
  name: string;
  templateId?: string;
  audienceId?: string;
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  preheader?: string;
  utm?: { source?: string; medium?: string; campaign?: string };
  createdBy?: string;
}

export interface UpdateCampaignInput {
  name?: string;
  templateId?: string | null;
  audienceId?: string | null;
  subject?: string | null;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  preheader?: string | null;
  utm?: { source?: string; medium?: string; campaign?: string } | null;
}

export class CampaignStateError extends Error {}

export async function createCampaign(db: Db, input: CreateCampaignInput): Promise<Campaign> {
  const [row] = await db
    .insert(campaign)
    .values({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      templateId: input.templateId ?? null,
      audienceId: input.audienceId ?? null,
      subject: input.subject ?? null,
      fromName: input.fromName ?? null,
      fromEmail: input.fromEmail ?? null,
      replyTo: input.replyTo ?? null,
      preheader: input.preheader ?? null,
      utm: input.utm ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row as Campaign;
}

export async function getCampaign(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<Campaign | null> {
  const [row] = await db
    .select()
    .from(campaign)
    .where(and(eq(campaign.workspaceId, workspaceId), eq(campaign.id, id)))
    .limit(1);
  return (row as Campaign | undefined) ?? null;
}

export async function listCampaigns(db: Db, workspaceId: string): Promise<Campaign[]> {
  const rows = await db
    .select()
    .from(campaign)
    .where(eq(campaign.workspaceId, workspaceId))
    .orderBy(desc(campaign.createdAt));
  return rows as Campaign[];
}

export async function updateCampaign(
  db: Db,
  workspaceId: string,
  id: string,
  patch: UpdateCampaignInput,
): Promise<Campaign | null> {
  const existing = await getCampaign(db, workspaceId, id);
  if (!existing) return null;

  // Editing the composition of a campaign that has already fanned out would
  // make its own report a lie — some recipients got the old subject, some
  // the new. Duplicate it instead.
  if (existing.status !== "draft") {
    throw new CampaignStateError(
      `campaign is ${existing.status}; only a draft can be edited. Duplicate it to make changes.`,
    );
  }

  const [row] = await db
    .update(campaign)
    .set(patch)
    .where(and(eq(campaign.workspaceId, workspaceId), eq(campaign.id, id)))
    .returning();
  return (row as Campaign | undefined) ?? null;
}

export async function deleteCampaign(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const existing = await getCampaign(db, workspaceId, id);
  if (!existing) return false;
  if (existing.status === "sending") {
    throw new CampaignStateError(
      "cannot delete a campaign while it is sending — pause or cancel it",
    );
  }
  const rows = await db
    .delete(campaign)
    .where(and(eq(campaign.workspaceId, workspaceId), eq(campaign.id, id)))
    .returning({ id: campaign.id });
  return rows.length > 0;
}

/** Duplicating a sent campaign is the normal "send it again to a new segment" flow. */
export async function duplicateCampaign(
  db: Db,
  workspaceId: string,
  id: string,
  name?: string,
): Promise<Campaign | null> {
  const source = await getCampaign(db, workspaceId, id);
  if (!source) return null;

  return createCampaign(db, {
    workspaceId,
    name: name ?? `${source.name} (copy)`,
    templateId: source.templateId ?? undefined,
    audienceId: source.audienceId ?? undefined,
    subject: source.subject ?? undefined,
    fromName: source.fromName ?? undefined,
    fromEmail: source.fromEmail ?? undefined,
    replyTo: source.replyTo ?? undefined,
    preheader: source.preheader ?? undefined,
    utm: source.utm ?? undefined,
    createdBy: source.createdBy ?? undefined,
  });
}

interface MaterializeResult {
  campaign: Campaign;
  recipients: number;
  excludedUnsendable: number;
}

/**
 * Resolves the audience, freezes the filter onto the campaign, and
 * materializes the recipient list — the O(N) part that must happen exactly
 * once. Shared by `launchCampaign` (send now) and `scheduleCampaign` (send
 * later): both freeze the audience at the moment the operator committed to
 * a send, not at drain time, which is what makes a campaign's own report an
 * honest historical record instead of a live query (see `campaign.filter`'s
 * doc comment).
 *
 * `finalStatus` is the only thing that differs between the two callers —
 * `launchCampaign` lands on `queued` (drain starts immediately after),
 * `scheduleCampaign` lands on `scheduled` (drain starts when the scheduler
 * poller finds `scheduledAt` due).
 */
async function materializeCampaign(
  db: Db,
  workspaceId: string,
  id: string,
  finalStatus: "queued" | "scheduled",
  scheduledAt?: Date,
): Promise<MaterializeResult> {
  const existing = await getCampaign(db, workspaceId, id);
  if (!existing) throw new CampaignStateError(`campaign not found: ${id}`);
  if (existing.status === "sending") {
    throw new CampaignStateError("campaign is already sending");
  }
  if (existing.status === "sent" || existing.status === "cancelled") {
    throw new CampaignStateError(
      `campaign is ${existing.status}; duplicate it to send again rather than re-running this one`,
    );
  }
  if (!existing.templateId) throw new CampaignStateError("campaign has no template");

  // Frozen filter: the campaign's own snapshot if it has one, otherwise a
  // copy taken from the audience right now.
  let filter = existing.filter;
  if (filter === null || filter === undefined) {
    if (!existing.audienceId) throw new CampaignStateError("campaign has no audience");
    const [source] = await db
      .select({ filter: audience.filter })
      .from(audience)
      .where(and(eq(audience.workspaceId, workspaceId), eq(audience.id, existing.audienceId)))
      .limit(1);
    if (!source) throw new CampaignStateError(`audience not found: ${existing.audienceId}`);
    filter = source.filter;
  }

  const validation = validateSegmentFilter(filter);
  if (!validation.ok) {
    throw new CampaignStateError(`campaign filter is invalid: ${validation.errors.join("; ")}`);
  }

  const counts = await countAudienceMembers(db, { workspaceId, filter });
  const resolved = await resolveAudienceContacts(db, {
    workspaceId,
    filter,
    // Sendability filtering happens here, at materialization, rather than
    // only inside the email channel — so the campaign report can say
    // "excluded 42" instead of silently doing nothing for 42 people.
  });

  let inserted = 0;
  for (let i = 0; i < resolved.contacts.length; i += MATERIALIZE_CHUNK) {
    const chunk = resolved.contacts.slice(i, i + MATERIALIZE_CHUNK);
    const rows = await db
      .insert(campaignRecipient)
      .values(
        chunk.map((contact) => ({
          id: crypto.randomUUID(),
          campaignId: id,
          workspaceId,
          contactId: contact.id,
          email: contact.email,
        })),
      )
      // A resumed or double-clicked launch must not double-materialize —
      // the unique (campaignId, contactId) index is the guard, and this is
      // the same ON CONFLICT DO NOTHING pattern the rest of the codebase
      // uses over at-least-once callers.
      .onConflictDoNothing({ target: [campaignRecipient.campaignId, campaignRecipient.contactId] })
      .returning({ id: campaignRecipient.id });
    inserted += rows.length;
  }

  const [{ count: recipientCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignRecipient)
    .where(eq(campaignRecipient.campaignId, id));

  const [updated] = await db
    .update(campaign)
    .set({
      filter,
      status: finalStatus,
      audienceMemberCount: counts.memberCount,
      audienceSendableCount: counts.sendableCount,
      recipientCount,
      // `launchedAt` marks "resolved and committed", which is true for a
      // scheduled campaign too — it just hasn't drained yet. Only `queued`
      // additionally means "the drain may start right now".
      launchedAt: existing.launchedAt ?? new Date(),
      scheduledAt: finalStatus === "scheduled" ? (scheduledAt ?? null) : null,
    })
    .where(eq(campaign.id, id))
    .returning();

  return {
    campaign: updated as Campaign,
    recipients: inserted,
    excludedUnsendable: Math.max(0, counts.memberCount - counts.sendableCount),
  };
}

/**
 * Resolves the audience and materializes the recipient list, landing on
 * `queued` — the drain should start right after this returns.
 */
export async function launchCampaign(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<MaterializeResult> {
  return materializeCampaign(db, workspaceId, id, "queued");
}

/**
 * Materializes the recipient list now (same freeze-at-commit semantics as
 * `launchCampaign`) but lands on `scheduled` instead of `queued` — the
 * drain does not start until the scheduler poller (apps/server's
 * campaignRunner.ts) finds this campaign due and calls
 * `fireCampaignSchedule`.
 *
 * Materializing now rather than at fire time is deliberate: it surfaces a
 * broken template or an empty audience immediately, while the operator can
 * still fix it, instead of failing silently at 3am when nobody is watching.
 */
export async function scheduleCampaign(
  db: Db,
  workspaceId: string,
  id: string,
  scheduledAt: Date,
): Promise<MaterializeResult> {
  if (scheduledAt.getTime() <= Date.now()) {
    throw new CampaignStateError("scheduledAt must be in the future");
  }
  return materializeCampaign(db, workspaceId, id, "scheduled", scheduledAt);
}

/**
 * Reverts a `scheduled` campaign back to `draft` — "I want to change the
 * time or the content", not "I never want to send this". The recipient
 * rows materialized by `scheduleCampaign` are left in place (harmless,
 * `pending`) and will be replaced by the next `launchCampaign` /
 * `scheduleCampaign` call's `ON CONFLICT DO NOTHING` re-materialization.
 * `cancel` (via `setCampaignStatus`) remains the "abandon it" path.
 */
export async function unscheduleCampaign(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<Campaign | null> {
  const existing = await getCampaign(db, workspaceId, id);
  if (!existing) return null;
  if (existing.status !== "scheduled") {
    throw new CampaignStateError(`cannot unschedule a ${existing.status} campaign`);
  }
  const [row] = await db
    .update(campaign)
    .set({ status: "draft", scheduledAt: null })
    .where(and(eq(campaign.workspaceId, workspaceId), eq(campaign.id, id)))
    .returning();
  return (row as Campaign | undefined) ?? null;
}

/**
 * Promotes a due `scheduled` campaign to `queued` — the lightweight half of
 * what `launchCampaign` does. Deliberately does NOT re-run
 * `materializeCampaign`: the audience was already resolved and frozen when
 * the campaign was scheduled, and re-resolving here would silently change
 * who a "scheduled to this list" send actually reaches if the saved
 * audience changed in the meantime. The caller (apps/server's
 * campaignRunner.ts) still owns registering the engine workflow and
 * starting the drain — this only flips the status the drain looks for.
 */
export async function fireCampaignSchedule(db: Db, id: string): Promise<Campaign | null> {
  const [row] = await db
    .update(campaign)
    .set({ status: "queued", scheduledAt: null })
    .where(and(eq(campaign.id, id), eq(campaign.status, "scheduled")))
    .returning();
  return (row as Campaign | undefined) ?? null;
}

/**
 * Scheduled campaigns whose time has come, oldest first. The scheduler
 * poller's whole query — see apps/server's campaignRunner.ts. Single
 * process (the advisory lock in apps/server's instanceLock.ts guarantees
 * that), so no SKIP LOCKED claiming is needed; a plain SELECT is enough and
 * keeps this readable.
 */
export async function listDueCampaigns(
  db: Db,
  limit = 20,
): Promise<{ id: string; workspaceId: string }[]> {
  return db
    .select({ id: campaign.id, workspaceId: campaign.workspaceId })
    .from(campaign)
    .where(and(eq(campaign.status, "scheduled"), sql`${campaign.scheduledAt} <= now()`))
    .orderBy(campaign.scheduledAt)
    .limit(limit);
}

/**
 * Starts one engine instance per still-pending recipient, in bounded
 * batches.
 *
 * Idempotent by construction, which is what makes it safe to call again
 * after a crash or a double-click:
 *
 *  - Only `pending` rows are picked up, and a row leaves `pending` as soon
 *    as it has an instanceId.
 *  - Even if a row were somehow picked up twice, the email channel's
 *    `(campaignId, recipientId)` idempotency key means the second attempt
 *    sends nothing.
 *
 * Re-reads the campaign's status between batches so a pause or cancel takes
 * effect promptly instead of after the whole list has been fanned out.
 */
export async function drainCampaign(
  db: Db,
  campaignId: string,
  startSend: StartCampaignSend,
  options: { batchSize?: number } = {},
): Promise<{ queued: number; failed: number; remaining: number; status: CampaignStatus }> {
  const batchSize = Math.max(1, options.batchSize ?? CAMPAIGN_DRAIN_BATCH);

  const [initial] = await db.select().from(campaign).where(eq(campaign.id, campaignId)).limit(1);
  if (!initial) throw new CampaignStateError(`campaign not found: ${campaignId}`);
  const campaignRow = initial as Campaign;

  if (campaignRow.status === "paused" || campaignRow.status === "cancelled") {
    return {
      queued: 0,
      failed: 0,
      remaining: await countPending(db, campaignId),
      status: campaignRow.status,
    };
  }
  if (campaignRow.status === "sent") {
    return { queued: 0, failed: 0, remaining: 0, status: "sent" };
  }

  await db.update(campaign).set({ status: "sending" }).where(eq(campaign.id, campaignId));

  let queued = 0;
  let failed = 0;

  for (;;) {
    const [current] = await db
      .select({ status: campaign.status })
      .from(campaign)
      .where(eq(campaign.id, campaignId))
      .limit(1);
    if (!current || current.status === "paused" || current.status === "cancelled") break;

    const batch = await db
      .select()
      .from(campaignRecipient)
      .where(
        and(eq(campaignRecipient.campaignId, campaignId), eq(campaignRecipient.status, "pending")),
      )
      .orderBy(campaignRecipient.createdAt)
      .limit(batchSize);

    if (batch.length === 0) break;

    for (const recipient of batch) {
      try {
        const { instanceId } = await startSend({
          campaignId,
          recipientId: recipient.id,
          contactId: recipient.contactId,
          email: recipient.email,
          workspaceId: recipient.workspaceId,
          templateId: campaignRow.templateId!,
          subject: campaignRow.subject ?? undefined,
          preheader: campaignRow.preheader ?? undefined,
          fromName: campaignRow.fromName ?? undefined,
          replyTo: campaignRow.replyTo ?? undefined,
          utm: campaignRow.utm ?? undefined,
        });
        await db
          .update(campaignRecipient)
          .set({ status: "queued", instanceId })
          .where(eq(campaignRecipient.id, recipient.id));
        queued++;
      } catch (error) {
        // A failure to *start* the instance is per-recipient, not fatal to
        // the campaign — one bad row must not strand the other 9,999.
        await db
          .update(campaignRecipient)
          .set({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          })
          .where(eq(campaignRecipient.id, recipient.id));
        failed++;
      }
    }
  }

  // Derive terminal states from what actually happened, then roll up.
  await syncCampaignRecipientStatuses(db, campaignId);
  const remaining = await countPending(db, campaignId);
  const status = await finalizeCampaign(db, campaignId, remaining);
  await refreshCampaignCounters(db, campaignId);

  return { queued, failed, remaining, status };
}

export interface StartCampaignSend {
  (input: {
    campaignId: string;
    recipientId: string;
    contactId: string;
    email: string;
    workspaceId: string;
    templateId: string;
    subject?: string;
    preheader?: string;
    fromName?: string;
    replyTo?: string;
    utm?: { source?: string; medium?: string; campaign?: string };
  }): Promise<{ instanceId: string }>;
}

async function countPending(db: Db, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignRecipient)
    .where(
      and(eq(campaignRecipient.campaignId, campaignId), eq(campaignRecipient.status, "pending")),
    );
  return row?.count ?? 0;
}

/**
 * Derives each recipient's terminal status from its own `email_send` row.
 *
 * `engine.start()` returns as soon as the instance is created — the send
 * itself happens asynchronously — so the drain genuinely cannot know
 * whether a recipient succeeded. Rather than guess, or poll instance state,
 * this joins the send record: the recipient's row mirrors the send's own
 * status lattice, which is the only source that knows.
 *
 * The join is `email_send.node_id = campaign_recipient.id`, because the
 * campaign workflow sets its notification node's id to `{{ recipientId }}`.
 */
export async function syncCampaignRecipientStatuses(db: Db, campaignId: string): Promise<number> {
  const result = await db.execute(sql`
    UPDATE campaign_recipient r
    SET status = CASE
          WHEN s.status IN ('sent', 'delivered') THEN 'sent'
          WHEN s.status IN ('failed', 'bounced', 'complained') THEN 'failed'
          ELSE r.status
        END,
        email_send_id = s.id,
        sent_at = s.sent_at,
        error = s.error
    FROM email_send s
    WHERE s.campaign_id = r.campaign_id
      AND s.node_id = r.id
      AND r.campaign_id = ${campaignId}
      AND r.status IN ('pending', 'queued')
  `);
  return result.rowCount ?? 0;
}

export async function refreshCampaignCounters(db: Db, campaignId: string): Promise<void> {
  const rows = await db
    .select({ status: campaignRecipient.status, count: sql<number>`count(*)::int` })
    .from(campaignRecipient)
    .where(eq(campaignRecipient.campaignId, campaignId))
    .groupBy(campaignRecipient.status);

  const counts: Record<CampaignRecipientStatus, number> = {
    pending: 0,
    queued: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  for (const row of rows) counts[row.status] = row.count;

  await db
    .update(campaign)
    .set({
      recipientCount: Object.values(counts).reduce((a, b) => a + b, 0),
      queuedCount: counts.queued,
      sentCount: counts.sent,
      skippedCount: counts.skipped,
      failedCount: counts.failed,
    })
    .where(eq(campaign.id, campaignId));
}

/**
 * Promotes the campaign to `sent` only when every recipient has reached a
 * terminal state AND no send is still in flight. A campaign whose last
 * recipient was *started* is not the same as one that finished, and calling
 * it "sent" early is how a report ends up disagreeing with the send log.
 *
 * Exported so a read path can reconcile: a campaign's last send completes
 * asynchronously, long after the drain returned, so the only reliable way to
 * flip it to `sent` is a reconciliation pass. The report endpoint runs one;
 * there is no background timer, because a campaign sitting in `sending` for
 * a few extra seconds is harmless while a polling loop that fights the
 * drain is not.
 */
export async function finalizeCampaign(
  db: Db,
  campaignId: string,
  pending: number,
): Promise<CampaignStatus> {
  const [current] = await db
    .select({ status: campaign.status })
    .from(campaign)
    .where(eq(campaign.id, campaignId))
    .limit(1);
  if (!current) throw new CampaignStateError(`campaign not found: ${campaignId}`);

  // Reconciliation must never overwrite an operator decision. A paused
  // campaign whose already-started sends have all finished is still paused
  // — there are pending recipients it has not sent to, and relabelling it
  // `sent` would make the report claim a broadcast completed that was
  // deliberately stopped halfway.
  if (
    current.status === "paused" ||
    current.status === "cancelled" ||
    current.status === "failed"
  ) {
    return current.status;
  }

  const rows = await db
    .select({ status: campaignRecipient.status, count: sql<number>`count(*)::int` })
    .from(campaignRecipient)
    .where(eq(campaignRecipient.campaignId, campaignId))
    .groupBy(campaignRecipient.status);

  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = row.count;

  const inFlight = (byStatus.queued ?? 0) + (byStatus.pending ?? 0);
  const terminal = (byStatus.sent ?? 0) + (byStatus.failed ?? 0) + (byStatus.skipped ?? 0);

  if (inFlight === 0 && terminal > 0) {
    await db
      .update(campaign)
      .set({ status: "sent", completedAt: new Date() })
      .where(eq(campaign.id, campaignId));
    return "sent";
  }
  if (inFlight === 0 && terminal === 0 && pending === 0) {
    // An empty audience is a legitimate outcome, not a failure, but it is
    // not a send either — surfaced as "sent" with zero counts so the
    // operator sees the campaign complete rather than stuck.
    await db
      .update(campaign)
      .set({ status: "sent", completedAt: new Date() })
      .where(eq(campaign.id, campaignId));
    return "sent";
  }
  return "sending";
}

/**
 * Pause or cancel a live campaign.
 *
 * Cancelling is allowed from `paused` as well as from a live state, because
 * that is the actual decision sequence: pause to stop the bleed, look at
 * what went out, then abandon the rest. Requiring an un-pause first would be
 * a state-machine rule with no product meaning behind it.
 */
export async function setCampaignStatus(
  db: Db,
  workspaceId: string,
  id: string,
  status: "paused" | "cancelled",
): Promise<Campaign | null> {
  const existing = await getCampaign(db, workspaceId, id);
  if (!existing) return null;

  const liveForPause = existing.status === "sending" || existing.status === "queued";
  // `scheduled` can only be cancelled, not paused — "pause" means "stop an
  // in-flight drain", and a scheduled campaign hasn't started draining yet
  // (unscheduleCampaign is the right verb for "not now", cancel for "never").
  const canChange =
    status === "paused"
      ? liveForPause
      : liveForPause || existing.status === "paused" || existing.status === "scheduled";
  if (!canChange) {
    const verb = status === "paused" ? "pause" : "cancel";
    throw new CampaignStateError(`cannot ${verb} a ${existing.status} campaign`);
  }

  const [row] = await db
    .update(campaign)
    .set(status === "paused" ? { status } : { status, completedAt: new Date() })
    .where(and(eq(campaign.workspaceId, workspaceId), eq(campaign.id, id)))
    .returning();
  return (row as Campaign | undefined) ?? null;
}

/** Flips a paused campaign back to `queued` so the drain will pick it up. */
export async function requeuePausedCampaign(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<Campaign | null> {
  const existing = await getCampaign(db, workspaceId, id);
  if (!existing) return null;
  if (existing.status !== "paused" && existing.status !== "failed") {
    throw new CampaignStateError(`cannot resume a ${existing.status} campaign`);
  }
  const [row] = await db
    .update(campaign)
    .set({ status: "queued" })
    .where(and(eq(campaign.workspaceId, workspaceId), eq(campaign.id, id)))
    .returning();
  return (row as Campaign | undefined) ?? null;
}

export interface CampaignStats {
  recipients: number;
  pending: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  /** From `email_send` — what the provider actually accepted. */
  providerAccepted: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
}

/**
 * Send + engagement report. Deliberately two sources joined on purpose:
 * `campaign_recipient` knows our intent (who we meant to send to) and
 * `email_send` / `email_delivery` know what the provider did. Reporting only
 * the former would overstate delivery; only the latter would hide the
 * recipients we skipped.
 */
export async function getCampaignStats(db: Db, campaignId: string): Promise<CampaignStats> {
  const recipientRows = await db
    .select({ status: campaignRecipient.status, count: sql<number>`count(*)::int` })
    .from(campaignRecipient)
    .where(eq(campaignRecipient.campaignId, campaignId))
    .groupBy(campaignRecipient.status);

  const byStatus: Record<string, number> = {};
  for (const row of recipientRows) byStatus[row.status] = row.count;

  const sendRows = await db.execute<{
    status: string;
    count: number;
  }>(sql`
    SELECT s.status, count(*)::int AS count
    FROM email_send s
    WHERE s.campaign_id = ${campaignId}
    GROUP BY s.status
  `);

  const deliveryRows = await db.execute<{ type: string; count: number }>(sql`
    SELECT d.type, count(DISTINCT d.id)::int AS count
    FROM email_delivery d
    JOIN email_send s ON s.id = d.send_id
    WHERE s.campaign_id = ${campaignId}
    GROUP BY d.type
  `);

  const sends: Record<string, number> = {};
  for (const row of sendRows.rows) sends[row.status] = Number(row.count);
  const deliveries: Record<string, number> = {};
  for (const row of deliveryRows.rows) deliveries[row.type] = Number(row.count);

  return {
    recipients: Object.values(byStatus).reduce((a, b) => a + b, 0),
    pending: byStatus.pending ?? 0,
    queued: byStatus.queued ?? 0,
    sent: byStatus.sent ?? 0,
    failed: byStatus.failed ?? 0,
    skipped: byStatus.skipped ?? 0,
    providerAccepted: (sends.sent ?? 0) + (sends.delivered ?? 0),
    delivered: deliveries.delivered ?? 0,
    opened: deliveries.opened ?? 0,
    clicked: deliveries.clicked ?? 0,
    bounced: deliveries.bounced ?? 0,
    complained: deliveries.complained ?? 0,
  };
}

export interface ListCampaignRecipientsInput {
  campaignId: string;
  status?: CampaignRecipientStatus;
  page?: number;
  pageSize?: number;
}

export async function listCampaignRecipients(
  db: Db,
  input: ListCampaignRecipientsInput,
): Promise<{ recipients: CampaignRecipient[]; total: number }> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, input.pageSize ?? 50));
  const conditions = [eq(campaignRecipient.campaignId, input.campaignId)];
  if (input.status) conditions.push(eq(campaignRecipient.status, input.status));
  const where = and(...conditions)!;

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(campaignRecipient)
      .where(where)
      .orderBy(campaignRecipient.createdAt)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(campaignRecipient)
      .where(where),
  ]);

  return { recipients: rows as CampaignRecipient[], total: countRow?.count ?? 0 };
}

/**
 * Recovery path for a campaign whose drain was interrupted (process killed
 * mid-fan-out). Returns every non-terminal campaign so the caller can
 * re-drain it — the pending rows are the queue, so nothing is lost.
 */
export async function listResumableCampaigns(db: Db, workspaceId?: string): Promise<Campaign[]> {
  const conditions = [inArray(campaign.status, ["queued", "sending"] as const)];
  if (workspaceId) conditions.push(eq(campaign.workspaceId, workspaceId));
  const rows = await db
    .select()
    .from(campaign)
    .where(and(...conditions))
    .orderBy(campaign.createdAt);
  return rows as Campaign[];
}
