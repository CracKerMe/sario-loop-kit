/**
 * Agent workbench routes (GET session / POST turn / POST apply /
 * POST refresh-narrative): real database, mocked @loopkit/ai. What this
 * proves:
 *  - the first turn lazily creates the intent brief from the operator's
 *    message and persists the full transcript;
 *  - a propose turn is stored as a proposal message and applying it writes
 *    a new draft version plus a refreshed narrative pinned to that version;
 *  - refresh-narrative serves the cache when the version is unchanged;
 *  - JourneyAgentError maps to 502 ai_guard_rejected, malformed input to 400.
 */
import { createDb, type Db } from "@loopkit/db";
import {
  emailTemplate,
  journey,
  journeyAgentMessage,
  journeyIntent,
  journeyVersion,
  workspace,
} from "@loopkit/db/schema";
import { Hono } from "hono";
import { desc, eq, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthVariables } from "../middleware/auth";

const { testDbUrl, originalDatabaseUrl } = vi.hoisted(() => {
  const fallback = "postgresql://postgres:password@localhost:5432/loopkit";
  const base = process.env.DATABASE_URL ?? fallback;
  const url = new URL(base);
  url.pathname = "/loopkit_test_server";
  const testDbUrl = url.toString();
  process.env.DATABASE_URL = testDbUrl;
  return { testDbUrl, originalDatabaseUrl: base };
});

const { agentTurnMock, explanationMock, emailContentMock } = vi.hoisted(() => ({
  agentTurnMock: vi.fn(),
  explanationMock: vi.fn(),
  emailContentMock: vi.fn(),
}));

vi.mock("@loopkit/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loopkit/ai")>();
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
  class JourneyAgentError extends Error {
    readonly issues: string[];
    constructor(message: string, issues: string[] = []) {
      super(message);
      this.name = "JourneyAgentError";
      this.issues = issues;
    }
  }
  class JourneyExplanationError extends Error {
    readonly issues: string[];
    constructor(message: string, issues: string[] = []) {
      super(message);
      this.name = "JourneyExplanationError";
      this.issues = issues;
    }
  }
  return {
    AiGraphError,
    AiConfigError,
    JourneyAgentError,
    JourneyExplanationError,
    // Real guard: apply must re-validate draft docs with the production path.
    guardEmailContent: actual.guardEmailContent,
    generateJourneyGraph: vi.fn(),
    generateJourneyExplanation: explanationMock,
    generateJourneyOptimization: vi.fn(),
    generateSimulationInsight: vi.fn(),
    generateEmailContent: emailContentMock,
    runJourneyAgentTurn: agentTurnMock,
  };
});

const db: Db = createDb(testDbUrl);
const { journeysRouter } = await import("../routes/journeys");

const TABLES = [
  journeyAgentMessage,
  journeyIntent,
  journeyVersion,
  emailTemplate,
  journey,
  workspace,
] as const;

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

const GRAPH = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      data: { trigger: { kind: "event", name: "order.placed" } },
      position: { x: 0, y: 0 },
    },
    {
      id: "e",
      type: "email",
      data: { templateId: "tpl-1", subject: "Hi" },
      position: { x: 100, y: 0 },
    },
    { id: "x", type: "exit", data: {}, position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t", target: "e" },
    { id: "e2", source: "e", target: "x" },
  ],
};

const NARRATIVE = {
  headline: "下单后发一封欢迎邮件",
  summary: "用户下单后立即发送欢迎邮件。",
  steps: [{ nodeId: "e", title: "发欢迎邮件", explanation: "使用 Welcome 模板发送。" }],
  branches: [],
  notes: [],
};

async function seedJourney(): Promise<string> {
  await db.insert(workspace).values({ id: "ws-1", name: "Test", slug: "test" });
  await db.insert(emailTemplate).values({
    id: "tpl-1",
    workspaceId: "ws-1",
    name: "Welcome",
    subject: "Welcome",
    html: "<p>Hi</p>",
  });
  await db.insert(journey).values({
    id: "j-1",
    workspaceId: "ws-1",
    name: "挽回流程",
    workflowId: "wf-1",
    trigger: { kind: "manual" },
    status: "draft",
  });
  await db.insert(journeyVersion).values({
    journeyId: "j-1",
    version: 1,
    graph: GRAPH,
    compiled: {},
  });
  return "j-1";
}

describe("journey agent routes", () => {
  const app = buildApp();

  beforeEach(async () => {
    await resetTables();
    agentTurnMock.mockReset();
    explanationMock.mockReset();
    emailContentMock.mockReset();
    await seedJourney();
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  function turn(body: unknown, id = "j-1") {
    return app.request(`/v1/journeys/${id}/agent/turn`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("creates the intent lazily, persists the transcript and returns a proposal", async () => {
    agentTurnMock.mockResolvedValue({
      turn: {
        action: "propose",
        message: "已生成 3 步计划。",
        graph: GRAPH,
        changeSummary: "触发 → 邮件 → 退出",
        risks: [],
        requirements: [{ id: "req-1", text: "下单触发", status: "covered", nodeIds: ["t"] }],
      },
      model: "claude-test",
      attempts: 1,
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const res = await turn({ message: "下单后发一封欢迎邮件" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userMessage: { content: string };
      message: { kind: string; content: string; payload: { nodeCount?: number } };
      intent: { brief: string; requirements: unknown[] };
    };

    expect(body.userMessage.content).toBe("下单后发一封欢迎邮件");
    expect(body.message.kind).toBe("proposal");
    expect(body.message.payload.nodeCount).toBe(3);
    expect(body.intent.brief).toBe("下单后发一封欢迎邮件");
    expect(body.intent.requirements).toHaveLength(1);

    // The context the model saw is workspace-scoped.
    const ctx = agentTurnMock.mock.calls[0]![0] as {
      brief: string;
      templates: { id: string }[];
      currentGraph: { nodes: unknown[] } | null;
    };
    expect(ctx.brief).toBe("下单后发一封欢迎邮件");
    expect(ctx.templates).toEqual([{ id: "tpl-1", name: "Welcome" }]);
    expect(ctx.currentGraph?.nodes).toHaveLength(3);

    const [intentRow] = await db.select().from(journeyIntent);
    expect(intentRow!.brief).toBe("下单后发一封欢迎邮件");
    const messages = await db.select().from(journeyAgentMessage);
    expect(messages).toHaveLength(2);
  });

  it("stores a clarify turn as a question message", async () => {
    agentTurnMock.mockResolvedValue({
      turn: {
        action: "clarify",
        message: "优惠券从哪来？",
        question: { text: "优惠券来源", options: ["联系人属性", "写进模板"] },
        requirements: [],
      },
      model: "claude-test",
      attempts: 1,
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const res = await turn({ message: "给老用户发券" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      message: { kind: string; payload: { options: string[] } };
    };
    expect(body.message.kind).toBe("question");
    expect(body.message.payload.options).toHaveLength(2);
  });

  it("apply writes a draft version, refreshes the narrative and pins its version", async () => {
    agentTurnMock.mockResolvedValue({
      turn: {
        action: "propose",
        message: "提案",
        graph: GRAPH,
        changeSummary: "s",
        risks: [],
        requirements: [{ id: "req-1", text: "下单触发", status: "covered", nodeIds: ["t"] }],
      },
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const turnRes = await turn({ message: "改一下" });
    const { message } = (await turnRes.json()) as { message: { id: string } };

    explanationMock.mockResolvedValue({
      result: NARRATIVE,
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const applyRes = await app.request("/v1/journeys/j-1/agent/apply", {
      method: "POST",
      body: JSON.stringify({ messageId: message.id }),
      headers: { "content-type": "application/json" },
    });
    expect(applyRes.status).toBe(200);
    const applyBody = (await applyRes.json()) as {
      version: number;
      validation: { valid: boolean };
      narrative: { headline: string } | null;
      narrativeVersion: number | null;
    };
    expect(applyBody.version).toBe(2);
    expect(applyBody.validation.valid).toBe(true);
    expect(applyBody.narrative?.headline).toBe(NARRATIVE.headline);
    expect(applyBody.narrativeVersion).toBe(2);

    const [intentRow] = await db.select().from(journeyIntent);
    expect(intentRow!.narrativeVersion).toBe(2);
  });

  it("refresh-narrative serves the cache until the version moves", async () => {
    // Seed intent with a current narrative.
    await db.insert(journeyIntent).values({
      id: "intent-1",
      journeyId: "j-1",
      workspaceId: "ws-1",
      brief: "b",
      requirements: [],
      narrative: NARRATIVE,
      narrativeVersion: 1,
    });

    explanationMock.mockResolvedValue({
      result: NARRATIVE,
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const cached = await app.request("/v1/journeys/j-1/agent/refresh-narrative", {
      method: "POST",
    });
    expect(cached.status).toBe(200);
    const cachedBody = (await cached.json()) as { refreshed: boolean };
    expect(cachedBody.refreshed).toBe(false);
    expect(explanationMock).not.toHaveBeenCalled();

    // Bump the draft to v2 — now the narrative is stale and regenerates.
    await db.insert(journeyVersion).values({
      journeyId: "j-1",
      version: 2,
      graph: GRAPH,
      compiled: {},
    });
    const stale = await app.request("/v1/journeys/j-1/agent/refresh-narrative", { method: "POST" });
    const staleBody = (await stale.json()) as { refreshed: boolean; narrativeVersion: number };
    expect(staleBody.refreshed).toBe(true);
    expect(staleBody.narrativeVersion).toBe(2);
    expect(explanationMock).toHaveBeenCalledTimes(1);
  });

  it("maps JourneyAgentError to 502 ai_guard_rejected and bad input to 400", async () => {
    const { JourneyAgentError } = await import("@loopkit/ai");
    agentTurnMock.mockRejectedValue(new JourneyAgentError("guard failed", ["bad requirement"]));
    const rejected = await turn({ message: "继续" });
    expect(rejected.status).toBe(502);
    const rejectedBody = (await rejected.json()) as { error: string; issues: string[] };
    expect(rejectedBody.error).toBe("ai_guard_rejected");
    expect(rejectedBody.issues).toEqual(["bad requirement"]);

    expect((await turn({ message: "" })).status).toBe(400);
    expect(
      (
        await app.request("/v1/journeys/j-1/agent/apply", {
          method: "POST",
          body: JSON.stringify({ messageId: "nope" }),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(404);
  });

  const DRAFT_DOC = {
    type: "doc",
    content: [
      {
        type: "emailSection",
        content: [{ type: "emailParagraph", content: [{ type: "text", text: "欢迎加入！" }] }],
      },
    ],
  };

  const DRAFT_GRAPH = {
    nodes: [
      {
        id: "t",
        type: "trigger",
        data: { trigger: { kind: "event", name: "order.placed" } },
        position: { x: 0, y: 0 },
      },
      {
        id: "e",
        type: "email",
        data: { templateId: "draft-welcome", subject: "Hi" },
        position: { x: 100, y: 0 },
      },
      { id: "x", type: "exit", data: {}, position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "t", target: "e" },
      { id: "e2", source: "e", target: "x" },
    ],
  };

  const draftTurnResponse = {
    turn: {
      action: "propose",
      message: "已附模板草稿。",
      graph: DRAFT_GRAPH,
      changeSummary: "s",
      risks: [],
      requirements: [{ id: "req-1", text: "下单触发", status: "covered", nodeIds: ["t"] }],
      templateDrafts: [
        { key: "draft-welcome", name: "欢迎邮件", purpose: "新用户注册后的第一封欢迎邮件" },
      ],
    },
    model: "m",
    attempts: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
  };

  it("generates copy for proposal templateDrafts and stores them in the payload", async () => {
    emailContentMock.mockResolvedValue({
      subject: "欢迎加入！",
      doc: DRAFT_DOC,
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    agentTurnMock.mockResolvedValue(draftTurnResponse);

    const res = await turn({ message: "下单后发欢迎邮件" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      message: { payload: { templateDrafts: { key: string; subject?: string; doc?: unknown }[] } };
    };
    expect(emailContentMock).toHaveBeenCalledTimes(1);
    const emailCtx = emailContentMock.mock.calls[0]![0] as {
      request: string;
      mergeTagPaths: string[];
    };
    expect(emailCtx.request).toContain("新用户注册后的第一封欢迎邮件");
    expect(emailCtx.mergeTagPaths.length).toBeGreaterThan(0);
    expect(body.message.payload.templateDrafts[0]!.subject).toBe("欢迎加入！");
    expect(body.message.payload.templateDrafts[0]!.doc).toEqual(DRAFT_DOC);
  });

  it("apply creates templates from drafts, remaps templateIds and returns createdTemplates", async () => {
    emailContentMock.mockResolvedValue({
      subject: "欢迎加入！",
      doc: DRAFT_DOC,
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    agentTurnMock.mockResolvedValue(draftTurnResponse);
    const turnRes = await turn({ message: "改一下" });
    const { message } = (await turnRes.json()) as { message: { id: string } };
    explanationMock.mockResolvedValue({
      result: NARRATIVE,
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const applyRes = await app.request("/v1/journeys/j-1/agent/apply", {
      method: "POST",
      body: JSON.stringify({ messageId: message.id }),
      headers: { "content-type": "application/json" },
    });
    expect(applyRes.status).toBe(200);
    const applied = (await applyRes.json()) as {
      version: number;
      createdTemplates: { key: string; templateId: string; name: string }[];
    };
    expect(applied.createdTemplates).toHaveLength(1);
    const created = applied.createdTemplates[0]!;
    expect(created.key).toBe("draft-welcome");
    expect(created.templateId).not.toBe("draft-welcome");

    const [templateRow] = await db
      .select()
      .from(emailTemplate)
      .where(eq(emailTemplate.id, created.templateId));
    expect(templateRow!.id).toBe(created.templateId);
    expect(templateRow!.name).toBe("欢迎邮件");
    expect(templateRow!.source).toBe("tiptap");
    expect(templateRow!.html).toContain("欢迎加入");

    const [versionRow] = await db
      .select()
      .from(journeyVersion)
      .orderBy(desc(journeyVersion.version))
      .limit(1);
    const graph = versionRow!.graph as { nodes: { id: string; data: { templateId: string } }[] };
    expect(graph.nodes.find((n) => n.id === "e")!.data.templateId).toBe(created.templateId);
  });

  it("regenerate-template rewrites the stored draft copy", async () => {
    emailContentMock.mockResolvedValue({
      subject: "旧主题",
      doc: DRAFT_DOC,
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    agentTurnMock.mockResolvedValue(draftTurnResponse);
    const turnRes = await turn({ message: "改一下" });
    const { message } = (await turnRes.json()) as { message: { id: string } };

    emailContentMock.mockResolvedValue({
      subject: "全新主题",
      doc: DRAFT_DOC,
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const regenRes = await app.request("/v1/journeys/j-1/agent/regenerate-template", {
      method: "POST",
      body: JSON.stringify({
        messageId: message.id,
        key: "draft-welcome",
        instruction: "更热情一些",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(regenRes.status).toBe(200);
    const regen = (await regenRes.json()) as { draft: { subject: string } };
    expect(regen.draft.subject).toBe("全新主题");
    expect(emailContentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: expect.stringContaining("更热情一些") }),
    );

    const [stored] = await db
      .select()
      .from(journeyAgentMessage)
      .where(eq(journeyAgentMessage.id, message.id));
    const payload = stored!.payload as {
      templateDrafts: { key: string; subject?: string }[];
    };
    expect(payload.templateDrafts[0]!.subject).toBe("全新主题");
  });
});
