/**
 * settingsNarrative — the plain-language walkthrough of the CURRENT
 * configuration, the settings twin of journeyExplanation.
 *
 * One-shot generation over the configuration snapshot (domains, topics,
 * scoring rules, channels). The narrative is a cache, not a gate: callers
 * pin it to a fingerprint of the snapshot they generated it from and
 * regenerate only when that fingerprint drifts.
 */
import { z } from "zod";

import type { Generated, GenerateOptions } from "./pipeline";
import { runGuardedGeneration } from "./pipeline";
import type { SettingsConfigSnapshot } from "./settingsAgent";

const TOOL_NAME = "emit_settings_narrative";
const MAX_SECTIONS = 8;
const MAX_NOTES = 6;
const MAX_TITLE = 120;
const MAX_TEXT = 600;

export const settingsNarrativeZod = z.object({
  headline: z.string().trim().min(1).max(MAX_TITLE),
  summary: z.string().trim().min(1).max(MAX_TEXT),
  sections: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80),
        explanation: z.string().trim().min(1).max(MAX_TEXT),
      }),
    )
    .max(MAX_SECTIONS),
  notes: z.array(z.string().trim().min(1).max(300)).max(MAX_NOTES).default([]),
});

export type SettingsNarrative = z.infer<typeof settingsNarrativeZod>;

export function settingsNarrativeToolParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: "One plain-language sentence describing how this workspace is configured.",
      },
      summary: {
        type: "string",
        description: "A concise business explanation of the whole configuration.",
      },
      sections: {
        type: "array",
        maxItems: MAX_SECTIONS,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Area name, e.g. 发信域名 / 评分规则" },
            explanation: {
              type: "string",
              description: "What is configured in this area and what it means in business terms.",
            },
          },
          required: ["title", "explanation"],
        },
      },
      notes: {
        type: "array",
        maxItems: MAX_NOTES,
        items: { type: "string" },
        description: "Gaps or risks worth the operator's attention, no guessing.",
      },
    },
    required: ["headline", "summary", "sections", "notes"],
  };
}

export class SettingsNarrativeError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`settings narrative failed validation: ${issues.join("; ")}`);
    this.name = "SettingsNarrativeError";
    this.issues = issues;
  }
}

export function guardSettingsNarrative(input: unknown): SettingsNarrative {
  const parsed = settingsNarrativeZod.safeParse(input);
  if (!parsed.success) {
    throw new SettingsNarrativeError(
      parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return {
    headline: parsed.data.headline.trim().slice(0, MAX_TITLE),
    summary: parsed.data.summary.trim().slice(0, MAX_TEXT),
    sections: parsed.data.sections.slice(0, MAX_SECTIONS).map((s) => ({
      title: s.title.trim().slice(0, 80),
      explanation: s.explanation.trim().slice(0, MAX_TEXT),
    })),
    notes: parsed.data.notes.slice(0, MAX_NOTES).map((note) => note.trim().slice(0, 300)),
  };
}

export interface SettingsNarrativeInput {
  workspaceName?: string;
  snapshot: SettingsConfigSnapshot;
  language?: string;
}

function formatRule(rule: SettingsConfigSnapshot["rules"][number]): string {
  const condition =
    rule.kind === "property"
      ? `${rule.propertyKey} ${rule.operator ?? ""} ${rule.propertyValue ?? ""}`.trim()
      : rule.kind === "event"
        ? `${rule.eventName ?? ""}${rule.windowHours ? ` (${rule.windowHours}h)` : ""}`
        : `path contains ${rule.pathContains ?? ""}`;
  return `${rule.name} (${rule.kind}: ${condition}, ${rule.points > 0 ? "+" : ""}${rule.points}分, ${rule.active ? "启用" : "停用"})`;
}

export function buildSettingsNarrativeSystemPrompt(): string {
  return `You are a business-language interpreter for a marketing workspace's configuration.

You receive the current configuration snapshot (sending domains, preference topics, lead scoring rules, messaging channels). Explain to a non-technical marketer how their workspace is currently set up.

Rules:
- Describe the exact current configuration, not recommendations or imagined settings.
- Translate technical values into business language: a pending domain is "域名已添加，等待 DNS 生效验证", a scoring rule is "命中这个条件的联系人会加分".
- Cover every non-empty area in sections; skip areas that have no configuration at all (or fold them into notes as gaps).
- Do not invent values, quotas, providers, or behavior that is not present in the snapshot.
- Mention notable gaps (e.g. no verified domain, no scoring rules) in notes instead of guessing.
- Write every text field in the requested language, normally Simplified Chinese.
- You MUST call the ${TOOL_NAME} tool with the complete structured narrative. Never answer in prose outside the tool.`;
}

export function buildSettingsNarrativeUserPrompt(input: SettingsNarrativeInput): string {
  const snap = input.snapshot;
  return [
    input.workspaceName ? `Workspace: ${input.workspaceName}` : null,
    `Requested language: ${input.language ?? "简体中文"}`,
    "Current configuration snapshot (authoritative):",
    JSON.stringify(
      {
        sendingDomains: snap.domains.map((d) => ({
          domain: d.domain,
          status: d.status,
          fromEmail: d.fromEmail,
        })),
        preferenceTopics: snap.topics.map((t) => ({
          key: t.key,
          name: t.name,
          category: t.category,
          active: t.active,
        })),
        scoringRules: snap.rules.map(formatRule),
        channels: snap.channels.map((c) => ({
          channel: c.channel,
          provider: c.provider,
          status: c.status,
        })),
      },
      null,
      2,
    ),
    "Explain the current configuration area by area in plain business language.",
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

const REPAIR_PROMPT = `Your narrative did not pass validation. Fix every listed issue and call ${TOOL_NAME} again with the complete corrected narrative.`;

export function generateSettingsNarrative(
  input: SettingsNarrativeInput,
  options: GenerateOptions = {},
): Promise<Generated<SettingsNarrative>> {
  return runGuardedGeneration(options, {
    system: buildSettingsNarrativeSystemPrompt(),
    userPrompt: buildSettingsNarrativeUserPrompt(input),
    toolName: TOOL_NAME,
    toolDescription: "Submit a complete plain-language explanation of the current configuration.",
    toolParameters: settingsNarrativeToolParameters(),
    guard: guardSettingsNarrative,
    repairPrompt: REPAIR_PROMPT,
  });
}

export { TOOL_NAME as SETTINGS_NARRATIVE_TOOL_NAME };
