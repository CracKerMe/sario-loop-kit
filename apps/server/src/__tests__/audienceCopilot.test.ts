/**
 * Audience copilot route (POST /v1/audiences/copilot): real database for
 * workspace-context gathering, mocked @loopkit/ai for the generation call
 * (zero network). What this proves:
 *  - the model context is gathered from THIS workspace only (property keys
 *    and event names, never contact property values);
 *  - a successful generation returns name/summary/filter plus model metadata;
 *  - a filter that somehow slips the AI guard but fails core validation
 *    still maps to 502 (defense in depth);
 *  - AiGraphError → 502, AiConfigError → 503, bad body → 400.
 */
import { upsertContact } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import { audience, contact, contactEvent, workspace } from "@loopkit/db/schema";
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
  return { AiGraphError, AiConfigError, generateSegmentAudience: generateMock };
});

const db: Db = createDb(testDbUrl);
const { audiencesRouter } = await import("../routes/audiences");

const TABLES = [audience, contactEvent, contact, workspace] as const;

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
  app.route("/v1/audiences", audiencesRouter);
  return app;
}

const VALID_FILTER = {
  op: "and",
  children: [
    { kind: "event", name: "email.opened", occurred: true, withinDays: 30 },
    { kind: "event", name: "order.placed", occurred: false },
  ],
};

const GENERATION = {
  result: {
    name: "上月活跃未付费",
    summary: "AI says: active but never ordered",
    filter: VALID_FILTER,
  },
  model: "claude-test",
  attempts: 1,
  usage: { inputTokens: 10, outputTokens: 5 },
};

beforeEach(async () => {
  await resetTables();
  generateMock.mockReset();

  await db.insert(workspace).values({ id: "ws-1", name: "WS 1", slug: "ws-1" });
  const c1 = await upsertContact(db, {
    workspaceId: "ws-1",
    email: "a@example.com",
    properties: { plan: "pro", company: "Acme" },
  });
  await db.insert(contactEvent).values([
    { id: "ev-1", workspaceId: "ws-1", contactId: c1.id, name: "order.placed" },
    { id: "ev-2", workspaceId: "ws-1", contactId: c1.id, name: "email.opened" },
  ]);
});

describe("POST /v1/audiences/copilot", () => {
  function copilot(body: unknown, workspaceId = "ws-1") {
    return buildApp(workspaceId).request("/v1/audiences/copilot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects malformed bodies", async () => {
    expect((await copilot({ request: "hi" })).status).toBe(400);
    expect((await copilot({})).status).toBe(400);
    expect((await copilot("not json")).status).toBe(400);
  });

  it("returns a guarded filter and gathers workspace vocabularies", async () => {
    generateMock.mockResolvedValue(GENERATION);
    const res = await copilot({ request: "上月活跃但未付费的用户", today: "2026-02-18" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      summary: string;
      modelSummary: string;
      filter: unknown;
      model: string;
    };
    expect(body.name).toBe("上月活跃未付费");
    // Server-side summary comes from core describeSegmentFilter, not the model.
    expect(body.summary).toContain("email.opened");
    expect(body.modelSummary).toBe("AI says: active but never ordered");
    expect(body.filter).toEqual(VALID_FILTER);
    expect(body.model).toBe("claude-test");

    expect(generateMock).toHaveBeenCalledTimes(1);
    const arg = generateMock.mock.calls[0]![0] as {
      request: string;
      today?: string;
      propertyKeys?: string[];
      events?: string[];
    };
    expect(arg.request).toContain("上月活跃");
    expect(arg.today).toBe("2026-02-18");
    expect(arg.propertyKeys).toEqual(expect.arrayContaining(["plan", "company"]));
    expect(arg.events).toEqual(expect.arrayContaining(["order.placed"]));
  });

  it("maps AiGraphError to 502 with issues", async () => {
    const { AiGraphError } = await import("@loopkit/ai");
    generateMock.mockRejectedValue(new AiGraphError("bad filter", ["unknown field ssn"]));
    const res = await copilot({ request: "所有联系人" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe("ai_guard_rejected");
    expect(body.issues).toContain("unknown field ssn");
  });

  it("maps AiConfigError to 503", async () => {
    const { AiConfigError } = await import("@loopkit/ai");
    generateMock.mockRejectedValue(new AiConfigError("missing key"));
    const res = await copilot({ request: "所有联系人" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("ai_not_configured");
  });

  it("rejects a filter that fails core validation even if AI returned it", async () => {
    generateMock.mockResolvedValue({
      ...GENERATION,
      result: {
        ...GENERATION.result,
        filter: { kind: "condition", field: "ssn", operator: "eq", value: "1" },
      },
    });
    const res = await copilot({ request: "所有联系人" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("ai_guard_rejected");
  });

  it("scopes property keys to the calling workspace", async () => {
    generateMock.mockResolvedValue(GENERATION);
    const res = await copilot({ request: "所有联系人" }, "ws-missing");
    expect(res.status).toBe(200);
    const arg = generateMock.mock.calls[0]![0] as { propertyKeys?: string[] };
    expect(arg.propertyKeys ?? []).not.toContain("plan");
  });
});
