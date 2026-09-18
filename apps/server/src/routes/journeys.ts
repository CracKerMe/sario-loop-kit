import {
  createJourneyDraft,
  getDashboardStats,
  getJourneyDetail,
  getSuppression,
  listDeadLetters,
  listJourneyRuns,
  listNodeFunnel,
  publishJourney,
  searchInstances,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { contact, emailTemplate, journey, journeyRun, journeyVersion } from "@loopkit/db/schema";
import { renderTemplate } from "@loopkit/email";
import { dryRunJourney, validateGraph, type JourneyGraph } from "@loopkit/journey";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";
import { getEngine } from "../loopkitRuntime";

const graphSchema = z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) });
const createJourneySchema = z.object({ name: z.string().min(1), graph: graphSchema });

export const journeysRouter = new Hono<{ Variables: AuthVariables }>();

journeysRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const rows = await db
    .select()
    .from(journey)
    .where(eq(journey.workspaceId, workspaceId))
    .orderBy(desc(journey.updatedAt));
  return c.json({ journeys: rows });
});

journeysRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = createJourneySchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const validation = validateGraph(parsed.data.graph as JourneyGraph);
  const { journeyId } = await createJourneyDraft(db, {
    workspaceId,
    name: parsed.data.name,
    graph: parsed.data.graph as JourneyGraph,
  });

  return c.json({ journeyId, validation }, 201);
});

journeysRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const detail = await getJourneyDetail(db, workspaceId, c.req.param("id"));
  if (!detail) return c.json({ error: "not_found" }, 404);
  return c.json({
    journey: detail.journey,
    graph: detail.graph,
    version: detail.version,
    runCounts: detail.runCounts,
    validation: detail.graph ? validateGraph(detail.graph) : null,
  });
});

journeysRouter.put("/:id/draft", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = z.object({ graph: graphSchema }).safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  const validation = validateGraph(parsed.data.graph as JourneyGraph);

  const [latest] = await db
    .select({ version: journeyVersion.version })
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;

  await db
    .insert(journeyVersion)
    .values({ journeyId, version: nextVersion, graph: parsed.data.graph, compiled: {} });

  // Keep trigger/reentry in sync with the graph's trigger node.
  const triggerNode = parsed.data.graph.nodes?.find(
    (n: { type?: string }) => n.type === "trigger",
  ) as { data?: { trigger?: unknown } } | undefined;
  if (triggerNode?.data?.trigger) {
    await db
      .update(journey)
      .set({ trigger: triggerNode.data.trigger, updatedAt: new Date() })
      .where(eq(journey.id, journeyId));
  }

  return c.json({ version: nextVersion, validation });
});

journeysRouter.post("/:id/dry-run", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = z
    .object({ contactId: z.string().min(1), stopAfterNode: z.string().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [j] = await db
    .select({ id: journey.id, workspaceId: journey.workspaceId, name: journey.name })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  // Publish preview targets the LATEST version graph — the draft the
  // builder is about to publish — not the currently-published compile.
  const [version] = await db
    .select({ graph: journeyVersion.graph })
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  if (!version) return c.json({ error: "no_graph" }, 400);
  const graph = version.graph as JourneyGraph;

  const [contactRow] = await db
    .select()
    .from(contact)
    .where(and(eq(contact.id, parsed.data.contactId), eq(contact.workspaceId, workspaceId)));
  if (!contactRow) return c.json({ error: "contact_not_found" }, 404);

  // Same context shape the trigger path assembles at engine.start() (core's
  // buildStartContext) so branch expressions answer the runtime's question.
  const props = contactRow.properties ?? {};
  const context = {
    workspaceId,
    journeyId,
    contactId: contactRow.id,
    contact: { id: contactRow.id, email: contactRow.email, ...props },
    trigger: { kind: "manual" },
    journeyRunId: "dry-run",
  };

  const result = dryRunJourney(graph, context, { stopAfterNode: parsed.data.stopAfterNode });

  // Render what each email node WOULD send, and predict whether the send
  // would survive the marketing gates (the journey email channel blocks on
  // contact opt-out AND any suppression reason — service-mail exceptions
  // don't apply here). No send happens; this is description only.
  const emailPreviews = [];
  for (const email of result.emails) {
    const [tpl] = await db
      .select()
      .from(emailTemplate)
      .where(
        and(eq(emailTemplate.id, email.templateId), eq(emailTemplate.workspaceId, workspaceId)),
      );
    if (!tpl) {
      emailPreviews.push({
        nodeId: email.nodeId,
        templateId: email.templateId,
        templateName: null,
        wouldSend: false,
        blockedReason: "template_not_found",
        subject: null,
        html: null,
        text: null,
      });
      continue;
    }
    const renderData = {
      ...context,
      ...props,
      contact: { id: contactRow.id, email: contactRow.email, ...props },
    };
    const suppressed = await getSuppression(db, workspaceId, contactRow.email);
    const blockedReason = !contactRow.subscribed
      ? "unsubscribed"
      : suppressed
        ? `suppressed:${suppressed.reason}`
        : null;
    emailPreviews.push({
      nodeId: email.nodeId,
      templateId: email.templateId,
      templateName: tpl.name,
      wouldSend: blockedReason === null,
      blockedReason,
      subject: renderTemplate(email.subject || tpl.subject, renderData),
      html: renderTemplate(tpl.html, renderData),
      text: tpl.textBody ? renderTemplate(tpl.textBody, renderData) : null,
    });
  }

  return c.json({ ...result, emailPreviews });
});

journeysRouter.post("/:id/publish", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");

  const engineCtx = getEngine();
  if (!engineCtx) return c.json({ error: "engine_not_ready" }, 503);

  try {
    await publishJourney(db, engineCtx.ctx.engine, workspaceId, journeyId);
  } catch (error) {
    return c.json(
      { error: "publish_failed", message: error instanceof Error ? error.message : String(error) },
      400,
    );
  }

  return c.json({ ok: true });
});

journeysRouter.post("/:id/pause", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const result = await db
    .update(journey)
    .set({ status: "paused" })
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .returning({ id: journey.id });
  if (result.length === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

journeysRouter.get("/:id/runs", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const runs = await listJourneyRuns(db, workspaceId, journeyId, 100);
  return c.json({ runs });
});

journeysRouter.get("/:id/funnel", async (c) => {
  const { workspaceId } = c.get("auth");
  const detail = await getJourneyDetail(db, workspaceId, c.req.param("id"));
  if (!detail) return c.json({ error: "not_found" }, 404);
  const funnel = await listNodeFunnel(db, detail.journey.workflowId);
  return c.json({ funnel, runCounts: detail.runCounts });
});

export const runsRouter = new Hono<{ Variables: AuthVariables }>();

// Instance search — "where is this contact stuck?" / "who is waiting for
// this event?". Filters come from the query string; everything is
// workspace-scoped through journey_run, which is the only table that
// bridges engine instanceIds to a workspace.
runsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");

  // Only valid run statuses reach the query — anything else is treated as
  // "no filter" rather than a 400, so a stale client toggle degrades to a
  // wider search instead of an error.
  const RAW_STATUSES = [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
    "exited",
  ] as const;
  const statusParam = c.req.query("status") || undefined;
  const status = RAW_STATUSES.find((s) => s === statusParam);

  const rows = await searchInstances(db, workspaceId, {
    contactId: c.req.query("contactId") || undefined,
    email: c.req.query("email") || undefined,
    journeyId: c.req.query("journeyId") || undefined,
    status,
    waitingEvent: c.req.query("waitingEvent") || undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });

  return c.json({ runs: rows });
});

runsRouter.get("/:instanceId", async (c) => {
  const { workspaceId } = c.get("auth");
  const instanceId = c.req.param("instanceId");

  const [run] = await db
    .select()
    .from(journeyRun)
    .where(and(eq(journeyRun.instanceId, instanceId), eq(journeyRun.workspaceId, workspaceId)));
  if (!run) return c.json({ error: "not_found" }, 404);

  const engineCtx = getEngine();
  const instance = engineCtx
    ? await engineCtx.ctx.container.storage.loadInstance(instanceId)
    : null;

  return c.json({ run, instance });
});

runsRouter.post("/:instanceId/cancel", async (c) => {
  const { workspaceId } = c.get("auth");
  const instanceId = c.req.param("instanceId");

  const [run] = await db
    .select()
    .from(journeyRun)
    .where(and(eq(journeyRun.instanceId, instanceId), eq(journeyRun.workspaceId, workspaceId)));
  if (!run) return c.json({ error: "not_found" }, 404);

  const engineCtx = getEngine();
  if (!engineCtx) return c.json({ error: "engine_not_ready" }, 503);

  await engineCtx.ctx.engine.cancelInstance(instanceId);
  await db
    .update(journeyRun)
    .set({ status: "cancelled", exitedAt: new Date() })
    .where(eq(journeyRun.id, run.id));

  return c.json({ ok: true });
});

export const opsRouter = new Hono<{ Variables: AuthVariables }>();

opsRouter.get("/stats", async (c) => {
  const { workspaceId } = c.get("auth");
  const stats = await getDashboardStats(db, workspaceId);
  return c.json({ stats });
});

opsRouter.get("/dlq", async (c) => {
  const entries = await listDeadLetters(db, 50);
  return c.json({ entries });
});
