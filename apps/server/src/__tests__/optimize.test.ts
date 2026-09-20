/**
 * P3.5 optimize routes: real database for signal collection + proposal
 * persistence, mocked @loopkit/ai for the generation call (zero network).
 * Proves: workspace scoping, guarded proposal persistence, accept-as-draft
 * mints a journey_version, canary start requires an existing published
 * baseline, and promote/rollback flip canary + journey bookkeeping.
 */
import { publishJourney } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import {
  contact,
  journey,
  journeyCanary,
  journeyOptimization,
  journeyRun,
  journeyVersion,
  workspace,
} from "@loopkit/db/schema";
import { createLoopkitEngine, type LoopkitEngine } from "@loopkit/engine";
import type { JourneyGraph } from "@loopkit/journey";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "@loopkit/email";
import { Hono } from "hono";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthVariables } from "../middleware/auth";
import { setEngineForTesting } from "../loopkitRuntime";

const { testDbUrl, originalDatabaseUrl } = vi.hoisted(() => {
  const fallback = "postgresql://postgres:password@localhost:5432/loopkit";
  const base = process.env.DATABASE_URL ?? fallback;
  const url = new URL(base);
  url.pathname = "/loopkit_test_server";
  const testDbUrl = url.toString();
  process.env.DATABASE_URL = testDbUrl;
  return { testDbUrl, originalDatabaseUrl: base };
});

const { optimizeMock } = vi.hoisted(() => ({ optimizeMock: vi.fn() }));

vi.mock("@loopkit/ai", () => {
  class AiGraphError extends Error {
    readonly issues: string[];
    constructor(message: string, issues: string[] = []) {
      super(message);
      this.name = "AiGraphError";
      this.issues = issues;
    }
  }
  class AiConfigError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AiConfigError";
    }
  }
  return {
    AiGraphError,
    AiConfigError,
    generateJourneyGraph: vi.fn(),
    generateSimulationInsight: vi.fn(),
    generateJourneyOptimization: optimizeMock,
  };
});

const db: Db = createDb(testDbUrl);
const { journeysRouter } = await import("../routes/journeys");

const TABLES = [
  journeyCanary,
  journeyOptimization,
  journeyRun,
  journeyVersion,
  journey,
  contact,
  workspace,
] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

class SilentProvider implements EmailProvider {
  readonly name = "silent";
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    return { messageId: `msg-${input.to}` };
  }
  async parseWebhook(): Promise<never[]> {
    return [];
  }
}

function buildApp(workspaceId = "ws-1") {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("auth", { workspaceId, kind: "session", userId: "user-1" });
    await next();
  });
  app.route("/v1/journeys", journeysRouter);
  return app;
}

function graph(
  nodes: { id: string; type: string; data?: object }[],
  edges: [string, string][],
): JourneyGraph {
  return {
    nodes: nodes.map((n) => ({ ...n, data: n.data ?? {}, position: { x: 0, y: 0 } })),
    edges: edges.map(([source, target], i) => ({ id: `e${i}`, source, target })),
  } as unknown as JourneyGraph;
}

const J = "j-opt";
const BASE_GRAPH = graph(
  [
    { id: "t", type: "trigger", data: { trigger: { kind: "manual" } } },
    { id: "e1", type: "email", data: { templateId: "tpl-1" } },
    { id: "x", type: "exit", data: {} },
  ],
  [
    ["t", "e1"],
    ["e1", "x"],
  ],
);

const REVISED_GRAPH = graph(
  [
    { id: "t", type: "trigger", data: { trigger: { kind: "manual" } } },
    { id: "e1", type: "email", data: { templateId: "tpl-1" } },
    { id: "d1", type: "delay", data: { mode: "duration", ms: 3_600_000 } },
    { id: "x", type: "exit", data: {} },
  ],
  [
    ["t", "e1"],
    ["e1", "d1"],
    ["d1", "x"],
  ],
);

const ANALYSIS = {
  summary: "Email node drops too many contacts before exit.",
  diagnosis: [{ nodeId: "e1", issue: "no follow-up", severity: "warning" }],
  changes: [{ nodeId: "e1", action: "add", description: "insert a short delay" }],
  expectedImpact: [{ metric: "completion", direction: "increase", note: "fewer dead ends" }],
  canaryPercent: 10,
};

let engine: LoopkitEngine;

async function seedWorkspace(workspaceId: string) {
  await db.insert(workspace).values({ id: workspaceId, name: workspaceId, slug: workspaceId });
}

async function seedJourney(workspaceId: string, journeyId: string, published: boolean) {
  await db.insert(journey).values({
    id: journeyId,
    workspaceId,
    name: `Journey ${journeyId}`,
    status: published ? "published" : "draft",
    workflowId: `journey-${journeyId}`,
    trigger: { kind: "manual" },
    publishedVersion: published ? 1 : null,
  });
  await db
    .insert(journeyVersion)
    .values({ journeyId, version: 1, graph: BASE_GRAPH, compiled: {} });
}

beforeAll(async () => {
  engine = await createLoopkitEngine({
    db,
    emailProvider: new SilentProvider(),
    defaultFromEmail: "test@example.com",
    pollIntervalMs: 60_000,
  });
  setEngineForTesting(engine);
});

afterAll(async () => {
  await engine.stop();
  process.env.DATABASE_URL = originalDatabaseUrl;
});

beforeEach(async () => {
  await resetTables();
  optimizeMock.mockReset();
  await seedWorkspace("ws-1");
  await seedWorkspace("ws-2");
  await seedJourney("ws-1", J, true);
  await seedWorkspace("ws-3");
});

describe("POST /v1/journeys/:id/optimize", () => {
  it("collects signals, generates a proposal, and persists it", async () => {
    optimizeMock.mockResolvedValue({
      result: { analysis: ANALYSIS, graph: REVISED_GRAPH },
      model: "claude-test",
      attempts: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const app = buildApp("ws-1");
    const res = await app.request(`/v1/journeys/${J}/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "reduce drop-off" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      optimizationId: string;
      analysis: { summary: string };
      graph: { nodes: unknown[] };
    };
    expect(body.optimizationId).toBeTruthy();
    expect(body.analysis.summary).toContain("Email node");
    expect(body.graph.nodes).toHaveLength(4);
    expect(optimizeMock).toHaveBeenCalledTimes(1);
    const arg = optimizeMock.mock.calls[0]![0];
    expect(arg.journeyName).toBe(`Journey ${J}`);
    expect(arg.signals.email).toMatchObject({ sent: 0, delivered: 0 });
    expect(arg.request).toBe("reduce drop-off");

    const [row] = await db
      .select()
      .from(journeyOptimization)
      .where(eq(journeyOptimization.id, body.optimizationId));
    expect(row?.status).toBe("proposed");
    expect(row?.canaryPercent).toBe(10);
  });

  it("maps AiGraphError to 502 and foreign journeys to 404", async () => {
    const { AiGraphError } = await import("@loopkit/ai");
    optimizeMock.mockRejectedValue(new AiGraphError("bad graph", ["disallowed type"]));
    const app = buildApp("ws-1");
    const res = await app.request(`/v1/journeys/${J}/optimize`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("ai_guard_rejected");

    const foreign = buildApp("ws-2").request(`/v1/journeys/${J}/optimize`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect((await foreign).status).toBe(404);
  });
});

describe("accept + canary lifecycle", () => {
  async function propose(): Promise<string> {
    optimizeMock.mockResolvedValue({
      result: { analysis: ANALYSIS, graph: REVISED_GRAPH },
      model: "claude-test",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const res = await buildApp("ws-1").request(`/v1/journeys/${J}/optimize`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { optimizationId: string };
    return body.optimizationId;
  }

  it("accept as draft mints an unpublished journey_version", async () => {
    const optimizationId = await propose();
    const res = await buildApp("ws-1").request(
      `/v1/journeys/${J}/optimizations/${optimizationId}/accept`,
      {
        method: "POST",
        body: JSON.stringify({ mode: "draft" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      targetVersion: number;
    };
    expect(body.mode).toBe("draft");
    expect(body.targetVersion).toBe(2);

    const [v2] = await db.select().from(journeyVersion).where(eq(journeyVersion.journeyId, J));
    // two versions exist
    const versions = await db.select().from(journeyVersion).where(eq(journeyVersion.journeyId, J));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    void v2;

    const [opt] = await db
      .select()
      .from(journeyOptimization)
      .where(eq(journeyOptimization.id, optimizationId));
    expect(opt?.status).toBe("accepted");
  });

  it("accept as canary starts a gray release without flipping publishedVersion", async () => {
    // Publish first so the engine has a registered baseline definition.
    await publishJourney(db, engine.ctx.engine, "ws-1", J);
    const optimizationId = await propose();

    const res = await buildApp("ws-1").request(
      `/v1/journeys/${J}/optimizations/${optimizationId}/accept`,
      {
        method: "POST",
        body: JSON.stringify({ mode: "canary", canaryPercent: 10, minRuns: 5 }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      canary?: { baselineVersion: number; canaryVersion: number; percent: number };
    };
    expect(body.mode).toBe("canary");
    expect(body.canary).toMatchObject({ baselineVersion: 1, canaryVersion: 2, percent: 10 });

    const [j] = await db.select().from(journey).where(eq(journey.id, J));
    expect(j?.publishedVersion).toBe(1);

    const [canaryRow] = await db.select().from(journeyCanary).where(eq(journeyCanary.journeyId, J));
    expect(canaryRow?.status).toBe("active");
    expect(canaryRow?.canaryVersion).toBe(2);

    // Evaluate holds on empty sample.
    const evalRes = await buildApp("ws-1").request(`/v1/journeys/${J}/canary/evaluate`, {
      method: "POST",
      body: JSON.stringify({ force: false, autoApply: false }),
    });
    expect(evalRes.status).toBe(200);
    const evalBody = (await evalRes.json()) as {
      comparison: { decision: string };
      applied: string | null;
    };
    expect(evalBody.comparison.decision).toBe("hold");
    expect(evalBody.applied).toBeNull();

    // Promote flips publishedVersion to the canary version.
    const promoteRes = await buildApp("ws-1").request(`/v1/journeys/${J}/canary/promote`, {
      method: "POST",
    });
    expect(promoteRes.status).toBe(200);
    const [j2] = await db.select().from(journey).where(eq(journey.id, J));
    expect(j2?.publishedVersion).toBe(2);
    const [canary2] = await db.select().from(journeyCanary).where(eq(journeyCanary.journeyId, J));
    expect(canary2?.status).toBe("promoted");
  });

  it("rollback keeps the baseline published version", async () => {
    await publishJourney(db, engine.ctx.engine, "ws-1", J);
    const optimizationId = await propose();
    await buildApp("ws-1").request(`/v1/journeys/${J}/optimizations/${optimizationId}/accept`, {
      method: "POST",
      body: JSON.stringify({ mode: "canary", canaryPercent: 10 }),
    });

    const res = await buildApp("ws-1").request(`/v1/journeys/${J}/canary/rollback`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const [j] = await db.select().from(journey).where(eq(journey.id, J));
    expect(j?.publishedVersion).toBe(1);
    const [canaryRow] = await db.select().from(journeyCanary).where(eq(journeyCanary.journeyId, J));
    expect(canaryRow?.status).toBe("rolled_back");
  });
});
