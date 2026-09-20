/**
 * Cohort simulation route (POST /v1/journeys/:id/simulate): real database
 * for contact sampling, mocked @loopkit/ai for the interpretation call
 * (zero network). What this proves:
 *  - the cohort is drawn from THIS workspace's contacts only;
 *  - dry-run aggregation reflects the seeded property distribution;
 *  - AiGraphError maps to 502 with issues, AiConfigError to 503;
 *  - a workspace with contacts but no journey is 404, a journey without
 *    any contacts is 400 no_contacts, malformed bodies are 400.
 */
import { upsertContact } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import { contact, journey, journeyVersion, workspace } from "@loopkit/db/schema";
import { Hono } from "hono";
import { getTableName, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthVariables } from "../middleware/auth";

const { testDbUrl } = vi.hoisted(() => {
  const fallback = "postgresql://postgres:password@localhost:5432/loopkit";
  const base = process.env.DATABASE_URL ?? fallback;
  const url = new URL(base);
  url.pathname = "/loopkit_test_server";
  const testDbUrl = url.toString();
  process.env.DATABASE_URL = testDbUrl;
  return { testDbUrl };
});

const { insightMock } = vi.hoisted(() => ({ insightMock: vi.fn() }));

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
  return { AiGraphError, AiConfigError, generateSimulationInsight: insightMock };
});

const db: Db = createDb(testDbUrl);
const { journeysRouter } = await import("../routes/journeys");

const TABLES = [journeyVersion, journey, contact, workspace] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
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

/** trigger → branch(contact.plan == "pro") → email → exit, both paths exit. */
const SIM_GRAPH = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      data: { trigger: { kind: "manual" } },
      position: { x: 0, y: 0 },
    },
    {
      id: "b",
      type: "branch",
      data: { expression: 'contact.plan == "pro"' },
      position: { x: 100, y: 0 },
    },
    {
      id: "vip",
      type: "email",
      data: { templateId: "tpl-vip" },
      position: { x: 200, y: -50 },
    },
    {
      id: "free",
      type: "email",
      data: { templateId: "tpl-free" },
      position: { x: 200, y: 50 },
    },
    { id: "x", type: "exit", data: { reason: "done" }, position: { x: 300, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t", target: "b" },
    { id: "e2", source: "b", target: "vip", sourceHandle: "true" },
    { id: "e3", source: "b", target: "free", sourceHandle: "false" },
    { id: "e4", source: "vip", target: "x" },
    { id: "e5", source: "free", target: "x" },
  ],
};

const INSIGHT = {
  summary: "八成走 VIP 分支",
  observations: [{ title: "分支倾斜", detail: "node 'b'", severity: "info" }],
  suggestions: [{ title: "补流失路径", detail: "node 'e'" }],
};

async function seed(): Promise<void> {
  await db.insert(workspace).values([
    { id: "ws-1", name: "Test", slug: "test" },
    { id: "ws-2", name: "Other", slug: "other" },
    { id: "ws-3", name: "Empty", slug: "empty" },
  ]);
  await db.insert(journey).values([
    {
      id: "j-1",
      workspaceId: "ws-1",
      name: "Welcome flow",
      workflowId: "wf-1",
      trigger: { kind: "manual" },
      status: "draft",
    },
    {
      id: "j-empty",
      workspaceId: "ws-3",
      name: "No audience",
      workflowId: "wf-e",
      trigger: { kind: "manual" },
      status: "draft",
    },
  ]);
  await db.insert(journeyVersion).values([
    { journeyId: "j-1", version: 1, graph: SIM_GRAPH, compiled: {} },
    { journeyId: "j-empty", version: 1, graph: SIM_GRAPH, compiled: {} },
  ]);

  // ws-1: 3 pro + 2 free. ws-2: one contact that must NEVER be sampled.
  for (const plan of ["pro", "pro", "pro", "free", "free"]) {
    await upsertContact(db, {
      workspaceId: "ws-1",
      email: `c-${plan}-${Math.random().toString(36).slice(2)}@example.com`,
      properties: { plan },
    });
  }
  await upsertContact(db, {
    workspaceId: "ws-2",
    email: "outsider@example.com",
    properties: { plan: "pro" },
  });
}

describe("POST /v1/journeys/:id/simulate", () => {
  beforeEach(async () => {
    await resetTables();
    await seed();
    insightMock.mockReset();
    insightMock.mockResolvedValue({
      result: INSIGHT,
      model: "claude-test",
      attempts: 1,
      usage: { inputTokens: 500, outputTokens: 200 },
    });
  });

  it("samples workspace contacts, aggregates the distribution, returns insights", async () => {
    const res = await buildApp("ws-1").request("/v1/journeys/j-1/simulate", {
      method: "POST",
      body: JSON.stringify({ sampleSize: 4 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      simulation: {
        samples: number;
        exitedCount: number;
        branches: { nodeId: string; outcomes: { value: string; count: number }[] }[];
        dropOffs: unknown[];
      };
      perContact: { contactId: string }[];
      insights: Record<string, unknown> | null;
    };

    expect(body.simulation.samples).toBe(4); // 5 ws-1 contacts, capped at 4
    expect(body.perContact).toHaveLength(4);
    expect(body.simulation.exitedCount).toBe(4);
    expect(body.simulation.dropOffs).toEqual([]);

    const branch = body.simulation.branches.find((x) => x.nodeId === "b");
    expect(branch).toBeDefined();
    const outcomes = Object.fromEntries(branch!.outcomes.map((o) => [o.value, o.count]));
    expect(outcomes["true"]).toBeGreaterThanOrEqual(1);
    expect(outcomes["false"]).toBeGreaterThanOrEqual(1);
    expect((outcomes["true"] ?? 0) + (outcomes["false"] ?? 0)).toBe(4);

    expect(body.insights).toMatchObject({ ...INSIGHT, model: "claude-test", attempts: 1 });

    // The AI only ever sees aggregates — never identities.
    const input = insightMock.mock.calls[0]![0] as {
      simulation: { samples: number };
      propertyKeys: string[];
    };
    expect(input.simulation.samples).toBe(4);
    expect(input.propertyKeys).toEqual(["plan"]);
    const promptArg = insightMock.mock.calls[0]?.[1];
    expect(promptArg).toBeUndefined(); // single input-object signature
  });

  it("never samples another workspace's contacts", async () => {
    const res = await buildApp("ws-1").request("/v1/journeys/j-1/simulate", {
      method: "POST",
      body: JSON.stringify({ insight: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { simulation: { samples: number }; insights: unknown };
    expect(body.simulation.samples).toBe(5);
    expect(body.insights).toBeNull();
    expect(insightMock).not.toHaveBeenCalled();
  });

  it("maps AiGraphError to 502 with issues and AiConfigError to 503", async () => {
    const { AiGraphError, AiConfigError } = await import("@loopkit/ai");
    insightMock.mockRejectedValueOnce(new AiGraphError("bad insight", ["summary: empty"]));
    const res = await buildApp("ws-1").request("/v1/journeys/j-1/simulate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe("ai_guard_rejected");
    expect(body.issues).toEqual(["summary: empty"]);

    insightMock.mockRejectedValueOnce(new AiConfigError("no key"));
    const res2 = await buildApp("ws-1").request("/v1/journeys/j-1/simulate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res2.status).toBe(503);
    expect(((await res2.json()) as { error: string }).error).toBe("ai_not_configured");
  });

  it("returns 404 for foreign journeys, 400 for contactless journeys and bad bodies", async () => {
    const foreign = await buildApp("ws-2").request("/v1/journeys/j-1/simulate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(foreign.status).toBe(404);

    const noContacts = await buildApp("ws-3").request("/v1/journeys/j-empty/simulate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(noContacts.status).toBe(400);
    expect(((await noContacts.json()) as { error: string }).error).toBe("no_contacts");

    const bad = await buildApp("ws-1").request("/v1/journeys/j-1/simulate", {
      method: "POST",
      body: JSON.stringify({ sampleSize: 999 }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_request");
  });
});
