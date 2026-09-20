/**
 * AI journey optimization proposal (P3.5 / L3).
 *
 * The model receives only aggregates — node funnel, run counts, email
 * delivery funnel, a compact graph reference — never contact identities
 * or property values. Its tool input is layered-guarded:
 *
 *   1. analysis / canary metadata (this module's zod + rebuild)
 *   2. proposed graph via guardAiGraph() — whitelist + validateGraph
 *
 * There is no path for a raw model payload to reach journey_version.
 */
import { z } from "zod";
import { AiGraphError, guardAiGraph } from "./graphGuard";
import type { JourneyGraph } from "@loopkit/journey";

export const JOURNEY_OPTIMIZATION_TOOL_NAME = "emit_journey_optimization";

const MAX_SUMMARY = 1600;
const MAX_TITLE = 200;
const MAX_DIAGNOSIS = 10;
const MAX_IMPACT = 8;
const MAX_MAPPING = 40;
const MIN_CANARY = 1;
const MAX_CANARY = 50;

export const journeyOptimizationAnalysisZod = z.object({
  summary: z.string().min(1).max(MAX_SUMMARY),
  diagnosis: z
    .array(
      z.object({
        nodeId: z.string().min(1).max(80),
        nodeType: z.string().min(1).max(40).optional(),
        issue: z.string().min(1).max(MAX_SUMMARY),
        severity: z.enum(["info", "warning", "critical"]),
      }),
    )
    .max(MAX_DIAGNOSIS),
  changes: z
    .array(
      z.object({
        nodeId: z.string().min(1).max(80),
        action: z.enum(["modify", "add", "remove", "rewire"]),
        description: z.string().min(1).max(MAX_SUMMARY),
      }),
    )
    .max(MAX_DIAGNOSIS),
  expectedImpact: z
    .array(
      z.object({
        metric: z.string().min(1).max(80),
        direction: z.enum(["increase", "decrease", "neutral"]),
        note: z.string().min(1).max(MAX_TITLE),
      }),
    )
    .max(MAX_IMPACT),
  canaryPercent: z.number().int().min(MIN_CANARY).max(MAX_CANARY),
  nodeMapping: z.record(z.string(), z.string()).optional(),
});

export type JourneyOptimizationAnalysis = z.infer<typeof journeyOptimizationAnalysisZod>;

export const journeyOptimizationProposalZod = z.object({
  analysis: journeyOptimizationAnalysisZod,
  graph: z.unknown(),
});

export type JourneyOptimizationProposal = {
  analysis: JourneyOptimizationAnalysis;
  graph: JourneyGraph;
};

export function journeyOptimizationToolParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      analysis: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "2-5 sentence diagnosis grounded in the funnel numbers.",
          },
          diagnosis: {
            type: "array",
            maxItems: MAX_DIAGNOSIS,
            items: {
              type: "object",
              properties: {
                nodeId: { type: "string" },
                nodeType: { type: "string" },
                issue: { type: "string" },
                severity: { type: "string", enum: ["info", "warning", "critical"] },
              },
              required: ["nodeId", "issue", "severity"],
            },
          },
          changes: {
            type: "array",
            maxItems: MAX_DIAGNOSIS,
            items: {
              type: "object",
              properties: {
                nodeId: { type: "string" },
                action: { type: "string", enum: ["modify", "add", "remove", "rewire"] },
                description: { type: "string" },
              },
              required: ["nodeId", "action", "description"],
            },
          },
          expectedImpact: {
            type: "array",
            maxItems: MAX_IMPACT,
            items: {
              type: "object",
              properties: {
                metric: { type: "string" },
                direction: { type: "string", enum: ["increase", "decrease", "neutral"] },
                note: { type: "string" },
              },
              required: ["metric", "direction", "note"],
            },
          },
          canaryPercent: {
            type: "integer",
            minimum: MIN_CANARY,
            maximum: MAX_CANARY,
            description: "Recommended canary traffic share for the first release.",
          },
          nodeMapping: {
            type: "object",
            description: "Optional oldNodeId → newNodeId map for in-flight remap.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["summary", "diagnosis", "changes", "expectedImpact", "canaryPercent"],
      },
      graph: {
        type: "object",
        description: "Complete proposed JourneyGraph revision ({ nodes, edges }).",
        properties: {
          nodes: { type: "array" },
          edges: { type: "array" },
        },
        required: ["nodes", "edges"],
      },
    },
    required: ["analysis", "graph"],
  };
}

const SEVERITIES = new Set(["info", "warning", "critical"]);
const ACTIONS = new Set(["modify", "add", "remove", "rewire"]);
const DIRECTIONS = new Set(["increase", "decrease", "neutral"]);

function clampString(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function cleanList<T>(
  raw: unknown,
  max: number,
  map: (item: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, max)
    .map((x) => (x && typeof x === "object" ? map({ ...(x as Record<string, unknown>) }) : null))
    .filter((x): x is T => x !== null);
}

function preClamp(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const o = { ...(input as Record<string, unknown>) };
  const analysisRaw = o.analysis;
  if (analysisRaw === null || typeof analysisRaw !== "object" || Array.isArray(analysisRaw)) {
    return o;
  }
  const a = { ...(analysisRaw as Record<string, unknown>) };
  a.summary = clampString(a.summary, MAX_SUMMARY);
  a.diagnosis = cleanList(a.diagnosis, MAX_DIAGNOSIS, (item) => {
    const nodeId = clampString(item.nodeId, 80);
    const issue = clampString(item.issue, MAX_SUMMARY);
    const severity = typeof item.severity === "string" ? item.severity : "";
    if (!nodeId || !issue || !SEVERITIES.has(severity)) return null;
    return {
      nodeId,
      nodeType: clampString(item.nodeType, 40) || undefined,
      issue,
      severity,
    };
  });
  a.changes = cleanList(a.changes, MAX_DIAGNOSIS, (item) => {
    const nodeId = clampString(item.nodeId, 80);
    const description = clampString(item.description, MAX_SUMMARY);
    const action = typeof item.action === "string" ? item.action : "";
    if (!nodeId || !description || !ACTIONS.has(action)) return null;
    return { nodeId, action, description };
  });
  a.expectedImpact = cleanList(a.expectedImpact, MAX_IMPACT, (item) => {
    const metric = clampString(item.metric, 80);
    const note = clampString(item.note, MAX_TITLE);
    const direction = typeof item.direction === "string" ? item.direction : "";
    if (!metric || !note || !DIRECTIONS.has(direction)) return null;
    return { metric, direction, note };
  });
  if (typeof a.canaryPercent === "number") {
    a.canaryPercent = Math.round(Math.min(MAX_CANARY, Math.max(MIN_CANARY, a.canaryPercent)));
  }
  if (a.nodeMapping && typeof a.nodeMapping === "object" && !Array.isArray(a.nodeMapping)) {
    const entries = Object.entries(a.nodeMapping as Record<string, unknown>)
      .slice(0, MAX_MAPPING)
      .filter(([k, v]) => k.length > 0 && typeof v === "string" && String(v).length > 0)
      .map(([k, v]) => [k.slice(0, 80), clampString(v, 80)] as const);
    a.nodeMapping = Object.fromEntries(entries);
  } else {
    delete a.nodeMapping;
  }
  o.analysis = a;
  return o;
}

/**
 * Mandatory boundary for AI optimization proposals. Analysis fields are
 * rebuilt/clamped; the graph is forced through guardAiGraph (zod + whitelist
 * + validateGraph). Failures throw AiGraphError so server routes map them
 * the same way as copilot/simulate rejections.
 */
export function guardJourneyOptimization(input: unknown): JourneyOptimizationProposal {
  const clamped = preClamp(input);
  if (clamped === null || typeof clamped !== "object" || Array.isArray(clamped)) {
    throw new AiGraphError("expected an optimization object with analysis and graph", [
      "(root): expected analysis + graph",
    ]);
  }
  const obj = clamped as { analysis?: unknown; graph?: unknown };
  const parsed = journeyOptimizationAnalysisZod.safeParse(obj.analysis);
  if (!parsed.success) {
    throw new AiGraphError(
      "AI optimization analysis failed validation",
      parsed.error.issues
        .slice(0, 10)
        .map((i) => `analysis.${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }

  const graph = guardAiGraph(obj.graph);

  // nodeMapping targets must exist in the proposed graph.
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const analysis = parsed.data;
  if (analysis.nodeMapping) {
    const bad = Object.entries(analysis.nodeMapping).find(([, to]) => !nodeIds.has(to));
    if (bad) {
      throw new AiGraphError("AI optimization nodeMapping is invalid", [
        `analysis.nodeMapping: target "${bad[1]}" does not exist in the proposed graph`,
      ]);
    }
    if (Object.keys(analysis.nodeMapping).length === 0) {
      delete analysis.nodeMapping;
    }
  }

  return { analysis, graph };
}

export interface JourneyOptimizationInput {
  journeyName: string;
  baselineVersion?: number | null;
  /** Compact node reference (same shape as simulation). */
  graph: { id: string; type: string; label: string; next: string[] }[];
  /** Aggregated funnel + delivery counters from collectJourneyOptimizationSignals. */
  signals: {
    runCounts: Record<string, number>;
    nodes: {
      nodeId: string;
      nodeType: string | null;
      status: string | null;
      count: number;
    }[];
    email: {
      sent: number;
      delivered: number;
      bounced: number;
      complained: number;
      failed: number;
    };
    inFlightByVersion?: { version: number; runs: number }[];
  };
  /** Template ids the graph may reference. */
  templates?: { id: string; name: string }[];
  /** Event names known in the workspace. */
  events?: string[];
  /** Property key NAMES observed on contacts (no values). */
  propertyKeys?: string[];
  /** Optional operator constraint, e.g. "keep the same email templates". */
  request?: string;
  language?: string;
}

export function buildJourneyOptimizationSystemPrompt(): string {
  return `You are a journey optimization engine for Loopkit, a marketing automation platform.

You receive: (1) a compact journey graph reference; (2) live funnel metrics from wf_node_metric plus email delivery counters; (3) workspace vocabularies (templates, events, property keys).

Your job: diagnose where this journey loses people, propose ONE complete revised JourneyGraph that fixes the highest-impact problems, and recommend a canary traffic share.

Hard rules:
- Ground every diagnosis claim in the provided numbers; cite node ids like "node 'xyz'". Never invent contacts, values, or statistics.
- The proposed graph MUST be a complete valid journey: exactly one trigger, every non-exit node reachable, branch handles named correctly, email templateIds taken from the provided template list when one is given.
- Prefer surgical changes over rewrites. Keep node ids stable when a node is only modified, so in-flight remap stays cheap.
- canaryPercent must be between 1 and 50. Start small (5–20) when risk is high.
- nodeMapping maps OLD node ids that disappear to NEW node ids that replace them (for in-flight contacts). Omit when nothing was removed.
- Never invent node types outside the allowed journey vocabulary. Never emit action/sql payload strings.
- Write ALL human-readable text fields in the requested language (default 简体中文).`;
}

export function buildJourneyOptimizationUserPrompt(input: JourneyOptimizationInput): string {
  const language = input.language ?? "简体中文";
  const s = input.signals;
  const lines: string[] = [];
  lines.push(`Journey: "${input.journeyName}"`);
  if (input.baselineVersion != null)
    lines.push(`Baseline published version: ${input.baselineVersion}`);
  lines.push(
    `Run counts: ${
      Object.entries(s.runCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "(none)"
    }`,
  );
  lines.push(
    `Email funnel: sent=${s.email.sent}, delivered=${s.email.delivered}, bounced=${s.email.bounced}, complained=${s.email.complained}, failed=${s.email.failed}`,
  );
  if (s.inFlightByVersion?.length) {
    lines.push(
      `In-flight runs by version: ${s.inFlightByVersion
        .map((v) => `v${v.version}=${v.runs}`)
        .join(", ")}`,
    );
  }

  lines.push("", "GRAPH:");
  for (const n of input.graph) {
    lines.push(
      `- ${n.id} (${n.type})${n.label ? ` "${n.label}"` : ""} → ${n.next.length ? n.next.join(", ") : "(no outgoing edges)"}`,
    );
  }

  lines.push("", "NODE FUNNEL (wf_node_metric aggregates):");
  if (s.nodes.length === 0) lines.push("(no metric rows yet)");
  for (const n of s.nodes) {
    lines.push(
      `- ${n.nodeId}${n.nodeType ? ` (${n.nodeType})` : ""}${n.status ? ` [${n.status}]` : ""}: ${n.count}`,
    );
  }

  if (input.templates?.length) {
    lines.push(
      "",
      "Available email templates (use these ids exactly):",
      ...input.templates.map((t) => `- ${t.id}: ${t.name}`),
    );
  }
  if (input.events?.length) {
    lines.push("", `Known event names: ${input.events.join(", ")}`);
  }
  if (input.propertyKeys?.length) {
    lines.push("", `Observed contact property keys: ${input.propertyKeys.join(", ")}`);
  }
  if (input.request?.trim()) {
    lines.push("", `Operator constraint: ${input.request.trim()}`);
  }

  lines.push(
    "",
    `Call ${JOURNEY_OPTIMIZATION_TOOL_NAME} with analysis + a complete proposed graph. Write ALL text fields in ${language}.`,
  );
  return lines.join("\n");
}

export function buildJourneyOptimizationRepairPrompt(): string {
  return "Your tool call did not pass validation. Fix every listed issue and call emit_journey_optimization again with the complete corrected proposal (analysis + full graph).";
}
