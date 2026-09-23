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
 *
 * Per-node simulation lives on NODE_DEFS descriptors; this shell walks
 * the graph and collects steps / emails / warnings.
 */
import type { DryRunEmailNode, DryRunNodeContext, DryRunStep } from "./nodeDefs";
import { getNodeDef, dryRunNodeWithDef } from "./nodeDefs";
import type { JourneyEdge, JourneyGraph, JourneyNode, JourneyRuntimeContext } from "./types";

export type { DryRunEmailNode, DryRunStep } from "./nodeDefs";

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
    const def = getNodeDef(node.type);
    if (def.dryRunEmail) {
      emails.push(def.dryRunEmail(node as never));
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
// Per-node simulation (descriptor lookup)
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
  const dryCtx: DryRunNodeContext = {
    ctx,
    out,
    nextTargets,
    now,
    warnings,
  };
  return dryRunNodeWithDef(node, dryCtx);
}

function outgoing(edges: JourneyEdge[], source: string): JourneyEdge[] {
  return edges.filter((e) => e.source === source);
}
