import { createJourneyDraft, publishJourney } from "@loopkit/core";
import { db } from "@loopkit/db";
import { journey, journeyRun, journeyVersion } from "@loopkit/db/schema";
import { validateGraph, type JourneyGraph } from "@loopkit/journey";
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
  const rows = await db.select().from(journey).where(eq(journey.workspaceId, workspaceId));
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
  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, c.req.param("id")), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);
  return c.json({ journey: j });
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

  return c.json({ version: nextVersion, validation });
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
  const runs = await db
    .select()
    .from(journeyRun)
    .where(and(eq(journeyRun.journeyId, journeyId), eq(journeyRun.workspaceId, workspaceId)))
    .orderBy(desc(journeyRun.enteredAt))
    .limit(100);
  return c.json({ runs });
});

export const runsRouter = new Hono<{ Variables: AuthVariables }>();

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
