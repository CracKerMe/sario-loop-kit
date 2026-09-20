/**
 * AI interpretation of a cohort simulation — the "60% take branch A and
 * drop off at step 3" layer.
 *
 * The model receives the graph reference and the aggregated statistics
 * (never contact identities or property values) and must call the insight
 * tool; its output is zod-guarded and rebuilt field-by-field, so the UI
 * only ever renders bounded, structured text. Severity is an enum, arrays
 * are capped — an oversized or malformed answer goes through the standard
 * repair round.
 */
import { z } from "zod";

export const SIMULATION_INSIGHT_TOOL_NAME = "emit_simulation_insight";

const MAX_OBSERVATIONS = 8;
const MAX_SUGGESTIONS = 6;
const MAX_TEXT = 1200;
const MAX_TITLE = 160;

export const simulationInsightZod = z.object({
  summary: z.string().min(1).max(MAX_TEXT),
  observations: z
    .array(
      z.object({
        title: z.string().min(1).max(MAX_TITLE),
        detail: z.string().min(1).max(MAX_TEXT),
        severity: z.enum(["info", "warning", "critical"]),
      }),
    )
    .max(MAX_OBSERVATIONS),
  suggestions: z
    .array(
      z.object({
        title: z.string().min(1).max(MAX_TITLE),
        detail: z.string().min(1).max(MAX_TEXT),
      }),
    )
    .max(MAX_SUGGESTIONS),
});

export type SimulationInsight = z.infer<typeof simulationInsightZod>;

export function simulationInsightToolParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      summary: { type: "string", description: "2-4 sentence overall read of the simulation." },
      observations: {
        type: "array",
        maxItems: MAX_OBSERVATIONS,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            severity: { type: "string", enum: ["info", "warning", "critical"] },
          },
          required: ["title", "detail", "severity"],
        },
      },
      suggestions: {
        type: "array",
        maxItems: MAX_SUGGESTIONS,
        items: {
          type: "object",
          properties: { title: { type: "string" }, detail: { type: "string" } },
          required: ["title", "detail"],
        },
      },
    },
    required: ["summary", "observations", "suggestions"],
  };
}

/**
 * The mandatory boundary for model-produced insights. Rebuilds the payload
 * explicitly: unknown keys are dropped, strings are trimmed and capped,
 * severities must be enum members, arrays are clamped. Everything the UI
 * renders passes through here first.
 */
/** Clamp-before-validate: oversized strings are truncated, not rejected —
 * only structural violations (missing fields, bad enum) go to the repair
 * round. */
const SEVERITIES = new Set(["info", "warning", "critical"]);

function cleanEntry<T extends Record<string, unknown>>(
  x: unknown,
  keys: [string, number][],
): T | null {
  if (typeof x !== "object" || x === null) return null;
  const e = { ...(x as Record<string, unknown>) };
  for (const [key, max] of keys) {
    if (typeof e[key] === "string") e[key] = (e[key] as string).trim().slice(0, max);
  }
  return e as T;
}

function preClamp(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const o = { ...(input as Record<string, unknown>) };
  if (typeof o.summary === "string") o.summary = o.summary.trim().slice(0, MAX_TEXT);
  if (Array.isArray(o.observations)) {
    o.observations = o.observations
      .slice(0, MAX_OBSERVATIONS)
      .map((x) =>
        cleanEntry<{ title?: unknown; detail?: unknown; severity?: unknown }>(x, [
          ["title", MAX_TITLE],
          ["detail", MAX_TEXT],
        ]),
      )
      .filter(
        (x): x is { title: string; detail: string; severity: string } =>
          typeof x?.title === "string" &&
          x.title.length > 0 &&
          typeof x?.detail === "string" &&
          x.detail.length > 0 &&
          typeof x?.severity === "string" &&
          SEVERITIES.has(x.severity),
      );
  }
  if (Array.isArray(o.suggestions)) {
    o.suggestions = o.suggestions
      .slice(0, MAX_SUGGESTIONS)
      .map((x) =>
        cleanEntry<{ title?: unknown; detail?: unknown }>(x, [
          ["title", MAX_TITLE],
          ["detail", MAX_TEXT],
        ]),
      )
      .filter(
        (x): x is { title: string; detail: string } =>
          typeof x?.title === "string" &&
          x.title.length > 0 &&
          typeof x?.detail === "string" &&
          x.detail.length > 0,
      );
  }
  return o;
}

export function guardSimulationInsight(input: unknown): SimulationInsight {
  const parsed = simulationInsightZod.safeParse(preClamp(input));
  if (!parsed.success) {
    throw new AiGuardIssueError(
      parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  }
  const data = parsed.data;
  return {
    summary: data.summary.trim(),
    observations: data.observations.slice(0, MAX_OBSERVATIONS).map((o) => ({
      title: o.title.trim().slice(0, MAX_TITLE),
      detail: o.detail.trim().slice(0, MAX_TEXT),
      severity: o.severity,
    })),
    suggestions: data.suggestions.slice(0, MAX_SUGGESTIONS).map((s) => ({
      title: s.title.trim().slice(0, MAX_TITLE),
      detail: s.detail.trim().slice(0, MAX_TEXT),
    })),
  };
}

/** Distinct error class so repair rounds can be recognized in tests. */
export class AiGuardIssueError extends Error {
  readonly issues: string[];
  constructor(issueText: string) {
    super(`model insight failed validation: ${issueText}`);
    this.name = "AiGuardIssueError";
    this.issues = [issueText];
  }
}

export interface SimulationInsightInput {
  journeyName?: string;
  /** Compact node reference from describeGraphForSimulation(). */
  graph: { id: string; type: string; label: string; next: string[] }[];
  /** Aggregated cohort statistics from aggregateDryRuns(). */
  simulation: {
    samples: number;
    exitedCount: number;
    truncatedCount: number;
    endedEarlyCount: number;
    branches: { nodeId: string; type: string; outcomes: { value: string; count: number }[] }[];
    nodeReach: { nodeId: string; count: number }[];
    dropOffs: { nodeId: string; count: number }[];
    exitReasons: { reason: string; count: number }[];
    warnings: { message: string; count: number }[];
    errors: { nodeId: string; error: string; count: number }[];
  };
  /** Property key NAMES observed on sampled contacts (no values). */
  propertyKeys?: string[];
  /** Language for the produced text. Default 简体中文. */
  language?: string;
}

export function buildSimulationSystemPrompt(): string {
  return `You are a journey analytics interpreter for a marketing automation platform.

You receive: (1) a journey graph reference — node ids, types, and outgoing edges; (2) aggregate statistics from a cohort dry-run simulation of real sampled contacts; (3) the property key names those contacts carry.

Your job: explain what the journey DOES to this cohort and where it LOSES people, then give concrete, actionable improvement suggestions.

Rules:
- Ground every claim in the provided numbers; cite node ids like "node 'xyz'". Never invent contacts, values, or statistics that are not in the input.
- "endedEarly" walks die at a dead end before any exit — treat drop-off nodes as the primary churn signal, and distinguish them from deliberate filter exits.
- Branch distributions tell you WHO goes where; relate them to the node expressions when explaining.
- Warnings from the walker (assumed events, skipped sub-journeys, unevaluated expressions) limit simulation fidelity — call them out when they weaken a conclusion.
- Suggestions must reference concrete node ids and be specific changes (e.g. add a failure path on node X, widen the time window on node Y), not generic marketing advice.
- Never suggest anything requiring node types outside the provided graph's vocabulary.`;
}

export function buildSimulationUserPrompt(input: SimulationInsightInput): string {
  const language = input.language ?? "简体中文";
  const s = input.simulation;
  const lines: string[] = [];
  if (input.journeyName) lines.push(`Journey: "${input.journeyName}"`);
  lines.push(`Samples: ${s.samples}`);
  lines.push(
    `Outcomes: ${s.exitedCount} exited, ${s.endedEarlyCount} ended early (dead end), ${s.truncatedCount} truncated.`,
  );
  if (s.exitReasons.length)
    lines.push(`Exit reasons: ${s.exitReasons.map((e) => `"${e.reason}"×${e.count}`).join(", ")}`);

  lines.push("", "GRAPH:");
  for (const n of input.graph) {
    lines.push(
      `- ${n.id} (${n.type})${n.label ? ` "${n.label}"` : ""} → ${n.next.length ? n.next.join(", ") : "(no outgoing edges)"}`,
    );
  }

  lines.push("", "REACH (contacts whose walk passed the node):");
  for (const r of s.nodeReach) {
    lines.push(`- ${r.nodeId}: ${r.count}/${s.samples}`);
  }

  if (s.branches.length) {
    lines.push("", "BRANCH OUTCOMES:");
    for (const b of s.branches) {
      const total = b.outcomes.reduce((acc, o) => acc + o.count, 0);
      const parts = b.outcomes.map(
        (o) => `${o.value} ${o.count} (${Math.round((o.count / Math.max(total, 1)) * 100)}%)`,
      );
      lines.push(`- ${b.nodeId} (${b.type}): ${parts.join(", ")}`);
    }
  }

  if (s.dropOffs.length) {
    lines.push("", "DROP-OFFS (walk ended at node without exit):");
    for (const d of s.dropOffs) {
      lines.push(`- ${d.nodeId}: ${d.count} contacts`);
    }
  }

  if (s.warnings.length) {
    lines.push("", "SIMULATION WARNINGS:");
    for (const w of s.warnings) lines.push(`- (${w.count}×) ${w.message}`);
  }
  if (s.errors.length) {
    lines.push("", "SIMULATION ERRORS:");
    for (const e of s.errors) lines.push(`- (${e.count}×) node ${e.nodeId}: ${e.error}`);
  }

  if (input.propertyKeys?.length) {
    lines.push("", `Observed contact property keys: ${input.propertyKeys.join(", ")}`);
  }

  lines.push(
    "",
    `Call emit_simulation_insight with your interpretation. Write ALL text fields in ${language}.`,
  );
  return lines.join("\n");
}
