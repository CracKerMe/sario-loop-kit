import type { TaskNode, WorkflowDefinition } from "ts-workflow-engine-lite";

import { CompileError } from "./errors";
import type { CompileNodeContext, EdgeRef } from "./nodeDefs";
import { compileNodeWithDef } from "./nodeDefs";
import type { JourneyCompileActions, JourneyGraph } from "./types";

export interface CompileResult {
  definition: WorkflowDefinition;
  warnings: string[];
}

export interface CompileOptions {
  workflowId: string;
  name: string;
  version?: string;
  /**
   * Runtime side-effect handlers for updateContact/score/goal. Injected by
   * the server (packages/core) at publish and at boot re-register. Omitted
   * in pure graph tooling — those nodes then no-op with a warning result.
   */
  actions?: JourneyCompileActions;
}

/**
 * Compiles a JourneyGraph (the visual, source-of-truth representation
 * React Flow edits) into an engine WorkflowDefinition. The graph's node
 * ids are used verbatim as engine TaskNode ids — round-tripping (see
 * decompile.ts) depends on that identity holding.
 *
 * Per-node compilation lives in the NODE_DEFS registry (nodeDefs.ts).
 * This shell only derives startNode from the trigger and assembles the
 * WorkflowDefinition.
 *
 * Compilation table (journey node type -> engine node type):
 *   trigger       -> not a node; becomes startNode via the first edge out of it
 *   delay         -> wait (config.externalTimer.enabled: true, durable: true)
 *   email         -> notification (channel: "loopkit-email")
 *   sendCampaign  -> notification (channel: "loopkit-email"), using a
 *                    snapshot of the referenced campaign's composition
 *                    taken at publish time (see JourneySendCampaignData)
 *   branch        -> condition (config.trueBranch/falseBranch)
 *   split         -> router (config.routes)
 *   filter        -> condition, false branch may be empty (journey ends)
 *   waitEvent     -> event (node.onEvent), requireInstanceIdMatch is forced
 *                    true by the engine regardless of what we configure
 *   webhook       -> http
 *   exit          -> terminal action, no `next`
 *   abSplit       -> action (deterministic hash bucket) + conditionalNext
 *   timeWindow    -> action (evaluate day/hour window) + conditionalNext
 *   updateContact -> action (injected runtime handler)
 *   score         -> action (injected runtime handler)
 *   goal          -> action (injected runtime handler)
 *   notify        -> http (team webhook / Slack incoming URL)
 *   parallel      -> action (marker) + fan-out `next` (one entry per branch)
 *   join          -> action (arrival gate on state output presence; see
 *                    compileJoinGateAction) + conditionalNext
 *   subJourney    -> subworkflow (fire-and-forget; child context mapped from
 *                    the parent run — see the subJourney descriptor)
 */
export function compile(graph: JourneyGraph, options: CompileOptions): CompileResult {
  const warnings: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const outgoing = new Map<string, EdgeRef[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push({ target: edge.target, sourceHandle: edge.sourceHandle });
    outgoing.set(edge.source, list);
  }

  const triggerNode = graph.nodes.find((n) => n.type === "trigger");
  if (!triggerNode) {
    throw new CompileError("journey graph has no trigger node");
  }
  const triggerOut = outgoing.get(triggerNode.id) ?? [];
  if (triggerOut.length === 0) {
    throw new CompileError("trigger node has no outgoing edge");
  }
  if (triggerOut.length > 1) {
    warnings.push(`trigger node ${triggerNode.id} has multiple outgoing edges; using the first`);
  }
  let startNode = triggerOut[0]!.target;
  if (!byId.has(startNode)) {
    throw new CompileError(`trigger edge targets unknown node ${startNode}`);
  }

  const nodes: Record<string, TaskNode> = {};
  /** journey node id → engine node id that should receive its incoming edges. */
  const incomingRedirect = new Map<string, string>();
  /** Companion nodes (e.g. STO prep action), attached after redirect. */
  const deferredExtras: TaskNode[] = [];

  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    const list = incoming.get(edge.target) ?? [];
    if (!list.includes(edge.source)) list.push(edge.source);
    incoming.set(edge.target, list);
  }

  for (const node of graph.nodes) {
    if (node.type === "trigger") continue; // not an engine node
    const edges = outgoing.get(node.id) ?? [];
    for (const edge of edges) {
      if (!byId.has(edge.target)) {
        warnings.push(`node ${node.id} has an edge to unknown node ${edge.target}`);
      }
    }
    let redirectIncomingTo: string | undefined;
    const extras: TaskNode[] = [];
    const ctx: CompileNodeContext = {
      edges,
      incomingSources: incoming.get(node.id) ?? [],
      warnings,
      actions: options.actions,
      emitExtra: (extra) => {
        extras.push(extra);
      },
      setRedirectIncomingTo: (id) => {
        redirectIncomingTo = id;
      },
    };
    const compiled = compileNodeWithDef(node, ctx);
    nodes[node.id] = compiled;
    // Extras are attached AFTER the incoming-redirect pass so their
    // internal edges (sto action → wait) are not rewritten to point at
    // themselves. See the redirect block below.
    deferredExtras.push(...extras);
    if (redirectIncomingTo) incomingRedirect.set(node.id, redirectIncomingTo);
  }

  // One journey node can expand to a preparatory action + the real node
  // (delay `bestTime`). Edges that targeted the journey node must land on
  // the action so the wait's deadline is seeded before the wait runs.
  if (incomingRedirect.size > 0) {
    for (const node of Object.values(nodes)) {
      if (Array.isArray(node.next)) {
        node.next = node.next.map((id) => incomingRedirect.get(id) ?? id);
      }
      const cfg = node.config as
        | { trueBranch?: string; falseBranch?: string; routes?: Array<{ target?: string }> }
        | undefined;
      if (cfg) {
        if (typeof cfg.trueBranch === "string")
          cfg.trueBranch = incomingRedirect.get(cfg.trueBranch) ?? cfg.trueBranch;
        if (typeof cfg.falseBranch === "string")
          cfg.falseBranch = incomingRedirect.get(cfg.falseBranch) ?? cfg.falseBranch;
        if (Array.isArray(cfg.routes)) {
          for (const route of cfg.routes) {
            if (typeof route.target === "string")
              route.target = incomingRedirect.get(route.target) ?? route.target;
          }
        }
      }
      const cond = (node as { conditionalNext?: Array<{ target: string }> }).conditionalNext;
      if (Array.isArray(cond)) {
        for (const branch of cond) {
          branch.target = incomingRedirect.get(branch.target) ?? branch.target;
        }
      }
      const failureNext = node.failureNext;
      if (Array.isArray(failureNext)) {
        node.failureNext = failureNext.map((id) => incomingRedirect.get(id) ?? id);
      }
    }
    // startNode must also land on the preparatory action when the trigger
    // points at a bestTime delay.
    const redirectedStart = incomingRedirect.get(startNode);
    if (redirectedStart) startNode = redirectedStart;
  }

  for (const extra of deferredExtras) nodes[extra.id] = extra;

  const definition: WorkflowDefinition = {
    id: options.workflowId,
    name: options.name,
    version: options.version,
    startNode,
    nodes,
  };

  return { definition, warnings };
}

export { CompileError };
export { compileJoinGateAction } from "./nodes/branching";
export { delayDataToMs, hashString, isInTimeWindow } from "./runtimeUtils";
export type { EdgeRef } from "./nodeDefs";
