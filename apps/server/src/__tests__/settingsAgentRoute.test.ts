/**
 * Agent-first settings routes (GET session / POST turn / POST apply /
 * POST refresh-narrative): real database, mocked @loopkit/ai. What this
 * proves:
 *  - the first turn lazily creates the intent brief and persists the
 *    transcript;
 *  - a propose turn is stored as a proposal message carrying guarded
 *    changes;
 *  - applying it materializes every change through the same core functions
 *    the manual panels use (domains with generated DNS records, topic
 *    upsert, scoring rule create/update/delete, channel upsert);
 *  - the fingerprint moves after apply and the narrative is regenerated
 *    against the new state; refresh-narrative serves the cache while the
 *    fingerprint is unchanged;
 *  - a structurally invalid stored proposal is rejected (400) and bad
 *    input maps to 400.
 */
import { createDb, type Db } from "@loopkit/db";
import {
  auditLog,
  channelConnection,
  contactEvent,
  leadScoreRule,
  preferenceTopic,
  sendingDomain,
  settingsAgentMessage,
  settingsIntent,
  user,
  workspace,
} from "@loopkit/db/schema";
import { Hono } from "hono";
import { eq, getTableName, sql } from "drizzle-orm";
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

const { agentTurnMock, narrativeMock } = vi.hoisted(() => ({
  agentTurnMock: vi.fn(),
  narrativeMock: vi.fn(),
}));

vi.mock("@loopkit/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loopkit/ai")>();
  class AiConfigError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AiConfigError";
    }
  }
  class SettingsAgentError extends Error {
    readonly issues: string[];
    constructor(message: string, issues: string[] = []) {
      super(message);
      this.name = "SettingsAgentError";
      this.issues = issues;
    }
  }
  class SettingsNarrativeError extends Error {
    readonly issues: string[];
    constructor(message: string, issues: string[] = []) {
      super(message);
      this.name = "SettingsNarrativeError";
      this.issues = issues;
    }
  }
  return {
    AiConfigError,
    SettingsAgentError,
    SettingsNarrativeError,
    // Real pure exports: apply re-validates the stored payload with the
    // production zod; no LLM involved.
    settingsAgentTurnZod: actual.settingsAgentTurnZod,
    runSettingsAgentTurn: agentTurnMock,
    generateSettingsNarrative: narrativeMock,
  };
});

const db: Db = createDb(testDbUrl);
const { settingsAgentRouter } = await import("../routes/settingsAgent");

const TABLES = [
  settingsAgentMessage,
  settingsIntent,
  sendingDomain,
  preferenceTopic,
  leadScoreRule,
  channelConnection,
  contactEvent,
  auditLog,
  user,
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
  app.route("/v1/settings/agent", settingsAgentRouter);
  return app;
}

const NARRATIVE = {
  headline: "工作区已配置 1 个发信域名",
  summary: "当前配置的中文概览。",
  sections: [{ title: "发信域名", explanation: "mail.acme.com 已验证。" }],
  notes: [],
};

async function seedWorkspace(): Promise<string> {
  // The apply route writes an audit row whose actor_user_id FKs to user.
  await db.insert(user).values({ id: "user-1", name: "Op", email: "op@example.com" });
  await db.insert(workspace).values({ id: "ws-1", name: "Acme", slug: "acme" });
  return "ws-1";
}

describe("settings agent routes", () => {
  const app = buildApp();

  beforeEach(async () => {
    await resetTables();
    agentTurnMock.mockReset();
    narrativeMock.mockReset();
    await seedWorkspace();
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("session on a fresh workspace returns an empty snapshot", async () => {
    const res = await app.request("/v1/settings/agent/session");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      intent: unknown;
      messages: unknown[];
      config: { domains: unknown[]; topics: unknown[]; rules: unknown[]; channels: unknown[] };
      fingerprint: string;
    };
    expect(body.intent).toBeNull();
    expect(body.messages).toEqual([]);
    expect(body.config.domains).toEqual([]);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it("creates the intent lazily, persists the transcript and returns a proposal", async () => {
    agentTurnMock.mockResolvedValue({
      turn: {
        action: "propose",
        message: "已生成配置提案。",
        changes: [
          {
            ref: "domain-mail",
            kind: "add_domain",
            domain: "mail.acme.com",
            fromName: "Acme",
          },
        ],
        changeSummary: "添加发信域名",
        risks: [],
        requirements: [
          { id: "req-1", text: "用自己的域名发信", status: "covered", changeRefs: ["domain-mail"] },
        ],
      },
      model: "claude-test",
      attempts: 1,
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const res = await app.request("/v1/settings/agent/turn", {
      method: "POST",
      body: JSON.stringify({ message: "用 mail.acme.com 发邮件" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userMessage: { content: string };
      message: { kind: string; payload: { changeCount?: number; changes: unknown[] } };
      intent: { brief: string; requirements: unknown[] };
      fingerprint: string;
    };

    expect(body.userMessage.content).toBe("用 mail.acme.com 发邮件");
    expect(body.message.kind).toBe("proposal");
    expect(body.message.payload.changeCount).toBe(1);
    expect(body.intent.brief).toBe("用 mail.acme.com 发邮件");
    expect(body.intent.requirements).toHaveLength(1);

    // The context the model saw is the live configuration snapshot.
    const ctx = agentTurnMock.mock.calls[0]![0] as {
      brief: string;
      configSnapshot: { domains: unknown[] };
    };
    expect(ctx.brief).toBe("用 mail.acme.com 发邮件");
    expect(ctx.configSnapshot.domains).toEqual([]);

    const [intentRow] = await db.select().from(settingsIntent);
    expect(intentRow!.brief).toBe("用 mail.acme.com 发邮件");
    const messages = await db.select().from(settingsAgentMessage);
    expect(messages).toHaveLength(2);
  });

  it("stores a clarify turn as a question message", async () => {
    agentTurnMock.mockResolvedValue({
      turn: {
        action: "clarify",
        message: "发件人显示名用什么？",
        question: { text: "发件人显示名", options: ["Acme 团队", "Acme 官方"] },
        requirements: [],
      },
      model: "m",
      attempts: 1,
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const res = await app.request("/v1/settings/agent/turn", {
      method: "POST",
      body: JSON.stringify({ message: "配置发信域名" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      message: { kind: string; payload: { options: string[] } };
    };
    expect(body.message.kind).toBe("question");
    expect(body.message.payload.options).toHaveLength(2);
  });

  it("apply materializes every change kind through the manual-panel write paths", async () => {
    // Seed one existing rule the proposal will delete.
    await db.insert(leadScoreRule).values({
      id: "rule-old",
      workspaceId: "ws-1",
      name: "旧规则",
      kind: "page",
      pathContains: "/old",
      points: 5,
      active: true,
    });

    agentTurnMock.mockResolvedValue({
      turn: {
        action: "propose",
        message: "提案",
        changes: [
          { ref: "domain-mail", kind: "add_domain", domain: "mail.acme.com", fromName: "Acme" },
          {
            ref: "topic-product",
            kind: "upsert_topic",
            key: "product-updates",
            name: "产品更新",
            category: "product",
          },
          {
            ref: "rule-pricing",
            kind: "upsert_rule",
            name: "定价页访问",
            ruleKind: "page",
            pathContains: "/pricing",
            points: 15,
          },
          { ref: "rule-drop", kind: "delete_rule", ruleId: "rule-old", reason: "过时" },
          {
            ref: "channel-sms",
            kind: "upsert_channel",
            channel: "sms",
            provider: "console",
            status: "enabled",
          },
        ],
        changeSummary: "域名 + 主题 + 评分规则 + 渠道",
        risks: ["DNS 记录需要发布后验证"],
        requirements: [
          { id: "req-1", text: "域名发信", status: "covered", changeRefs: ["domain-mail"] },
        ],
      },
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const turnRes = await app.request("/v1/settings/agent/turn", {
      method: "POST",
      body: JSON.stringify({ message: "全部配好" }),
      headers: { "content-type": "application/json" },
    });
    const { message } = (await turnRes.json()) as { message: { id: string } };

    narrativeMock.mockResolvedValue({
      result: NARRATIVE,
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const applyRes = await app.request("/v1/settings/agent/apply", {
      method: "POST",
      body: JSON.stringify({ messageId: message.id }),
      headers: { "content-type": "application/json" },
    });
    expect(applyRes.status).toBe(200);
    const applyBody = (await applyRes.json()) as {
      applied: { ref: string; status: string; target: string }[];
      fingerprint: string;
      narrative: { headline: string } | null;
      narrativeFingerprint: string | null;
    };

    expect(applyBody.applied).toEqual([
      {
        ref: "domain-mail",
        kind: "add_domain",
        status: "created",
        target: "mail.acme.com",
        detail: "DNS 记录已生成，需到 DNS 服务商发布后验证",
      },
      { ref: "topic-product", kind: "upsert_topic", status: "created", target: "产品更新" },
      {
        ref: "rule-pricing",
        kind: "upsert_rule",
        status: "created",
        target: "定价页访问",
        detail: "/pricing",
      },
      { ref: "rule-drop", kind: "delete_rule", status: "deleted", target: "旧规则" },
      {
        ref: "channel-sms",
        kind: "upsert_channel",
        status: "created",
        target: "sms",
        detail: "provider: console",
      },
    ]);
    expect(applyBody.narrative?.headline).toBe(NARRATIVE.headline);
    expect(applyBody.narrativeFingerprint).toBe(applyBody.fingerprint);

    // Domain: real row with generated DNS records, matching the panel path.
    const [domainRow] = await db
      .select()
      .from(sendingDomain)
      .where(eq(sendingDomain.workspaceId, "ws-1"));
    expect(domainRow!.domain).toBe("mail.acme.com");
    expect(domainRow!.fromName).toBe("Acme");
    expect(domainRow!.dnsRecords.length).toBeGreaterThan(0);

    const [topicRow] = await db
      .select()
      .from(preferenceTopic)
      .where(eq(preferenceTopic.workspaceId, "ws-1"));
    expect(topicRow!.key).toBe("product-updates");

    const rules = await db
      .select()
      .from(leadScoreRule)
      .where(eq(leadScoreRule.workspaceId, "ws-1"));
    expect(rules.map((r) => r.name)).toEqual(["定价页访问"]);
    expect(rules[0]!.points).toBe(15);

    const [channelRow] = await db
      .select()
      .from(channelConnection)
      .where(eq(channelConnection.workspaceId, "ws-1"));
    expect(channelRow!.channel).toBe("sms");
    expect(channelRow!.status).toBe("enabled");

    // Audit: the agent apply row, plus the per-resource rows the core
    // write functions emit (same as the manual panels — domain.create…).
    const audits = await db.select().from(auditLog).where(eq(auditLog.workspaceId, "ws-1"));
    expect(audits.some((a) => a.action === "settings.agent_apply")).toBe(true);
    expect(audits.some((a) => a.action === "domain.create")).toBe(true);

    const [intentRow] = await db.select().from(settingsIntent);
    expect(intentRow!.narrativeFingerprint).toBe(applyBody.fingerprint);
  });

  it("apply skips drift (already-deleted rule) and rejects a tampered payload", async () => {
    agentTurnMock.mockResolvedValue({
      turn: {
        action: "propose",
        message: "提案",
        changes: [{ ref: "rule-drop", kind: "delete_rule", ruleId: "rule-gone", reason: "过时" }],
        changeSummary: "s",
        risks: [],
        requirements: [
          { id: "req-1", text: "删除规则", status: "covered", changeRefs: ["rule-drop"] },
        ],
      },
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const turnRes = await app.request("/v1/settings/agent/turn", {
      method: "POST",
      body: JSON.stringify({ message: "删规则" }),
      headers: { "content-type": "application/json" },
    });
    const { message } = (await turnRes.json()) as { message: { id: string } };

    // The rule vanished between the turn and the apply — drift, not tampering.
    const driftRes = await app.request("/v1/settings/agent/apply", {
      method: "POST",
      body: JSON.stringify({ messageId: message.id }),
      headers: { "content-type": "application/json" },
    });
    expect(driftRes.status).toBe(200);
    const driftBody = (await driftRes.json()) as {
      applied: { status: string }[];
    };
    expect(driftBody.applied[0]!.status).toBe("skipped");

    // A payload that no longer parses (missing ref) is rejected outright.
    const [proposalRow] = await db
      .select()
      .from(settingsAgentMessage)
      .where(eq(settingsAgentMessage.id, message.id));
    await db
      .update(settingsAgentMessage)
      .set({
        payload: {
          ...(proposalRow!.payload as object),
          changes: [{ kind: "delete_rule", ruleId: "x", reason: "no ref" }],
        },
      })
      .where(eq(settingsAgentMessage.id, message.id));
    const tamperedRes = await app.request("/v1/settings/agent/apply", {
      method: "POST",
      body: JSON.stringify({ messageId: message.id }),
      headers: { "content-type": "application/json" },
    });
    expect(tamperedRes.status).toBe(400);
    const tamperedBody = (await tamperedRes.json()) as { error: string };
    expect(tamperedBody.error).toBe("proposal_invalid");
  });

  it("refresh-narrative serves the cache until the fingerprint moves", async () => {
    const { configFingerprint, loadSettingsSnapshot } = await import("../routes/settingsAgent");
    const { snapshot, fingerprint } = await loadSettingsSnapshot("ws-1");
    await db.insert(settingsIntent).values({
      id: "intent-1",
      workspaceId: "ws-1",
      brief: "b",
      requirements: [],
      narrative: NARRATIVE,
      narrativeFingerprint: configFingerprint(snapshot),
    });

    const cached = await app.request("/v1/settings/agent/refresh-narrative", { method: "POST" });
    expect(cached.status).toBe(200);
    const cachedBody = (await cached.json()) as { refreshed: boolean };
    expect(cachedBody.refreshed).toBe(false);
    expect(narrativeMock).not.toHaveBeenCalled();

    // A manual change (panel edit) moves the fingerprint — now it regenerates.
    await db.insert(preferenceTopic).values({
      id: "topic-1",
      workspaceId: "ws-1",
      key: "news",
      name: "新闻",
      category: "marketing",
    });
    narrativeMock.mockResolvedValue({
      result: NARRATIVE,
      model: "m",
      attempts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const stale = await app.request("/v1/settings/agent/refresh-narrative", { method: "POST" });
    const staleBody = (await stale.json()) as { refreshed: boolean; fingerprint: string };
    expect(staleBody.refreshed).toBe(true);
    expect(staleBody.fingerprint).not.toBe(fingerprint);
    expect(narrativeMock).toHaveBeenCalledTimes(1);
  });

  it("maps SettingsAgentError to 502 ai_guard_rejected and bad input to 400", async () => {
    const { SettingsAgentError } = await import("@loopkit/ai");
    agentTurnMock.mockRejectedValue(new SettingsAgentError("guard failed", ["bad change"]));
    const rejected = await app.request("/v1/settings/agent/turn", {
      method: "POST",
      body: JSON.stringify({ message: "继续" }),
      headers: { "content-type": "application/json" },
    });
    expect(rejected.status).toBe(502);
    const rejectedBody = (await rejected.json()) as { error: string; issues: string[] };
    expect(rejectedBody.error).toBe("ai_guard_rejected");
    expect(rejectedBody.issues).toEqual(["bad change"]);

    const empty = await app.request("/v1/settings/agent/turn", {
      method: "POST",
      body: JSON.stringify({ message: "" }),
      headers: { "content-type": "application/json" },
    });
    expect(empty.status).toBe(400);

    const missing = await app.request("/v1/settings/agent/apply", {
      method: "POST",
      body: JSON.stringify({ messageId: "nope" }),
      headers: { "content-type": "application/json" },
    });
    expect(missing.status).toBe(404);
  });
});
