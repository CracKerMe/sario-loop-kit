/**
 * Journey Copilot route (POST /v1/journeys/copilot): real database for the
 * workspace-context gathering, mocked @loopkit/ai for the generation call
 * (zero network). What this proves:
 *  - the context the model receives is gathered from THIS workspace only —
 *    templates, published journeys (draft ones excluded) and observed event
 *    names;
 *  - a successful generation returns the guarded graph plus metadata;
 *  - AiGraphError maps to 502 with the issue list (never the raw payload);
 *  - AiConfigError maps to 503 so the UI can show "configure the key";
 *  - malformed requests are 400.
 */
import { upsertContact } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import { contactEvent, contact, emailTemplate, journey, workspace } from "@loopkit/db/schema";
import { Hono } from "hono";
import { getTableName, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthVariables } from "../middleware/auth";

/**
 * Same trick as journeyDryRun.test.ts: the router uses @loopkit/db's
 * DEFAULT handle, so DATABASE_URL is redirected to this package's test
 * database BEFORE the first import.
 */
const { testDbUrl, originalDatabaseUrl } = vi.hoisted(() => {
  const fallback = "postgresql://postgres:password@localhost:5432/loopkit";
  const base = process.env.DATABASE_URL ?? fallback;
  const url = new URL(base);
  url.pathname = "/loopkit_test_server";
  const testDbUrl = url.toString();
  process.env.DATABASE_URL = testDbUrl;
  return { testDbUrl, originalDatabaseUrl: base };
});

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));

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
  return { AiGraphError, AiConfigError, generateJourneyGraph: generateMock };
});

const db: Db = createDb(testDbUrl);
const { journeysRouter } = await import("../routes/journeys");

const TABLES = [contactEvent, emailTemplate, journey, contact, workspace] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

function buildApp(workspaceId = "ws-1") {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError((err, c) => {
    console.error("ROUTE ERR:", err);
    return c.json({ error: "boom", message: String(err) }, 500);
  });
  app.use("*", async (c, next) => {
    c.set("auth", { workspaceId, kind: "session", userId: "user-1" });
    await next();
  });
  app.route("/v1/journeys", journeysRouter);
  return app;
}

const GENERATED_GRAPH = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      data: { trigger: { kind: "event", name: "order.placed" } },
      position: { x: 0, y: 0 },
    },
    {
      id: "w",
      type: "delay",
      data: { mode: "duration", ms: 86400000 },
      position: { x: 100, y: 0 },
    },
    {
      id: "e",
      type: "email",
      data: { templateId: "tpl-1", subject: "Hi" },
      position: { x: 200, y: 0 },
    },
    { id: "x", type: "exit", data: { reason: "done" }, position: { x: 300, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t", target: "w" },
    { id: "e2", source: "w", target: "e" },
    { id: "e3", source: "e", target: "x" },
  ],
};

async function seedContext(): Promise<void> {
  await db.insert(workspace).values([
    { id: "ws-1", name: "Test", slug: "test" },
    { id: "ws-2", name: "Other", slug: "other" },
  ]);
  await db.insert(emailTemplate).values([
    { id: "tpl-1", workspaceId: "ws-1", name: "Welcome", subject: "Welcome", html: "<p>Hi</p>" },
    { id: "tpl-2", workspaceId: "ws-1", name: "Coupon", subject: "Coupon", html: "<p>10%</p>" },
    { id: "tpl-x", workspaceId: "ws-2", name: "Other's", subject: "x", html: "<p>x</p>" },
  ]);
  await db.insert(journey).values([
    {
      id: "j-child",
      workspaceId: "ws-1",
      name: "Child drip",
      workflowId: "wf-child",
      trigger: { kind: "manual" },
      status: "published",
    },
    {
      id: "j-draft",
      workspaceId: "ws-1",
      name: "Not published yet",
      workflowId: "wf-draft",
      trigger: { kind: "manual" },
      status: "draft",
    },
  ]);
  const c1 = await upsertContact(db, { workspaceId: "ws-1", email: "sam@example.com" });
  await db.insert(contactEvent).values([
    { id: "ev-1", workspaceId: "ws-1", contactId: c1.id, name: "order.placed" },
    { id: "ev-2", workspaceId: "ws-1", contactId: c1.id, name: "email.opened" },
  ]);
}

describe("POST /v1/journeys/copilot", () => {
  const app = buildApp();

  beforeEach(async () => {
    await resetTables();
    generateMock.mockReset();
    await seedContext();
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  function copilot(body: unknown) {
    return app.request("/v1/journeys/copilot", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("rejects a too-short or malformed request with 400", async () => {
    expect((await copilot({ request: "hi" })).status).toBe(400);
    expect((await copilot({})).status).toBe(400);
    expect((await copilot("not json")).status).toBe(400);
  });

  it("returns the guarded graph and gathers workspace-only context", async () => {
    generateMock.mockResolvedValue({
      graph: GENERATED_GRAPH,
      model: "claude-test",
      attempts: 1,
      usage: { inputTokens: 120, outputTokens: 340 },
    });

    const res = await copilot({ request: "下单后隔天发一封欢迎邮件" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(generateMock).toHaveBeenCalledTimes(1);
    const ctx = generateMock.mock.calls[0]![0] as {
      request: string;
      templates: { id: string; name: string }[];
      childJourneys: { id: string; name: string }[];
      events: string[];
    };
    expect(ctx.request).toBe("下单后隔天发一封欢迎邮件");
    // Only ws-1 templates — the model must not learn other workspaces' ids.
    expect(ctx.templates).toEqual([
      { id: "tpl-1", name: "Welcome" },
      { id: "tpl-2", name: "Coupon" },
    ]);
    // Only PUBLISHED journeys are subJourney candidates.
    expect(ctx.childJourneys).toEqual([{ id: "j-child", name: "Child drip" }]);
    expect(ctx.events).toEqual(expect.arrayContaining(["order.placed", "email.opened"]));

    expect(body.graph).toEqual(GENERATED_GRAPH);
    expect(body.model).toBe("claude-test");
    expect(body.attempts).toBe(1);
    expect(body.usage).toEqual({ inputTokens: 120, outputTokens: 340 });
    // validateGraph echo — the guarded graph is structurally sound.
    expect((body.validation as { valid: boolean }).valid).toBe(true);
  });

  it("maps AiGraphError to 502 with issues and never the raw payload", async () => {
    const { AiGraphError } = await import("@loopkit/ai");
    generateMock.mockRejectedValue(
      new AiGraphError("model response failed the guard", ["unknown node type: sql_query"]),
    );

    const res = await copilot({ request: "发一封邮件" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe("ai_guard_rejected");
    expect(body.issues).toEqual(["unknown node type: sql_query"]);
  });

  it("maps AiConfigError to 503 ai_not_configured", async () => {
    const { AiConfigError } = await import("@loopkit/ai");
    generateMock.mockRejectedValue(
      new AiConfigError(
        "ANTHROPIC_API_KEY is not set — AI features are unavailable until it is configured",
      ),
    );

    const res = await copilot({ request: "发一封邮件" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ai_not_configured");
  });
});
