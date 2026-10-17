/**
 * Intelligence HTTP surface: lead scoring rules, signal plays, website
 * tracking. Session routers for admin; public tracking endpoint for the
 * site snippet (keyed by signal_settings.tracking_key).
 */
import {
  createLeadScoreRule,
  createPlay,
  deleteLeadScoreRule,
  deletePlay,
  evaluatePlays,
  getOrCreateSignalSettings,
  ingestPageView,
  listLeadScoreRules,
  listPlays,
  listRecentPageViews,
  recomputeLeadScore,
  runIntelligenceHook,
  scoreDistribution,
  updateLeadScoreRule,
  updatePlay,
  updateSignalSettings,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { contact as contactTable, signalSettings as signalSettingsTable } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { requireAuth, type AuthVariables } from "../middleware/auth";
import type { PlayTrigger } from "@loopkit/core";

type AppEnv = { Variables: AuthVariables };

function sessionAuth() {
  return requireAuth({ allow: ["session"] });
}

const ruleSchema = z.object({
  name: z.string().min(1).max(80),
  active: z.boolean().optional(),
  kind: z.enum(["property", "event", "page"]),
  propertyKey: z.string().max(80).nullish(),
  operator: z
    .enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists", "missing"])
    .nullish(),
  propertyValue: z.string().max(200).nullish(),
  eventName: z.string().max(80).nullish(),
  pathContains: z.string().max(200).nullish(),
  windowHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .nullish(),
  maxHits: z.number().int().min(1).max(1000).nullish(),
  points: z.number().int().min(-1000).max(1000),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

const playSchema = z.object({
  name: z.string().min(1).max(80),
  active: z.boolean().optional(),
  trigger: z.object({
    kind: z.enum(["contact_created", "event", "score_threshold"]),
    name: z.string().max(80).optional(),
    pathContains: z.string().max(200).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  conditions: z.unknown().optional(),
  actions: z
    .array(
      z.union([
        z.object({
          type: z.literal("set_property"),
          key: z.string().min(1).max(80),
          value: z.unknown(),
        }),
        z.object({ type: z.literal("add_tag"), tag: z.string().min(1).max(60) }),
        z.object({
          type: z.literal("notify"),
          url: z.string().url(),
          message: z.string().max(500).optional(),
        }),
        z.object({ type: z.literal("start_journey"), journeyId: z.string().min(1) }),
      ]),
    )
    .min(1)
    .max(10),
});

/** Zod trigger → PlayTrigger (discriminated union). */
function toPlayTrigger(raw: z.infer<typeof playSchema>["trigger"]): PlayTrigger {
  if (raw.kind === "contact_created") return { kind: "contact_created" };
  if (raw.kind === "score_threshold") {
    return {
      kind: "score_threshold",
      min: raw.min ?? 0,
      ...(raw.max != null ? { max: raw.max } : {}),
    };
  }
  return {
    kind: "event",
    name: raw.name ?? "page.viewed",
    ...(raw.pathContains ? { pathContains: raw.pathContains } : {}),
  };
}

export const scoringRouter = new Hono<AppEnv>();
scoringRouter.use(sessionAuth());

scoringRouter.get("/rules", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ rules: await listLeadScoreRules(db, workspaceId) });
});

scoringRouter.post("/rules", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = ruleSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const rule = await createLeadScoreRule(db, workspaceId, parsed.data);
  return c.json({ rule }, 201);
});

scoringRouter.patch("/rules/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = ruleSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const rule = await updateLeadScoreRule(db, workspaceId, c.req.param("id"), parsed.data);
  if (!rule) return c.json({ error: "not_found" }, 404);
  return c.json({ rule });
});

scoringRouter.delete("/rules/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const ok = await deleteLeadScoreRule(db, workspaceId, c.req.param("id"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

scoringRouter.get("/distribution", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ distribution: await scoreDistribution(db, workspaceId) });
});

scoringRouter.post("/recompute/:contactId", async (c) => {
  const { workspaceId } = c.get("auth");
  const result = await recomputeLeadScore(db, workspaceId, c.req.param("contactId"));
  if (!result) return c.json({ error: "not_found" }, 404);
  return c.json(result);
});

export const playsRouter = new Hono<AppEnv>();
playsRouter.use(sessionAuth());

playsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ plays: await listPlays(db, workspaceId) });
});

playsRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = playSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const play = await createPlay(db, workspaceId, {
    ...parsed.data,
    trigger: toPlayTrigger(parsed.data.trigger),
  });
  return c.json({ play }, 201);
});

playsRouter.patch("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = playSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { trigger: rawTrigger, ...rest } = parsed.data;
  const play = await updatePlay(db, workspaceId, c.req.param("id"), {
    ...rest,
    ...(rawTrigger ? { trigger: toPlayTrigger(rawTrigger) } : {}),
  });
  if (!play) return c.json({ error: "not_found" }, 404);
  return c.json({ play });
});

playsRouter.delete("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const ok = await deletePlay(db, workspaceId, c.req.param("id"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

/** Dry-run a play against a real contact (no side effects beyond scoring recompute). */
playsRouter.post("/:id/preview", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z.object({ contactId: z.string() }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { evaluatePlays: runPlays } = await import("@loopkit/core");
  void runPlays;
  // Preview is intentionally a no-fire path: we only report match likelihood
  // by listing the play and its trigger. Full dry-run of actions is a later step.
  const plays = await listPlays(db, workspaceId);
  const play = plays.find((p) => p.id === c.req.param("id"));
  if (!play) return c.json({ error: "not_found" }, 404);
  return c.json({
    play,
    contactId: parsed.data.contactId,
    note: "Actions are applied on live signals; preview shows trigger configuration only.",
  });
});

export const signalsRouter = new Hono<AppEnv>();
signalsRouter.use(sessionAuth());

signalsRouter.get("/settings", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ settings: await getOrCreateSignalSettings(db, workspaceId) });
});

signalsRouter.put("/settings", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z
    .object({
      highIntentPaths: z.array(z.string().max(200)).max(50).optional(),
      intentWebhookUrl: z.string().url().nullish(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const settings = await updateSignalSettings(db, workspaceId, parsed.data);
  return c.json({ settings });
});

signalsRouter.get("/page-views", async (c) => {
  const { workspaceId } = c.get("auth");
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({ pageViews: await listRecentPageViews(db, workspaceId, limit) });
});

/** Public tracking endpoint used by the site snippet. */
export const signalsPublicRouter = new Hono();

const trackSchema = z.object({
  trackingKey: z.string().min(8).max(80),
  email: z.string().email().optional(),
  anonymousId: z.string().min(1).max(80).optional(),
  userId: z.string().max(80).optional(),
  path: z.string().min(1).max(500),
  title: z.string().max(200).optional(),
  referrer: z.string().max(500).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

signalsPublicRouter.post("/signals/track", async (c) => {
  const parsed = trackSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

  const [settings] = await db
    .select()
    .from(signalSettingsTable)
    .where(eq(signalSettingsTable.trackingKey, parsed.data.trackingKey))
    .limit(1);
  if (!settings) return c.json({ error: "unknown_tracking_key" }, 404);

  const result = await ingestPageView(db, settings.workspaceId, {
    email: parsed.data.email,
    anonymousId: parsed.data.anonymousId,
    userId: parsed.data.userId,
    path: parsed.data.path,
    title: parsed.data.title,
    referrer: parsed.data.referrer,
    properties: parsed.data.properties,
  });

  return c.json(
    {
      ok: true,
      contactId: result.contactId,
      leadScore: result.intelligence.leadScore,
      leadTier: result.intelligence.leadTier,
    },
    201,
  );
});

/** Tracking snippet for marketing sites. */
signalsPublicRouter.get("/signals/snippet.js", (c) => {
  const origin = new URL(c.req.url).origin;
  const body = `/* Loopkit website tracking snippet */
(function () {
  var key = document.currentScript && document.currentScript.getAttribute("data-tracking-key");
  if (!key) { console.warn("[loopkit] missing data-tracking-key"); return; }
  function uid() {
    var k = "loopkit_anon";
    try {
      var v = localStorage.getItem(k);
      if (!v) { v = "anon_" + Math.random().toString(36).slice(2, 12); localStorage.setItem(k, v); }
      return v;
    } catch (e) { return "anon_" + Math.random().toString(36).slice(2, 12); }
  }
  function track(path) {
    fetch("${origin}/v1/signals/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackingKey: key,
        anonymousId: uid(),
        path: path || location.pathname + location.search,
        title: document.title,
        referrer: document.referrer || undefined
      })
    }).catch(function () {});
  }
  track();
  var push = history.pushState;
  history.pushState = function () {
    push.apply(this, arguments);
    track();
  };
  window.addEventListener("popstate", function () { track(); });
})();
`;
  return c.body(body, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
});

/** Convenience: attach intelligence hook after contact writes. */
export async function hookContactCreated(workspaceId: string, contactId: string, email: string) {
  return runIntelligenceHook(db, {
    workspaceId,
    contactId,
    email,
    signal: { kind: "contact_created" },
  });
}

export async function hookContactEvent(
  workspaceId: string,
  contactId: string,
  email: string,
  eventName: string,
  eventProperties: Record<string, unknown>,
) {
  return runIntelligenceHook(db, {
    workspaceId,
    contactId,
    email,
    signal: { kind: "event", eventName, eventProperties },
  });
}

// re-export evaluatePlays for route wiring of start_journey actions
export { evaluatePlays, contactTable };
