/**
 * Agent-first settings workbench routes — the settings twin of the journey
 * agent endpoints in routes/journeys.ts.
 *
 * Conversation state for /settings. The intent row (brief + coverage
 * checklist + cached narrative) is created lazily on the first turn; the
 * transcript lives in settings_agent_message. A proposal is a list of
 * guarded configuration changes; applying it materializes every change
 * through the exact same core functions the manual professional panels
 * use (createSendingDomain, upsertPreferenceTopic, lead scoring CRUD,
 * upsertChannelConnection) — there is no second write path.
 */
import { createHash } from "node:crypto";

import {
  AiConfigError,
  generateSettingsNarrative,
  runSettingsAgentTurn,
  settingsAgentTurnZod,
  SettingsAgentError,
  SettingsNarrativeError,
  type SettingsChange,
  type SettingsConfigSnapshot,
  type SettingsRequirement,
} from "@loopkit/ai";
import { db } from "@loopkit/db";
import {
  channelConnection,
  contactEvent,
  preferenceTopic,
  sendingDomain,
  settingsAgentMessage,
  settingsIntent,
} from "@loopkit/db/schema";
import {
  createLeadScoreRule,
  createSendingDomain,
  deleteLeadScoreRule,
  listChannelConnections,
  listContactPropertyKeys,
  listLeadScoreRules,
  listPreferenceTopics,
  listSendingDomains,
  recordAuditLog,
  updateLeadScoreRule,
  upsertChannelConnection,
  upsertPreferenceTopic,
  type LeadScoreRuleRow,
} from "@loopkit/core";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";

export const settingsAgentRouter = new Hono<{ Variables: AuthVariables }>();

/* Configuration snapshot + fingerprint ------------------------------------- */

type SendingDomainRow = typeof sendingDomain.$inferSelect;
type PreferenceTopicRow = typeof preferenceTopic.$inferSelect;
type ChannelConnectionRow = typeof channelConnection.$inferSelect;

function toSnapshot(
  domains: SendingDomainRow[],
  topics: PreferenceTopicRow[],
  rules: LeadScoreRuleRow[],
  channels: ChannelConnectionRow[],
): SettingsConfigSnapshot {
  return {
    domains: domains.map((d) => ({
      id: d.id,
      domain: d.domain,
      status: d.status,
      fromEmail: d.fromEmail,
    })),
    topics: topics.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      category: t.category,
      active: t.active,
      sortOrder: t.sortOrder,
    })),
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      propertyKey: r.propertyKey,
      operator: r.operator,
      propertyValue: r.propertyValue,
      eventName: r.eventName,
      pathContains: r.pathContains,
      windowHours: r.windowHours,
      maxHits: r.maxHits,
      points: r.points,
      active: r.active,
    })),
    channels: channels.map((c) => ({
      channel: c.channel,
      provider: c.provider,
      status: c.status,
      name: c.name,
    })),
  };
}

/**
 * Fingerprint of the configuration snapshot the narrative is pinned to.
 * Content-based: any materialized change (agent apply or a manual edit in
 * a professional panel) moves it, which is what marks the narrative stale.
 */
export function configFingerprint(snapshot: SettingsConfigSnapshot): string {
  const canonical = JSON.stringify({
    domains: snapshot.domains.map((d) => [d.domain, d.status, d.fromEmail]),
    topics: snapshot.topics.map((t) => [t.key, t.name, t.category, t.active, t.sortOrder]),
    rules: snapshot.rules.map((r) => [
      r.name,
      r.kind,
      r.propertyKey,
      r.operator,
      r.propertyValue,
      r.eventName,
      r.pathContains,
      r.windowHours,
      r.maxHits,
      r.points,
      r.active,
    ]),
    channels: snapshot.channels.map((c) => [c.channel, c.provider, c.status]),
  });
  return createHash("sha1").update(canonical).digest("hex");
}

export async function loadSettingsSnapshot(workspaceId: string) {
  const [domains, topics, rules, channels] = await Promise.all([
    listSendingDomains(db, workspaceId),
    listPreferenceTopics(db, workspaceId),
    listLeadScoreRules(db, workspaceId),
    listChannelConnections(db, workspaceId),
  ]);
  const snapshot = toSnapshot(domains, topics, rules, channels);
  return { snapshot, fingerprint: configFingerprint(snapshot) };
}

/* Intent (brief + coverage + narrative cache) ------------------------------ */

async function ensureSettingsIntent(workspaceId: string, initialBrief = "") {
  const [existing] = await db
    .select()
    .from(settingsIntent)
    .where(eq(settingsIntent.workspaceId, workspaceId));
  if (existing) return existing;
  const [created] = await db
    .insert(settingsIntent)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      brief: initialBrief,
      requirements: [],
    })
    .returning();
  return created!;
}

function intentDto(row: typeof settingsIntent.$inferSelect) {
  return {
    brief: row.brief,
    requirements: (row.requirements ?? []) as SettingsRequirement[],
    narrative: row.narrative ?? null,
    narrativeFingerprint: row.narrativeFingerprint ?? null,
    updatedAt: row.updatedAt,
  };
}

/* Shared helpers ----------------------------------------------------------- */

const SETTINGS_HISTORY_LIMIT = 20;

async function loadHistory(workspaceId: string) {
  return (
    await db
      .select({ role: settingsAgentMessage.role, content: settingsAgentMessage.content })
      .from(settingsAgentMessage)
      .where(eq(settingsAgentMessage.workspaceId, workspaceId))
      .orderBy(desc(settingsAgentMessage.createdAt))
      .limit(SETTINGS_HISTORY_LIMIT)
  ).reverse();
}

function messageDto(row: typeof settingsAgentMessage.$inferSelect) {
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
  };
}

/** Maps AI pipeline failures onto the same HTTP semantics as journeys. */
function agentAiErrorStatus(error: unknown): { status: ContentfulStatusCode; body: object } {
  if (error instanceof AiConfigError) {
    return { status: 503, body: { error: "ai_not_configured", message: error.message } };
  }
  if (error instanceof SettingsAgentError || error instanceof SettingsNarrativeError) {
    return {
      status: 502,
      body: { error: "ai_guard_rejected", issues: error.issues, message: error.message },
    };
  }
  return {
    status: 500,
    body: {
      error: "ai_unavailable",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/* Session ------------------------------------------------------------------ */

settingsAgentRouter.get("/session", async (c) => {
  const { workspaceId } = c.get("auth");
  const [intent] = await db
    .select()
    .from(settingsIntent)
    .where(eq(settingsIntent.workspaceId, workspaceId));
  const messages = await db
    .select()
    .from(settingsAgentMessage)
    .where(eq(settingsAgentMessage.workspaceId, workspaceId))
    .orderBy(settingsAgentMessage.createdAt)
    .limit(200);
  const { snapshot, fingerprint } = await loadSettingsSnapshot(workspaceId);

  return c.json({
    intent: intent ? intentDto(intent) : null,
    messages: messages.map(messageDto),
    config: snapshot,
    fingerprint,
  });
});

/* Turn --------------------------------------------------------------------- */

const turnSchema = z.object({ message: z.string().trim().min(1).max(4000) });

settingsAgentRouter.post("/turn", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = turnSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const intent = await ensureSettingsIntent(workspaceId, parsed.data.message);
  const history = await loadHistory(workspaceId);
  const { snapshot, fingerprint } = await loadSettingsSnapshot(workspaceId);

  const [propertyKeys, events] = await Promise.all([
    listContactPropertyKeys(db, workspaceId).catch(() => [] as string[]),
    db
      .selectDistinct({ name: contactEvent.name })
      .from(contactEvent)
      .where(eq(contactEvent.workspaceId, workspaceId))
      .limit(50)
      .catch(() => [] as { name: string }[]),
  ]);

  try {
    const result = await runSettingsAgentTurn({
      brief: intent.brief,
      requirements: (intent.requirements ?? []) as SettingsRequirement[],
      userMessage: parsed.data.message,
      history,
      configSnapshot: snapshot,
      contactPropertyKeys: propertyKeys,
      knownEventNames: events.map((e) => e.name),
    });
    const turn = result.turn;

    const [userMessage] = await db
      .insert(settingsAgentMessage)
      .values({
        id: crypto.randomUUID(),
        workspaceId,
        role: "user",
        kind: "text",
        content: parsed.data.message,
        payload: null,
      })
      .returning();

    const payload =
      turn.action === "propose"
        ? {
            changeSummary: turn.changeSummary,
            risks: turn.risks,
            requirements: turn.requirements,
            changes: turn.changes,
            changeCount: turn.changes.length,
          }
        : turn.question
          ? { question: turn.question.text, options: turn.question.options }
          : null;
    const [agentMessage] = await db
      .insert(settingsAgentMessage)
      .values({
        id: crypto.randomUUID(),
        workspaceId,
        role: "agent",
        kind: turn.action === "propose" ? "proposal" : turn.question ? "question" : "text",
        content: turn.message,
        payload: payload as Record<string, unknown> | null,
      })
      .returning();

    if (turn.requirements.length > 0) {
      await db
        .update(settingsIntent)
        .set({ requirements: turn.requirements })
        .where(eq(settingsIntent.workspaceId, workspaceId));
    }

    return c.json({
      userMessage: messageDto(userMessage!),
      message: messageDto(agentMessage!),
      intent: intentDto({
        ...intent,
        requirements:
          turn.requirements.length > 0
            ? (turn.requirements as unknown as SettingsRequirement[])
            : ((intent.requirements ?? []) as SettingsRequirement[]),
      }),
      config: snapshot,
      fingerprint,
      usage: result.usage,
    });
  } catch (error) {
    const { status, body } = agentAiErrorStatus(error);
    return c.json(body, status);
  }
});

/* Apply -------------------------------------------------------------------- */

/**
 * One materialized change. `skipped` rows are expected outcomes (already
 * present, already deleted), not failures — the proposal card shows them
 * as "no-op".
 */
interface AppliedChange {
  ref: string;
  kind: SettingsChange["kind"];
  status: "created" | "updated" | "deleted" | "skipped" | "error";
  target: string;
  detail?: string;
}

function describeRule(rule: Extract<SettingsChange, { kind: "upsert_rule" }>): string {
  if (rule.ruleKind === "property")
    return `${rule.propertyKey} ${rule.operator} ${rule.propertyValue ?? ""}`;
  if (rule.ruleKind === "event") return rule.eventName ?? "";
  return rule.pathContains ?? "";
}

function materializeChanges(
  changes: SettingsChange[],
  current: {
    domains: { id: string; domain: string }[];
    topics: { id: string; key: string }[];
    rules: { id: string; name: string }[];
    channels: { channel: string }[];
  },
): {
  run: (workspaceId: string) => Promise<AppliedChange[]>;
} {
  return {
    async run(workspaceId: string): Promise<AppliedChange[]> {
      const applied: AppliedChange[] = [];
      for (const change of changes) {
        const ref = change.ref;
        const kind = change.kind;
        try {
          if (change.kind === "add_domain") {
            const exists = current.domains.some((d) => d.domain === change.domain);
            if (exists) {
              applied.push({
                ref: change.ref,
                kind: change.kind,
                status: "skipped",
                target: change.domain,
                detail: "域名已存在",
              });
              continue;
            }
            const row = await createSendingDomain(db, {
              workspaceId,
              domain: change.domain,
              fromName: change.fromName,
              fromEmail: change.fromEmail,
            });
            current.domains.push({ id: row!.id, domain: row!.domain });
            applied.push({
              ref: change.ref,
              kind: change.kind,
              status: "created",
              target: change.domain,
              detail: "DNS 记录已生成，需到 DNS 服务商发布后验证",
            });
            continue;
          }
          if (change.kind === "upsert_topic") {
            const exists = current.topics.some((t) => t.key === change.key);
            const row = await upsertPreferenceTopic(db, {
              workspaceId,
              key: change.key,
              name: change.name,
              description: change.description ?? null,
              category: change.category,
              sortOrder: change.sortOrder,
              active: change.active,
            });
            if (!exists) current.topics.push({ id: row!.id, key: row!.key });
            applied.push({
              ref: change.ref,
              kind: change.kind,
              status: exists ? "updated" : "created",
              target: change.name,
            });
            continue;
          }
          if (change.kind === "upsert_rule") {
            const existing = current.rules.find((r) => r.name === change.name);
            const input = {
              name: change.name,
              active: change.active,
              kind: change.ruleKind,
              propertyKey: change.propertyKey ?? null,
              operator: change.operator ?? null,
              propertyValue: change.propertyValue ?? null,
              eventName: change.eventName ?? null,
              pathContains: change.pathContains ?? null,
              windowHours: change.windowHours ?? null,
              maxHits: change.maxHits ?? null,
              points: change.points,
            };
            if (existing) {
              await updateLeadScoreRule(db, workspaceId, existing.id, input);
              applied.push({
                ref: change.ref,
                kind: change.kind,
                status: "updated",
                target: change.name,
                detail: describeRule(change),
              });
            } else {
              const row = await createLeadScoreRule(db, workspaceId, input);
              current.rules.push({ id: row!.id, name: row!.name });
              applied.push({
                ref: change.ref,
                kind: change.kind,
                status: "created",
                target: change.name,
                detail: describeRule(change),
              });
            }
            continue;
          }
          if (change.kind === "delete_rule") {
            const existing = current.rules.find((r) => r.id === change.ruleId);
            if (!existing) {
              applied.push({
                ref: change.ref,
                kind: change.kind,
                status: "skipped",
                target: change.ruleId,
                detail: "规则不存在或已删除",
              });
              continue;
            }
            await deleteLeadScoreRule(db, workspaceId, change.ruleId);
            current.rules = current.rules.filter((r) => r.id !== change.ruleId);
            applied.push({
              ref: change.ref,
              kind: change.kind,
              status: "deleted",
              target: existing.name,
            });
            continue;
          }
          // upsert_channel
          const exists = current.channels.some((ch) => ch.channel === change.channel);
          await upsertChannelConnection(db, {
            workspaceId,
            channel: change.channel,
            provider: change.provider,
            name: change.name,
            status: change.status,
            config: change.config,
          });
          if (!exists) current.channels.push({ channel: change.channel });
          applied.push({
            ref: change.ref,
            kind: change.kind,
            status: exists ? "updated" : "created",
            target: change.channel,
            detail: change.provider ? `provider: ${change.provider}` : undefined,
          });
        } catch (error) {
          applied.push({
            ref,
            kind,
            status: "error",
            target: ref,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return applied;
    },
  };
}

settingsAgentRouter.post("/apply", async (c) => {
  const authCtx = c.get("auth");
  const workspaceId = authCtx.workspaceId;
  const userId = authCtx.kind === "session" ? authCtx.userId : null;
  const parsed = z
    .object({ messageId: z.string().trim().min(1) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [proposal] = await db
    .select()
    .from(settingsAgentMessage)
    .where(
      and(
        eq(settingsAgentMessage.id, parsed.data.messageId),
        eq(settingsAgentMessage.workspaceId, workspaceId),
        eq(settingsAgentMessage.role, "agent"),
        eq(settingsAgentMessage.kind, "proposal"),
      ),
    );
  if (!proposal) return c.json({ error: "proposal_not_found" }, 404);

  const payload = (proposal.payload ?? {}) as {
    changes?: SettingsChange[];
    requirements?: SettingsRequirement[];
    changeSummary?: string;
  };
  if (!payload.changes || payload.changes.length === 0) {
    return c.json({ error: "proposal_has_no_changes" }, 400);
  }

  // Re-validate before materializing: payload jsonb is untrusted storage.
  // Structure is enforced with the same zod the turn guard uses; drift
  // against the live configuration (delete_rule target already gone,
  // domain already added) is NOT a rejection — materializeChanges handles
  // it per-change as skipped so one stale row never sinks the proposal.
  const { snapshot, fingerprint: beforeFingerprint } = await loadSettingsSnapshot(workspaceId);
  const revalidated = settingsAgentTurnZod.safeParse({
    action: "propose",
    message: proposal.content,
    changes: payload.changes,
    changeSummary: payload.changeSummary ?? "",
    risks: [],
    requirementUpdates: (payload.requirements ?? []).map((r) => ({
      id: r.id,
      text: r.text,
      status: r.status,
      changeRefs: r.changeRefs,
      note: r.note,
    })),
  });
  if (!revalidated.success || revalidated.data.action !== "propose") {
    return c.json(
      {
        error: "proposal_invalid",
        message: "提案数据未通过校验，请让 Agent 重新生成",
        issues: revalidated.success
          ? ["proposal action must be propose"]
          : revalidated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400,
    );
  }
  const changes: SettingsChange[] = revalidated.data.changes;

  const applied = await materializeChanges(changes, {
    domains: snapshot.domains.map((d) => ({ id: d.id, domain: d.domain })),
    topics: snapshot.topics.map((t) => ({ id: t.id, key: t.key })),
    rules: snapshot.rules.map((r) => ({ id: r.id, name: r.name })),
    channels: snapshot.channels.map((ch) => ({ channel: ch.channel })),
  }).run(workspaceId);

  // Refresh the plain-language narrative against the post-apply state.
  const after = await loadSettingsSnapshot(workspaceId);
  let narrative: Record<string, unknown> | null = null;
  let narrativeFingerprint: string | null = null;
  try {
    const explanation = await generateSettingsNarrative({ snapshot: after.snapshot });
    narrative = {
      headline: explanation.result.headline,
      summary: explanation.result.summary,
      sections: explanation.result.sections,
      notes: explanation.result.notes,
    };
    narrativeFingerprint = after.fingerprint;
  } catch {
    // Narrative is a cache, not a gate — the apply itself already succeeded.
  }

  await ensureSettingsIntent(workspaceId);
  await db
    .update(settingsIntent)
    .set({
      narrative,
      narrativeFingerprint,
      ...(payload.requirements ? { requirements: payload.requirements } : {}),
    })
    .where(eq(settingsIntent.workspaceId, workspaceId));

  await recordAuditLog(db, {
    workspaceId,
    action: "settings.agent_apply",
    actorUserId: userId ?? null,
    targetType: "workspace",
    summary: payload.changeSummary ?? "Agent 配置变更",
    metadata: {
      messageId: parsed.data.messageId,
      fingerprintBefore: beforeFingerprint,
      fingerprintAfter: after.fingerprint,
      applied,
    },
  });

  return c.json({
    applied,
    fingerprint: after.fingerprint,
    narrative,
    narrativeFingerprint,
  });
});

/* Narrative refresh --------------------------------------------------------- */

settingsAgentRouter.post("/refresh-narrative", async (c) => {
  const { workspaceId } = c.get("auth");
  const [intent] = await db
    .select()
    .from(settingsIntent)
    .where(eq(settingsIntent.workspaceId, workspaceId));

  const { snapshot, fingerprint } = await loadSettingsSnapshot(workspaceId);

  if (intent?.narrative && intent.narrativeFingerprint === fingerprint) {
    return c.json({
      refreshed: false,
      narrative: intent.narrative,
      narrativeFingerprint: intent.narrativeFingerprint,
      fingerprint,
    });
  }

  try {
    const explanation = await generateSettingsNarrative({ snapshot });
    const narrative = {
      headline: explanation.result.headline,
      summary: explanation.result.summary,
      sections: explanation.result.sections,
      notes: explanation.result.notes,
    };
    await ensureSettingsIntent(workspaceId);
    await db
      .update(settingsIntent)
      .set({ narrative, narrativeFingerprint: fingerprint })
      .where(eq(settingsIntent.workspaceId, workspaceId));
    return c.json({ refreshed: true, narrative, narrativeFingerprint: fingerprint, fingerprint });
  } catch (error) {
    const { status, body } = agentAiErrorStatus(error);
    return c.json(body, status);
  }
});
