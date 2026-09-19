/**
 * Email copilot route (POST /v1/email-templates/copilot): real database for
 * the workspace-context gathering, mocked @loopkit/ai for the generation call
 * (zero network). What this proves:
 *  - the merge-tag paths the model receives come from THIS workspace's
 *    observed contact properties (plus the built-in suggestions) — never
 *    another workspace's;
 *  - a successful generation returns the guarded subject/doc plus metadata
 *    and a validateEmailDoc echo;
 *  - AiGraphError maps to 502 with the issue list (never the raw payload);
 *  - AiConfigError maps to 503 so the UI can show "configure the key";
 *  - malformed requests are 400.
 */
import { EMAIL_DOC_PRESETS } from "@loopkit/email-doc";
import { createDb, type Db } from "@loopkit/db";
import { contact, workspace } from "@loopkit/db/schema";
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
  return { AiGraphError, AiConfigError, generateEmailContent: generateMock };
});

const db: Db = createDb(testDbUrl);
const { emailTemplatesRouter } = await import("../routes/emailTemplates");

const TABLES = [contact, workspace] as const;

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
  app.route("/v1/email-templates", emailTemplatesRouter);
  return app;
}

const GENERATED = {
  subject: "v2 is here",
  doc: structuredClone(EMAIL_DOC_PRESETS[0]!.doc),
  model: "claude-test",
  attempts: 1,
  usage: { inputTokens: 90, outputTokens: 240 },
};

async function seedContext(): Promise<void> {
  await db.insert(workspace).values([
    { id: "ws-1", name: "Test", slug: "test" },
    { id: "ws-2", name: "Other", slug: "other" },
  ]);
  await db.insert(contact).values([
    {
      id: "c-1",
      workspaceId: "ws-1",
      email: "sam@example.com",
      properties: { plan: "pro", seats: 12 },
    },
    {
      id: "c-2",
      workspaceId: "ws-2",
      email: "other@example.com",
      properties: { competitorField: "leak" },
    },
  ]);
}

describe("POST /v1/email-templates/copilot", () => {
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
    return app.request("/v1/email-templates/copilot", {
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

  it("returns the guarded content and gathers workspace-only merge tags", async () => {
    generateMock.mockResolvedValue(GENERATED);

    const res = await copilot({ request: "给现有客户写一封 v2 发布邮件", tone: "confident" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(generateMock).toHaveBeenCalledTimes(1);
    const ctx = generateMock.mock.calls[0]![0] as {
      request: string;
      tone?: string;
      mergeTagPaths: string[];
    };
    expect(ctx.request).toBe("给现有客户写一封 v2 发布邮件");
    expect(ctx.tone).toBe("confident");
    // Built-in suggestions are always offered...
    expect(ctx.mergeTagPaths).toContain("contact.firstName");
    // ...and this workspace's observed property keys are mapped in...
    expect(ctx.mergeTagPaths).toContain("contact.plan");
    expect(ctx.mergeTagPaths).toContain("contact.seats");
    // ...but another workspace's keys never leak.
    expect(ctx.mergeTagPaths).not.toContain("contact.competitorField");

    expect(body.subject).toBe("v2 is here");
    expect(body.doc).toEqual(GENERATED.doc);
    expect(body.model).toBe("claude-test");
    expect(body.attempts).toBe(1);
    expect(body.usage).toEqual({ inputTokens: 90, outputTokens: 240 });
    // validateEmailDoc echo — the guarded doc is structurally sound.
    expect((body.validation as { valid: boolean }).valid).toBe(true);
  });

  it("maps AiGraphError to 502 with issues and never the raw payload", async () => {
    const { AiGraphError } = await import("@loopkit/ai");
    generateMock.mockRejectedValue(
      new AiGraphError("email document failed validation", ["content.1.type: unknown node type"]),
    );

    const res = await copilot({ request: "给客户写一封生日祝福邮件，附上专属折扣" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe("ai_guard_rejected");
    expect(body.issues).toEqual(["content.1.type: unknown node type"]);
  });

  it("maps AiConfigError to 503 ai_not_configured", async () => {
    const { AiConfigError } = await import("@loopkit/ai");
    generateMock.mockRejectedValue(
      new AiConfigError("OPENAI_API_KEY is not set — AI features are unavailable"),
    );

    const res = await copilot({ request: "给客户写一封生日祝福邮件，附上专属折扣" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ai_not_configured");
  });
});
