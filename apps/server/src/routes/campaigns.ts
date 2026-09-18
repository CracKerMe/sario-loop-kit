import {
  CampaignStateError,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  finalizeCampaign,
  getCampaign,
  getCampaignStats,
  listCampaignRecipients,
  listCampaigns,
  requeuePausedCampaign,
  setCampaignStatus,
  updateCampaign,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { Hono } from "hono";
import { z } from "zod";

import { reconcileCampaign, resumeCampaign, startCampaign } from "../campaignRunner";
import type { AuthVariables } from "../middleware/auth";

/**
 * Campaign surface. Session-only: a broadcast is not something an ingestion
 * API key should be able to trigger, and there is no per-key send scope that
 * would make that safe.
 *
 * The lifecycle endpoints are separated deliberately rather than collapsed
 * into one `POST /send`:
 *
 *  - `POST /:id/launch` — resolve + materialize the audience (idempotent),
 *    then drain. Bounded by audience resolution.
 *  - `POST /:id/resume` — re-drain an already-materialized campaign.
 *  - `POST /:id/pause` / `/:id/cancel` — stop between batches.
 *
 * Resumability is a property of how the recipient rows are stored, not an
 * API convenience: a killed process leaves `pending` rows behind, and
 * `resume` re-drains exactly those.
 */

const utmSchema = z.object({
  source: z.string().optional(),
  medium: z.string().optional(),
  campaign: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  templateId: z.string().min(1),
  audienceId: z.string().min(1),
  subject: z.string().max(500).optional(),
  fromName: z.string().max(200).optional(),
  fromEmail: z.string().email().optional(),
  replyTo: z.string().email().optional(),
  preheader: z.string().max(500).optional(),
  utm: utmSchema.optional(),
});

const updateSchema = createSchema.partial();

const duplicateSchema = z.object({ name: z.string().min(1).max(200).optional() });

const recipientsQuerySchema = z.object({
  status: z.enum(["pending", "queued", "sent", "skipped", "failed"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
});

/** A lifecycle violation is a 409 (right token, wrong state), not a 400. */
function stateError(c: { json: (body: unknown, status: 409) => Response }, error: unknown) {
  if (error instanceof CampaignStateError) {
    return c.json({ error: "invalid_campaign_state", message: error.message }, 409);
  }
  throw error;
}

export const campaignsRouter = new Hono<{ Variables: AuthVariables }>();

campaignsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const campaigns = await listCampaigns(db, workspaceId);
  return c.json({ campaigns, total: campaigns.length });
});

campaignsRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const auth = c.get("auth");
  const created = await createCampaign(db, {
    workspaceId,
    ...parsed.data,
    createdBy: auth.kind === "session" ? auth.userId : auth.keyId,
  });
  return c.json({ campaign: created }, 201);
});

campaignsRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const campaign = await getCampaign(db, workspaceId, c.req.param("id"));
  if (!campaign) return c.json({ error: "not_found" }, 404);

  // Reconcile on read: send outcomes land asynchronously after the drain
  // returns, so a campaign only becomes `sent` when someone asks about it.
  // Cheap (two indexed statements) and it saves the client from polling a
  // separate endpoint just to watch a counter move.
  if (campaign.status === "sending" || campaign.status === "queued") {
    await reconcileCampaign(campaign.id);
    const refreshed = await getCampaign(db, workspaceId, campaign.id);
    const [finalized, stats] = await Promise.all([
      finalizeCampaign(db, campaign.id, 0),
      getCampaignStats(db, campaign.id),
    ]);
    return c.json({
      campaign: { ...(refreshed ?? campaign), status: finalized },
      stats,
    });
  }

  const stats = await getCampaignStats(db, campaign.id);
  return c.json({ campaign, stats });
});

campaignsRouter.put("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  try {
    const updated = await updateCampaign(db, workspaceId, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({ campaign: updated });
  } catch (error) {
    return stateError(c, error);
  }
});

campaignsRouter.delete("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  try {
    const removed = await deleteCampaign(db, workspaceId, c.req.param("id"));
    if (!removed) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return stateError(c, error);
  }
});

campaignsRouter.post("/:id/duplicate", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = duplicateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const copy = await duplicateCampaign(db, workspaceId, c.req.param("id"), parsed.data.name);
  if (!copy) return c.json({ error: "not_found" }, 404);
  return c.json({ campaign: copy }, 201);
});

/** Resolve + materialize the audience, register the workflow, start draining. */
campaignsRouter.post("/:id/launch", async (c) => {
  const { workspaceId } = c.get("auth");
  try {
    const result = await startCampaign(workspaceId, c.req.param("id"));
    return c.json(result);
  } catch (error) {
    return stateError(c, error);
  }
});

/** Re-drain a materialized campaign — the crash-recovery and un-pause path. */
campaignsRouter.post("/:id/resume", async (c) => {
  const { workspaceId } = c.get("auth");
  try {
    const campaignRow = await getCampaign(db, workspaceId, c.req.param("id"));
    if (!campaignRow) return c.json({ error: "not_found" }, 404);
    // A paused campaign must be flipped back to queued first, or the drain
    // would immediately see `paused` and return without doing anything.
    if (campaignRow.status === "paused") {
      await requeuePausedCampaign(db, workspaceId, campaignRow.id);
    }
    const resumed = await resumeCampaign(workspaceId, campaignRow.id);
    return c.json({ campaign: resumed });
  } catch (error) {
    return stateError(c, error);
  }
});

campaignsRouter.post("/:id/pause", async (c) => {
  const { workspaceId } = c.get("auth");
  try {
    const paused = await setCampaignStatus(db, workspaceId, c.req.param("id"), "paused");
    if (!paused) return c.json({ error: "not_found" }, 404);
    return c.json({ campaign: paused });
  } catch (error) {
    return stateError(c, error);
  }
});

campaignsRouter.post("/:id/cancel", async (c) => {
  const { workspaceId } = c.get("auth");
  try {
    const cancelled = await setCampaignStatus(db, workspaceId, c.req.param("id"), "cancelled");
    if (!cancelled) return c.json({ error: "not_found" }, 404);
    return c.json({ campaign: cancelled });
  } catch (error) {
    return stateError(c, error);
  }
});

campaignsRouter.get("/:id/recipients", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = recipientsQuerySchema.safeParse(c.req.query());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const campaignRow = await getCampaign(db, workspaceId, c.req.param("id"));
  if (!campaignRow) return c.json({ error: "not_found" }, 404);

  // Fresh send outcomes before listing so the status column isn't stale.
  await reconcileCampaign(campaignRow.id);
  const { recipients, total } = await listCampaignRecipients(db, {
    campaignId: campaignRow.id,
    status: parsed.data.status,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });
  return c.json({ recipients, total });
});
