import {
  drainCampaign,
  getCampaign,
  launchCampaign,
  listResumableCampaigns,
  refreshCampaignCounters,
  syncCampaignRecipientStatuses,
  type Campaign,
  type StartCampaignSend,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { campaign } from "@loopkit/db/schema";
import { buildCampaignWorkflow, campaignSendContext, campaignWorkflowId } from "@loopkit/engine";
import { eq } from "drizzle-orm";

import { getEngine } from "./loopkitRuntime";

/**
 * Campaign orchestration: the glue between @loopkit/core's campaign state
 * machine and the engine. It lives in the server because it needs both, and
 * neither package may depend on the other.
 *
 * ## Why an in-process drain is acceptable here
 *
 * A broadcast drain that runs on `setTimeout(0)` inside the API process
 * would normally be a scalability smell — a second replica would start a
 * competing drain and double-send. That is precisely the case P0-1's
 * advisory lock makes impossible: `apps/server` refuses to start as a second
 * instance, so "one drain per campaign per database" is guaranteed by
 * construction rather than by a distributed lease.
 *
 * Durability does not depend on this loop surviving either. It only *starts*
 * engine instances; the recipient rows it drains are the queue, and every
 * instance that was already started is durable on its own. If the process
 * dies mid-drain, `resumeInterruptedCampaigns()` at the next boot picks up
 * exactly the `pending` rows that were never started.
 */

/** One drain per campaign at a time, within this process. */
const runningDrains = new Map<string, Promise<void>>();

function startSendFor(engine: NonNullable<ReturnType<typeof getEngine>>): StartCampaignSend {
  return async (input) => {
    const instanceId = await engine.ctx.engine.start(
      campaignWorkflowId(input.campaignId),
      campaignSendContext({
        campaignId: input.campaignId,
        recipientId: input.recipientId,
        contactId: input.contactId,
        email: input.email,
        workspaceId: input.workspaceId,
      }),
    );
    return { instanceId };
  };
}

/**
 * Registers the campaign's workflow definition once, before any instance is
 * started.
 *
 * `engine.register()` persists the definition on every call, so doing this
 * per recipient would write a `wf_workflow_version` row per recipient (10k
 * rows for a 10k broadcast) for an identical definition. Registering once is
 * both cheaper and the honest statement of intent: one workflow, many
 * instances.
 *
 * `persist: true` (the default) is load-bearing, not incidental: it is what
 * lets an in-flight campaign resume after a restart, because the definition
 * has no closures and therefore survives the jsonb round trip.
 */
async function registerCampaignWorkflow(campaign: Campaign): Promise<void> {
  const engine = getEngine();
  if (!engine) throw new Error("engine not ready");

  await engine.ctx.engine.register(
    buildCampaignWorkflow({
      campaignId: campaign.id,
      name: campaign.name,
      templateId: campaign.templateId!,
      subject: campaign.subject ?? undefined,
      preheader: campaign.preheader ?? undefined,
      fromName: campaign.fromName ?? undefined,
      replyTo: campaign.replyTo ?? undefined,
      utm: campaign.utm ?? undefined,
    }),
  );
}

async function runDrain(campaignId: string): Promise<void> {
  const engine = getEngine();
  if (!engine) throw new Error("engine not ready");

  // Loop until the campaign has no pending recipients left. `drainCampaign`
  // already re-reads the campaign's status between batches, so a pause or
  // cancel lands promptly.
  for (;;) {
    const result = await drainCampaign(db, campaignId, startSendFor(engine));
    if (result.remaining === 0) return;
    if (result.status === "paused" || result.status === "cancelled") return;
    // Progress is being made but the campaign is large; keep going rather
    // than returning a partially-drained campaign to the caller.
  }
}

/** Deduplicates concurrent drains of the same campaign within this process. */
function scheduleDrain(campaignId: string): Promise<void> {
  const existing = runningDrains.get(campaignId);
  if (existing) return existing;

  const promise = runDrain(campaignId)
    .catch(async (error) => {
      console.error(`[loopkit] campaign drain failed for ${campaignId}:`, error);
      // `failed` here means *the drain* broke (database gone, engine gone),
      // not that individual sends failed — those are per-recipient. Leaving
      // it as `sending` would make the UI poll forever.
      await db.update(campaign).set({ status: "failed" }).where(eq(campaign.id, campaignId));
    })
    .finally(() => {
      runningDrains.delete(campaignId);
    });

  runningDrains.set(campaignId, promise);
  return promise;
}

export interface StartCampaignResult {
  campaign: Campaign;
  recipients: number;
  excludedUnsendable: number;
}

/**
 * Materializes the audience, registers the workflow, then hands the drain to
 * the background. Returns as soon as the recipient list exists so the HTTP
 * request is bounded by the audience resolution rather than by 10k sends.
 *
 * `await scheduleDrain` is deliberately NOT used: the promise is returned to
 * the caller as fire-and-forget, and the campaign's own status is the
 * progress channel the UI polls.
 */
export async function startCampaign(
  workspaceId: string,
  campaignId: string,
): Promise<StartCampaignResult> {
  const launched = await launchCampaign(db, workspaceId, campaignId);
  await registerCampaignWorkflow(launched.campaign);
  void scheduleDrain(campaignId);
  return launched;
}

/**
 * Re-runs the drain for a campaign that is already materialized — the
 * recovery path after a crash, an interrupted drain, or a pause.
 */
export async function resumeCampaign(
  workspaceId: string,
  campaignId: string,
): Promise<Campaign | null> {
  const campaignRow = await getCampaign(db, workspaceId, campaignId);
  if (!campaignRow) return null;
  await registerCampaignWorkflow(campaignRow);
  void scheduleDrain(campaignId);
  return campaignRow;
}

/**
 * Boot-time recovery: any campaign that was mid-drain when the process died
 * still has `pending` recipient rows, and those rows are the queue. Called
 * once from `main()` after the engine starts.
 *
 * Errors are logged per campaign and swallowed — a campaign that cannot be
 * resumed must not prevent the server from serving.
 */
export async function resumeInterruptedCampaigns(): Promise<number> {
  const campaigns = await listResumableCampaigns(db);
  for (const campaignRow of campaigns) {
    try {
      await registerCampaignWorkflow(campaignRow);
      void scheduleDrain(campaignRow.id);
    } catch (error) {
      console.error(`[loopkit] failed to resume campaign ${campaignRow.id}:`, error);
    }
  }
  if (campaigns.length > 0) {
    console.log(`[loopkit] resumed ${campaigns.length} interrupted campaign(s)`);
  }
  return campaigns.length;
}

/**
 * Reconciliation for a read path: the drain cannot know whether a send
 * succeeded (the engine executes asynchronously), so statuses are derived
 * from `email_send` and the counters rolled up when a report is requested.
 * Cheap — two indexed statements — and it means the UI never has to poll a
 * separate reconcile endpoint to see a campaign finish.
 */
export async function reconcileCampaign(campaignId: string): Promise<void> {
  await syncCampaignRecipientStatuses(db, campaignId);
  await refreshCampaignCounters(db, campaignId);
}
