/**
 * settingsAgent — the agent-first settings partner.
 *
 * The settings twin of journeyAgent.ts: the operator states what they want
 * their workspace to do in everyday language, the agent keeps a coverage
 * checklist (requirement → proposal changes), asks targeted questions when
 * key decisions are missing, and proposes concrete configuration changes it
 * can express over the writable domains.
 *
 * Same safety contract as every other AI→artifact pipeline: the model is
 * forced onto one tool; its input must survive guardSettingsAgentTurn (zod
 * structure + per-domain field validation + cross-checks against the live
 * configuration); a failed guard feeds back for one repair round. Raw model
 * payloads can never escape this module.
 *
 * Writable domains (deliberately small; expand with the same pattern):
 *   add_domain      — register a sending domain (DNS records are generated
 *                     by the platform at apply time, like templateDrafts).
 *   upsert_topic    — create or update a preference-center topic.
 *   upsert_rule     — create or update a lead scoring rule (matched by name).
 *   delete_rule     — remove a scoring rule that exists in the workspace.
 *   upsert_channel  — configure one messaging channel connection.
 *
 * Sensitive or read-only areas (billing, members, API keys, privacy jobs,
 * suppressions, forms, integrations, experiments, meetings) are out of
 * scope by design: the agent must clarify that it cannot change those
 * rather than propose something the guard would reject.
 */
import { z } from "zod";

import { runGuardedGeneration, type GenerateOptions, type MessageParam } from "./pipeline";

export const SETTINGS_AGENT_TOOL_NAME = "emit_settings_turn";

export const REQUIREMENT_STATUSES = ["covered", "partial", "uncovered", "needs_input"] as const;
export type SettingsRequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export interface SettingsRequirement {
  id: string;
  text: string;
  status: SettingsRequirementStatus;
  /** Refs of the proposal changes that implement this requirement. */
  changeRefs: string[];
  note?: string;
}

const MAX_REQUIREMENTS = 12;
const MAX_CHANGES = 12;
const MAX_MESSAGE = 2000;
const MAX_SUMMARY = 1200;
const MAX_NOTE = 400;
const MAX_RISKS = 6;

const CHANNEL_KINDS = ["email", "sms", "whatsapp", "push", "inapp"] as const;
const RULE_KINDS = ["property", "event", "page"] as const;
const RULE_OPERATORS = [
  "eq",
  "neq",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "missing",
] as const;
const TOPIC_CATEGORIES = ["marketing", "product", "transactional"] as const;

const refZod = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "ref must be kebab/snake case");

const requirementUpdateZod = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  text: z.string().trim().min(1).max(300),
  status: z.enum(REQUIREMENT_STATUSES),
  changeRefs: z.array(refZod).max(MAX_CHANGES).default([]),
  note: z.string().trim().max(MAX_NOTE).optional(),
});

const changeZod = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("add_domain"),
    ref: refZod,
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .min(4)
      .max(253)
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "invalid domain"),
    fromName: z.string().trim().min(1).max(120).optional(),
    fromEmail: z.string().trim().email().max(253).optional(),
  }),
  z.object({
    kind: z.literal("upsert_topic"),
    ref: refZod,
    key: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9._-]+$/, "topic key must be lowercase letters, digits, dots, dashes"),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(280).nullish(),
    category: z.enum(TOPIC_CATEGORIES).default("marketing"),
    sortOrder: z.number().int().min(0).max(999).default(0),
    active: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("upsert_rule"),
    ref: refZod,
    name: z.string().trim().min(1).max(120),
    ruleKind: z.enum(RULE_KINDS),
    propertyKey: z.string().trim().min(1).max(120).optional(),
    operator: z.enum(RULE_OPERATORS).optional(),
    propertyValue: z.string().trim().min(1).max(300).optional(),
    eventName: z.string().trim().min(1).max(120).optional(),
    pathContains: z.string().trim().min(1).max(200).optional(),
    windowHours: z.number().int().min(1).max(8760).nullish(),
    maxHits: z.number().int().min(1).max(1000).nullish(),
    points: z.number().int().min(-100).max(100),
    active: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("delete_rule"),
    ref: refZod,
    ruleId: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(300),
  }),
  z.object({
    kind: z.literal("upsert_channel"),
    ref: refZod,
    channel: z.enum(CHANNEL_KINDS),
    provider: z.string().trim().min(1).max(60).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    status: z.enum(["disabled", "enabled"]).default("enabled"),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
]);

export const settingsAgentTurnZod = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("clarify"),
    message: z.string().trim().min(1).max(MAX_MESSAGE),
    question: z
      .object({
        text: z.string().trim().min(1).max(300),
        options: z.array(z.string().trim().min(1).max(120)).min(2).max(6),
      })
      .optional(),
    requirementUpdates: z.array(requirementUpdateZod).max(MAX_REQUIREMENTS).optional(),
  }),
  z.object({
    action: z.literal("propose"),
    message: z.string().trim().min(1).max(MAX_MESSAGE),
    changes: z.array(changeZod).min(1).max(MAX_CHANGES),
    changeSummary: z.string().trim().min(1).max(MAX_SUMMARY),
    risks: z.array(z.string().trim().min(1).max(300)).max(MAX_RISKS).default([]),
    requirementUpdates: z.array(requirementUpdateZod).max(MAX_REQUIREMENTS),
  }),
]);

export class SettingsAgentError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  - ${i}`).join("\n")}` : message);
    this.name = "SettingsAgentError";
    this.issues = issues;
  }
}

export type SettingsChange = z.infer<typeof changeZod>;

/** Live configuration state the guard cross-checks proposals against. */
export interface SettingsGuardState {
  /** Existing sending domains — duplicate add_domain is a guard failure. */
  domains?: string[];
  /** Existing scoring rules — delete_rule must reference one of these ids. */
  rules?: { id: string; name: string }[];
}

export interface SettingsAgentTurn {
  action: "clarify" | "propose";
  /** Plain-language reply shown in the conversation thread. */
  message: string;
  /** Clickable quick-reply question (clarify only). */
  question?: { text: string; options: string[] };
  /** Guarded configuration changes (propose only). */
  changes: SettingsChange[];
  changeSummary?: string;
  risks?: string[];
  /** The FULL replacement coverage checklist. */
  requirements: SettingsRequirement[];
}

interface RawRequirementUpdate {
  id?: string;
  text: string;
  status: (typeof REQUIREMENT_STATUSES)[number];
  changeRefs?: string[];
  note?: string;
}

/** Normalize updates into stable requirement records, assigning ids for new rows. */
function normalizeRequirements(updates: RawRequirementUpdate[]): SettingsRequirement[] {
  const used = new Set<string>();
  for (const u of updates) if (u.id) used.add(u.id);
  let seq = 1;
  return updates.map((u) => {
    let id = u.id;
    if (!id) {
      do {
        id = `req-${seq}`;
        seq += 1;
      } while (used.has(id));
    }
    used.add(id);
    return {
      id,
      text: u.text,
      status: u.status,
      changeRefs: u.changeRefs ?? [],
      ...(u.note ? { note: u.note } : {}),
    };
  });
}

function unknownChangeRefs(updates: RawRequirementUpdate[], changes: SettingsChange[]): string[] {
  const refs = new Set(changes.map((c) => c.ref));
  return updates.flatMap((u) => (u.changeRefs ?? []).filter((r) => !refs.has(r)));
}

function validateRuleFields(change: Extract<SettingsChange, { kind: "upsert_rule" }>): string[] {
  const issues: string[] = [];
  if (change.ruleKind === "property") {
    if (!change.propertyKey) issues.push(`${change.ref}: property rules require propertyKey`);
    if (!change.operator) issues.push(`${change.ref}: property rules require operator`);
    if (
      change.operator &&
      change.operator !== "exists" &&
      change.operator !== "missing" &&
      !change.propertyValue
    ) {
      issues.push(`${change.ref}: operator ${change.operator} requires propertyValue`);
    }
  }
  if (change.ruleKind === "event" && !change.eventName) {
    issues.push(`${change.ref}: event rules require eventName`);
  }
  if (change.ruleKind === "page" && !change.pathContains) {
    issues.push(`${change.ref}: page rules require pathContains`);
  }
  return issues;
}

/**
 * Validate one agent turn. `guardState` carries the live configuration the
 * proposal is checked against — unknown delete_rule ids and duplicate
 * add_domain entries are guard failures so the repair round forces the
 * model to fix them, never silently dropped.
 */
export function guardSettingsAgentTurn(
  raw: unknown,
  guardState: SettingsGuardState = {},
): SettingsAgentTurn {
  const parsed = settingsAgentTurnZod.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsAgentError(
      "agent turn failed structural validation",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const data = parsed.data;

  if (data.action === "clarify") {
    const updates = data.requirementUpdates ?? [];
    const dangling = updates.flatMap((u) => u.changeRefs ?? []);
    if (dangling.length > 0) {
      throw new SettingsAgentError("clarify turns cannot reference proposal changes", [
        `unexpected changeRefs: ${[...new Set(dangling)].join(", ")}`,
      ]);
    }
    return {
      action: "clarify",
      message: data.message,
      ...(data.question ? { question: data.question } : {}),
      changes: [],
      requirements: normalizeRequirements(updates),
    };
  }

  const issues: string[] = [];

  const refs = new Set<string>();
  for (const change of data.changes) {
    if (refs.has(change.ref)) issues.push(`duplicate change ref: ${change.ref}`);
    refs.add(change.ref);
  }

  const knownDomains = new Set((guardState.domains ?? []).map((d) => d.toLowerCase()));
  for (const change of data.changes) {
    if (change.kind === "add_domain" && knownDomains.has(change.domain)) {
      issues.push(`domain ${change.domain} already exists — do not add it again`);
    }
    if (change.kind === "upsert_rule") {
      issues.push(...validateRuleFields(change));
    }
    if (change.kind === "delete_rule") {
      const known = (guardState.rules ?? []).some((r) => r.id === change.ruleId);
      if (!known) issues.push(`delete_rule references unknown ruleId: ${change.ruleId}`);
    }
  }

  const unknownRefs = unknownChangeRefs(data.requirementUpdates, data.changes);
  if (unknownRefs.length > 0) {
    issues.push(
      `requirement references change refs missing from the proposal: ${[...new Set(unknownRefs)].join(", ")}`,
    );
  }

  if (issues.length > 0) throw new SettingsAgentError("proposed changes rejected", issues);

  return {
    action: "propose",
    message: data.message,
    changes: data.changes,
    changeSummary: data.changeSummary,
    risks: data.risks,
    requirements: normalizeRequirements(data.requirementUpdates),
  };
}

/** Shape of one scoring rule as injected into the model context. */
export interface SettingsRuleSnapshot {
  id: string;
  name: string;
  kind: string;
  propertyKey?: string | null;
  operator?: string | null;
  propertyValue?: string | null;
  eventName?: string | null;
  pathContains?: string | null;
  windowHours?: number | null;
  maxHits?: number | null;
  points: number;
  active: boolean;
}

export interface SettingsConfigSnapshot {
  domains: { id: string; domain: string; status: string; fromEmail: string | null }[];
  topics: {
    id: string;
    key: string;
    name: string;
    category: string;
    active: boolean;
    sortOrder: number;
  }[];
  rules: SettingsRuleSnapshot[];
  channels: { channel: string; provider: string; status: string; name: string }[];
}

export interface SettingsAgentContext {
  workspaceName?: string;
  /** The operator's standing request, in their own words. */
  brief: string;
  /** Current coverage checklist (may be empty before the first turn). */
  requirements: SettingsRequirement[];
  /** The operator's new message for this turn. */
  userMessage: string;
  /** Recent conversation (oldest first), already trimmed by the caller. */
  history?: { role: "user" | "agent"; content: string }[];
  /** Live configuration reality — the model may only reference these. */
  configSnapshot: SettingsConfigSnapshot;
  /** Contact property keys scoring rules may compare against. */
  contactPropertyKeys?: string[];
  /** Known event names scoring rules may reference. */
  knownEventNames?: string[];
}

export function settingsAgentToolSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["clarify", "propose"] },
      message: { type: "string" },
      question: {
        type: "object",
        properties: {
          text: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["text", "options"],
      },
      changes: {
        type: "array",
        maxItems: MAX_CHANGES,
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["add_domain", "upsert_topic", "upsert_rule", "delete_rule", "upsert_channel"],
            },
            ref: {
              type: "string",
              description: "Short kebab-case key unique within this proposal",
            },
            domain: { type: "string" },
            fromName: { type: "string" },
            fromEmail: { type: "string" },
            key: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            category: { type: "string", enum: [...TOPIC_CATEGORIES] },
            sortOrder: { type: "number" },
            active: { type: "boolean" },
            ruleKind: { type: "string", enum: [...RULE_KINDS] },
            propertyKey: { type: "string" },
            operator: { type: "string", enum: [...RULE_OPERATORS] },
            propertyValue: { type: "string" },
            eventName: { type: "string" },
            pathContains: { type: "string" },
            windowHours: { type: "number" },
            maxHits: { type: "number" },
            points: { type: "number" },
            ruleId: { type: "string" },
            reason: { type: "string" },
            channel: { type: "string", enum: [...CHANNEL_KINDS] },
            provider: { type: "string" },
            status: { type: "string", enum: ["disabled", "enabled"] },
            config: { type: "object" },
          },
          required: ["kind", "ref"],
        },
      },
      changeSummary: { type: "string" },
      risks: { type: "array", items: { type: "string" } },
      requirementUpdates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            status: { type: "string", enum: [...REQUIREMENT_STATUSES] },
            changeRefs: { type: "array", items: { type: "string" } },
            note: { type: "string" },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["action", "message"],
  };
}

export function buildSettingsAgentSystemPrompt(): string {
  return `You are the agent-first settings partner inside Loopkit's settings workbench.

The operator is a business user. They describe how they want their workspace configured in everyday language (大白话); you turn that intent into concrete configuration changes and keep an honest, human-readable coverage table so they always know whether the proposal fulfills their request. You are their guide: when something is ambiguous or a decision is missing, ask; when you can act, propose.

You MUST answer by calling the ${SETTINGS_AGENT_TOOL_NAME} tool with exactly one action:

- action "clarify" — the request is missing key decisions (which domain, what topic categories, how many points, which channel provider). Ask AT MOST two concrete questions. Prefer clickable options (2-4 short options per question) over open questions. You may still update the coverage checklist. changeRefs must stay empty in clarify turns.
- action "propose" — you can express the request as concrete changes. Provide the full change list, a change summary in business language, notable risks, and the full updated coverage checklist. Never propose a change you know is invalid. DNS records are generated automatically for add_domain — a missing DNS setup is NEVER a reason to wait; mention in risks that records must be published and verified before sending.

Writable change kinds (only these; every change needs a unique short "ref"):
- add_domain { domain, fromName?, fromEmail? } — register a sending domain. The domain must not already exist in the current configuration.
- upsert_topic { key, name, description?, category, sortOrder?, active? } — create/update a preference-center topic. key: lowercase letters/digits/dots/dashes. category: marketing (default, honors unsubscribe), product, or transactional (system-critical, never suppressible).
- upsert_rule { name, ruleKind, points, active?, ...fields } — create or update a lead scoring rule matched by name. ruleKind "property" (fit): propertyKey + operator + propertyValue (propertyValue not needed for exists/missing). ruleKind "event" (engagement): eventName, optional windowHours (1-8760h). ruleKind "page" (intent): pathContains. points: -100..100 additive. Prefer known contactPropertyKeys for propertyKey and known event names for eventName.
- delete_rule { ruleId, reason } — remove an existing scoring rule by its id from the current configuration. Deleting rules the operator did not mention is NOT allowed; put the impact in risks.
- upsert_channel { channel, provider?, name?, status?, config? } — configure one messaging channel (email/sms/whatsapp/push/inapp). Only change a channel the request calls for; channel config is provider-specific free-form JSON, keep existing values unless the operator asks.

Out of scope — NEVER propose changes for: billing/plans, team members or invites, API keys, privacy jobs, suppressions, forms, integrations, experiments, meetings. If the request lands there, use clarify to explain that this area is not agent-configurable and point to the right professional panel. Do not propose changes that are already satisfied by the current configuration — state in the coverage checklist that they are covered instead.

Coverage checklist rules (requirementUpdates):
- ALWAYS return the complete checklist — it fully replaces the stored one. One entry per distinct requirement in the operator's brief (plus any they added later). Do not drop satisfied requirements.
- status: "covered" = the proposal implements it; "partial" = implemented with gaps (explain in note); "uncovered" = nothing implements it yet; "needs_input" = blocked on the operator's answer (put the question in note).
- changeRefs lists the change refs that implement the requirement. Every ref MUST exist in the changes array of this same proposal. For requirements already satisfied by the current configuration, leave changeRefs empty and explain in note.
- Reuse existing requirement ids from the current checklist when the requirement carries over; new requirements get a new short id.

Language: message, changeSummary, risks, requirement text/note, and question text MUST be written in Simplified Chinese, in plain business language a non-technical marketer understands. Never mention JSON, refs, tool internals, or database terms in the message text.`;
}

function formatRuleSnapshot(rule: SettingsRuleSnapshot): string {
  const condition =
    rule.kind === "property"
      ? `${rule.propertyKey} ${rule.operator ?? ""} ${rule.propertyValue ?? ""}`.trim()
      : rule.kind === "event"
        ? `${rule.eventName ?? ""}${rule.windowHours ? ` (${rule.windowHours}h window)` : ""}`
        : `path contains ${rule.pathContains ?? ""}`;
  return `- ${rule.name} [id=${rule.id}] ${rule.kind}: ${condition} · ${rule.points > 0 ? "+" : ""}${rule.points}分 · ${rule.active ? "启用" : "停用"}`;
}

export function buildSettingsAgentUserPrompt(ctx: SettingsAgentContext): string {
  const parts: string[] = [];
  parts.push(`Workspace: ${ctx.workspaceName ?? "工作区"}`);
  parts.push(
    `Operator's standing brief (their own words; may be empty):\n${ctx.brief || "（暂无）"}`,
  );
  parts.push(
    `Current coverage checklist:\n${
      ctx.requirements.length > 0 ? JSON.stringify(ctx.requirements, null, 2) : "（尚未建立）"
    }`,
  );
  const snap = ctx.configSnapshot;
  parts.push(
    `Current configuration (authoritative — the model may only reference what exists here):\n` +
      `Sending domains (${
        snap.domains.length === 0
          ? "none yet"
          : snap.domains
              .map((d) => `${d.domain} · ${d.status} · from ${d.fromEmail ?? "默认"}`)
              .join("; ")
      })\n` +
      `Preference topics (${
        snap.topics.length === 0
          ? "none yet"
          : snap.topics
              .map((t) => `${t.key} · ${t.name} · ${t.category} · ${t.active ? "启用" : "停用"}`)
              .join("; ")
      })\n` +
      `Lead scoring rules (${
        snap.rules.length === 0 ? "none yet" : "\n" + snap.rules.map(formatRuleSnapshot).join("\n")
      })\n` +
      `Channels (${
        snap.channels.length === 0
          ? "none yet"
          : snap.channels.map((c) => `${c.channel} · ${c.provider} · ${c.status}`).join("; ")
      })`,
  );
  if (ctx.contactPropertyKeys && ctx.contactPropertyKeys.length > 0) {
    parts.push(`Known contact property keys: ${ctx.contactPropertyKeys.slice(0, 60).join(", ")}`);
  }
  if (ctx.knownEventNames && ctx.knownEventNames.length > 0) {
    parts.push(`Known event names: ${ctx.knownEventNames.slice(0, 50).join(", ")}`);
  }
  parts.push(`Operator's new message:\n${ctx.userMessage}`);
  parts.push(
    "Respond with exactly one tool call: clarify (at most two questions, changeRefs empty) or propose (full change list + change summary + risks + full coverage checklist).",
  );
  return parts.join("\n\n");
}

export function settingsAgentRepairPrompt(errorText: string): string {
  return `Your previous tool call was rejected:\n${errorText}\n\nCall ${SETTINGS_AGENT_TOOL_NAME} again with a corrected complete action. Remember: "propose" must carry the full change list (each with a unique kebab-case ref), the change summary, risks, and the full coverage checklist whose changeRefs all exist in the proposal; delete_rule ruleIds must exist in the current configuration; add_domain domains must not already exist.`;
}

export interface SettingsAgentResult {
  turn: SettingsAgentTurn;
  model: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
}

export type SettingsAgentOptions = GenerateOptions;

function toMessageParams(history: { role: "user" | "agent"; content: string }[]): MessageParam[] {
  return history.map((h) => ({
    role: h.role === "user" ? "user" : "assistant",
    content: h.content,
  }));
}

export async function runSettingsAgentTurn(
  ctx: SettingsAgentContext,
  options: SettingsAgentOptions = {},
): Promise<SettingsAgentResult> {
  const generated = await runGuardedGeneration(options, {
    system: buildSettingsAgentSystemPrompt(),
    userPrompt: buildSettingsAgentUserPrompt(ctx),
    toolName: SETTINGS_AGENT_TOOL_NAME,
    toolDescription:
      "Submit the agent's next step: a clarifying question (action=clarify) or a concrete configuration proposal with its coverage checklist (action=propose).",
    toolParameters: settingsAgentToolSchema(),
    guard: (input) =>
      guardSettingsAgentTurn(input, {
        domains: ctx.configSnapshot.domains.map((d) => d.domain),
        rules: ctx.configSnapshot.rules.map((r) => ({ id: r.id, name: r.name })),
      }),
    repairPrompt: settingsAgentRepairPrompt(""),
    history: toMessageParams(ctx.history ?? []),
  });

  return {
    turn: generated.result,
    model: generated.model,
    attempts: generated.attempts,
    usage: generated.usage,
  };
}
