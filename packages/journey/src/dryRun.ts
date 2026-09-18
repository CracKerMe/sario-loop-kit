/**
 * Journey dry-run — a pure, side-effect-free walk of a JourneyGraph.
 *
 * This is deliberately NOT the engine's own DryRunExecutor: that one only
 * understands the engine's generic node vocabulary and, worse, EXECUTES
 * function-valued action closures — the compiled updateContact/score/goal
 * nodes would hit the real database. Publish-previewing an uncommitted
 * draft through the engine registry is impossible anyway (drafts are not
 * registered, and registering a throwaway definition leaks it).
 *
 * Instead this walker mirrors compile()'s compilation table one level
 * higher — at the journey node vocabulary itself — and reuses the ENGINE'S
 * OWN expression evaluator (evaluateCondition / interpolateExpressions
 * from ts-workflow-engine-lite) so a branch that takes the true path here
 * takes the true path at runtime. Anything with a side effect (email send,
 * webhook POST, contact mutation, timer) is DESCRIBED, never performed.
 */
import { evaluateCondition } from "ts-workflow-engine-lite";

import { delayDataToMs, hashString, isInTimeWindow } from "./compile";
import type {
  JourneyEdge,
  JourneyGraph,
  JourneyNode,
  JourneyRuntimeContext,
  JourneyUpdateContactData,
} from "./types";

export interface DryRunStep {
  nodeId: string;
  type: string;
  /** Human-readable summary of what this node WOULD do (no side effects). */
  description: string;
  /** Type-specific structured detail for richer UI rendering. */
  detail: Record<string, unknown>;
  /** Node ids the walk continues to (empty = this path ends here). */
  next: string[];
}

export interface DryRunEmailNode {
  nodeId: string;
  templateId: string;
  /** Node-level subject override, if any (template default resolved server-side). */
  subject?: string;
  preheader?: string;
  fromName?: string;
  replyTo?: string;
}

export interface DryRunJourneyResult {
  startNode: string;
  executionPath: string[];
  steps: DryRunStep[];
  /** Email nodes in walk order — the server renders previews for these. */
  emails: DryRunEmailNode[];
  warnings: string[];
  errors: { nodeId: string; error: string }[];
  /** Walk stopped because maxSteps was hit (very long or cyclic graph). */
  truncated: boolean;
  /** Walk ended on an `exit` node. */
  exited: boolean;
  exitReason?: string;
}

export interface DryRunJourneyOptions {
  /** Reference time for timeWindow evaluation; defaults to now. */
  now?: Date;
  /** Safety cap on walked nodes (default 200) — guards against runaway loops. */
  maxSteps?: number;
  /** Stop the walk right after this node records its step. */
  stopAfterNode?: string;
}

const DEFAULT_MAX_STEPS = 200;

/**
 * Walks a journey graph for ONE contact's context. The context shape MUST
 * match what the runtime injects at engine.start() (see core's
 * buildStartContext): { workspaceId, journeyId, contactId, contact: {id,
 * email, ...properties}, journeyRunId }. Branch expressions evaluate
 * against exactly this object, so "would this contact take the true
 * branch?" answers the same question the running engine will.
 */
export function dryRunJourney(
  graph: JourneyGraph,
  context: JourneyRuntimeContext,
  options: DryRunJourneyOptions = {},
): DryRunJourneyResult {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const warnings: string[] = [];
  const errors: { nodeId: string; error: string }[] = [];
  const steps: DryRunStep[] = [];
  const emails: DryRunEmailNode[] = [];
  const executionPath: string[] = [];

  const byId = new Map<string, JourneyNode>(graph.nodes.map((n) => [n.id, n]));
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (!trigger) {
    return {
      startNode: "",
      executionPath,
      steps,
      emails,
      warnings,
      errors: [{ nodeId: "", error: "journey graph has no trigger node" }],
      truncated: false,
      exited: false,
    };
  }

  // Mutated as the walk proceeds — the closures in compile()'s abSplit /
  // timeWindow actions write these into instance.context the same way, and
  // resolveConditionalNext-style routing reads them back on the same step.
  const ctx = context as Record<string, unknown>;
  const now = options.now ?? new Date();

  const result: DryRunJourneyResult = {
    startNode: "",
    executionPath,
    steps,
    emails,
    warnings,
    errors,
    truncated: false,
    exited: false,
  };

  // startNode derivation mirrors compile(): the trigger's first outgoing edge.
  const startTarget = outgoing(graph.edges, trigger.id)[0];
  if (!startTarget) {
    errors.push({ nodeId: trigger.id, error: "trigger node has no outgoing edge" });
    return result;
  }
  result.startNode = startTarget.target;

  let current: string | undefined = result.startNode;
  const visited = new Set<string>();

  while (current) {
    const nodeId = current;
    current = undefined;

    if (visited.has(nodeId)) {
      errors.push({ nodeId, error: "circular dependency detected" });
      break;
    }
    visited.add(nodeId);

    const node = byId.get(nodeId);
    if (!node) {
      errors.push({ nodeId, error: `edge targets unknown node ${nodeId}` });
      break;
    }

    executionPath.push(nodeId);
    const step = walkNode(node, ctx, graph.edges, now, warnings);
    steps.push(step);
    if (step.type === "email") {
      emails.push(emailOf(node, step));
    }
    if (step.type === "exit") {
      result.exited = true;
      result.exitReason = (step.detail.reason as string | null) ?? undefined;
    }

    if (options.stopAfterNode === nodeId) {
      warnings.push(`stopped at node '${nodeId}' as requested`);
      break;
    }
    if (steps.length >= maxSteps) {
      result.truncated = true;
      warnings.push(`walk truncated after ${maxSteps} steps`);
      break;
    }
    if (step.next.length === 0) break; // path ended (filter, exit, dead end)
    if (step.next.length > 1) {
      // compile() never emits multi-target next; if the graph does, follow
      // the first and say so rather than silently exploring all branches.
      warnings.push(`node '${nodeId}' has ${step.next.length} outgoing paths; following the first`);
    }
    current = step.next[0];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Per-node simulation
// ---------------------------------------------------------------------------

function walkNode(
  node: JourneyNode,
  ctx: Record<string, unknown>,
  edges: JourneyEdge[],
  now: Date,
  warnings: string[],
): DryRunStep {
  const out = outgoing(edges, node.id);
  const nextTargets = out.map((e) => e.target);

  switch (node.type) {
    case "trigger":
      // Unreachable as a step (trigger is not a walk target) but the type
      // system still allows it in byId; describe and stop.
      return {
        nodeId: node.id,
        type: "trigger",
        description: "journey trigger",
        detail: {},
        next: [],
      };

    case "delay": {
      const d = node.data;
      const description =
        d.mode === "until"
          ? `wait until ${d.iso}`
          : d.mode === "weekly"
            ? `wait until weekly gate (day ${d.dayOfWeek}, ${String(d.hour).padStart(2, "0")}:${String(d.minute ?? 0).padStart(2, "0")})`
            : `wait ${describeDuration(delayDataToMs(d))}`;
      return {
        nodeId: node.id,
        type: "delay",
        description,
        detail: { mode: d.mode, ms: d.mode === "duration" ? delayDataToMs(d) : null },
        next: nextTargets.slice(0, 1),
      };
    }

    case "email":
      return {
        nodeId: node.id,
        type: "email",
        description: "send email",
        detail: { templateId: node.data.templateId },
        next: nextTargets.slice(0, 1),
      };

    case "sendCampaign":
      warnings.push(
        `node '${node.id}': campaign email not rendered during dry-run (uses the campaign's own template preview instead)`,
      );
      return {
        nodeId: node.id,
        type: "sendCampaign",
        description: `send campaign ${node.data.campaignId}`,
        detail: { campaignId: node.data.campaignId },
        next: nextTargets.slice(0, 1),
      };

    case "branch":
    case "filter": {
      const expression = node.data.expression;
      let passed = false;
      try {
        passed = evaluateCondition(expression, ctx);
      } catch (error) {
        warnings.push(
          `node '${node.id}' expression failed to evaluate: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const taken = out.find((e) => e.sourceHandle === (passed ? "true" : "false"));
      return {
        nodeId: node.id,
        type: node.type,
        description: passed ? `condition passed: ${expression}` : `condition failed: ${expression}`,
        detail: { expression, result: passed },
        next: taken ? [taken.target] : [],
      };
    }

    case "split": {
      let matched: string | undefined;
      for (const route of node.data.routes) {
        try {
          if (evaluateCondition(route.expression, ctx)) {
            matched = route.name;
            break;
          }
        } catch (error) {
          warnings.push(
            `node '${node.id}' route "${route.name}" failed to evaluate: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const edge = matched
        ? out.find((e) => e.sourceHandle === matched)
        : out.find((e) => e.sourceHandle === "default");
      return {
        nodeId: node.id,
        type: "split",
        description: matched ? `matched route "${matched}"` : "no route matched, taking default",
        detail: { matchedRoute: matched ?? null, routes: node.data.routes.map((r) => r.name) },
        next: edge ? [edge.target] : [],
      };
    }

    case "waitEvent":
      warnings.push(
        `node '${node.id}': dry-run assumes event "${node.data.eventName}" arrives and follows the success path`,
      );
      return {
        nodeId: node.id,
        type: "waitEvent",
        description: `wait for event "${node.data.eventName}"${node.data.timeoutMs ? ` (timeout ${describeDuration(node.data.timeoutMs)})` : ""}`,
        detail: { eventName: node.data.eventName, timeoutMs: node.data.timeoutMs ?? null },
        next: nextTargets.slice(0, 1),
      };

    case "webhook":
      warnings.push(`node '${node.id}': no HTTP request made during dry-run`);
      return {
        nodeId: node.id,
        type: "webhook",
        description: `${node.data.method} ${node.data.url}`,
        detail: { url: node.data.url, method: node.data.method },
        next: nextTargets.slice(0, 1),
      };

    case "exit":
      return {
        nodeId: node.id,
        type: "exit",
        description: node.data.reason ? `journey exits: ${node.data.reason}` : "journey exits",
        detail: { reason: node.data.reason ?? null },
        next: [],
      };

    case "abSplit": {
      const variants = (node.data.variants ?? []).filter((v) => v.name);
      const total = variants.reduce((s, v) => s + Math.max(0, Number(v.weight) || 0), 0) || 1;
      // Identical arithmetic to compile()'s action closure — same seed
      // (contact identity), same hash, so the dry-run variant IS the
      // variant the contact will land in.
      const seed = String(ctx.contactId ?? (ctx.contact as { id?: string } | undefined)?.id ?? "");
      const bucket = hashString(seed) % total;
      let acc = 0;
      let chosen = variants[variants.length - 1]?.name ?? "A";
      for (const v of variants) {
        acc += Math.max(0, Number(v.weight) || 0);
        if (bucket < acc) {
          chosen = v.name;
          break;
        }
      }
      ctx.__abVariant = chosen;
      const edge = out.find((e) => e.sourceHandle === chosen);
      return {
        nodeId: node.id,
        type: "abSplit",
        description: `bucket ${bucket}/${total} → variant "${chosen}"`,
        detail: {
          variant: chosen,
          bucket,
          total,
          weights: variants.map((v) => ({ name: v.name, weight: v.weight })),
        },
        next: edge ? [edge.target] : [],
      };
    }

    case "timeWindow": {
      const inWindow = isInTimeWindow(node.data, now);
      ctx.__timeWindowOk = inWindow;
      const edge = out.find((e) => e.sourceHandle === (inWindow ? "true" : "false"));
      return {
        nodeId: node.id,
        type: "timeWindow",
        description: inWindow
          ? `in window (${node.data.days.join(",")} ${node.data.startHour}:00–${node.data.endHour}:00)`
          : `outside window (${node.data.days.join(",")} ${node.data.startHour}:00–${node.data.endHour}:00)`,
        detail: {
          inWindow,
          days: node.data.days,
          startHour: node.data.startHour,
          endHour: node.data.endHour,
        },
        next: edge ? [edge.target] : [],
      };
    }

    case "updateContact": {
      const resolved = resolveUpdateContact(node.data, ctx);
      return {
        nodeId: node.id,
        type: "updateContact",
        description: "update contact properties/tags",
        detail: resolved,
        next: nextTargets.slice(0, 1),
      };
    }

    case "score":
      return {
        nodeId: node.id,
        type: "score",
        description: `${node.data.op === "set" ? "set" : "add"} ${node.data.value} to score property "${node.data.property ?? "score"}"`,
        detail: {
          property: node.data.property ?? "score",
          value: node.data.value,
          op: node.data.op ?? "add",
        },
        next: nextTargets.slice(0, 1),
      };

    case "goal":
      return {
        nodeId: node.id,
        type: "goal",
        description: `record goal "${node.data.name}"${node.data.value != null ? ` (value ${node.data.value})` : ""}`,
        detail: { name: node.data.name, value: node.data.value ?? null },
        next: nextTargets.slice(0, 1),
      };

    case "notify":
      warnings.push(`node '${node.id}': no notification request made during dry-run`);
      return {
        nodeId: node.id,
        type: "notify",
        description: `notify ${node.data.url}`,
        detail: {
          url: node.data.url,
          subject: node.data.subject ?? null,
          message: node.data.message,
        },
        next: nextTargets.slice(0, 1),
      };

    case "parallel":
      return {
        nodeId: node.id,
        type: "parallel",
        description: `fan out into ${Math.max(nextTargets.length, 0)} concurrent branches`,
        detail: { branches: nextTargets },
        next: nextTargets,
      };

    case "join": {
      const mode = node.data.mode ?? "all";
      warnings.push(
        `node '${node.id}': dry-run follows a single path and cannot simulate sibling branches; assumes the join gate (mode ${mode}) opens`,
      );
      return {
        nodeId: node.id,
        type: "join",
        description: `wait for parallel branches to converge (mode ${mode})`,
        detail: { mode },
        next: nextTargets.slice(0, 1),
      };
    }

    case "subJourney":
      warnings.push(
        `node '${node.id}': sub-journey ${node.data.journeyId} runs as its own engine instance; its nodes are not walked here`,
      );
      return {
        nodeId: node.id,
        type: "subJourney",
        description: `start sub-journey ${node.data.journeyId} (runs concurrently)`,
        detail: { journeyId: node.data.journeyId },
        next: nextTargets.slice(0, 1),
      };

    default: {
      // Exhaustiveness guard: JourneyNode is closed, so this only fires if
      // a new node type is added without a walker case.
      const unknownNode = node as { id: string; type?: string };
      return {
        nodeId: unknownNode.id,
        type: String(unknownNode.type ?? "unknown"),
        description: "unknown node type",
        detail: {},
        next: [],
      };
    }
  }
}

function emailOf(node: JourneyNode, _step: DryRunStep): DryRunEmailNode {
  const d = (
    node as {
      data: {
        templateId: string;
        subject?: string;
        preheader?: string;
        fromName?: string;
        replyTo?: string;
      };
    }
  ).data;
  return {
    nodeId: node.id,
    templateId: d.templateId,
    subject: d.subject,
    preheader: d.preheader,
    fromName: d.fromName,
    replyTo: d.replyTo,
  };
}

/**
 * Mirrors the runtime's updateContact handler (core's resolveContextValue):
 * only an EXACT single `{{ path }}` placeholder resolves from run context —
 * composed strings are left as-is, matching production behavior.
 */
function resolveUpdateContact(
  data: JourneyUpdateContactData,
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data.set ?? {})) {
    set[key] = resolveContextValue(value, ctx);
  }
  return {
    set,
    addTags: data.addTags ?? [],
    removeTags: data.removeTags ?? [],
  };
}

function resolveContextValue(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  const m = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (!m) return value;
  let cur: unknown = ctx;
  for (const part of m[1]!.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function outgoing(edges: JourneyEdge[], source: string): JourneyEdge[] {
  return edges.filter((e) => e.source === source);
}

function describeDuration(ms: number): string {
  if (ms <= 0) return "no time";
  if (ms % 604_800_000 === 0) return `${ms / 604_800_000}w`;
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}
