import type { TaskNode, WorkflowDefinition } from "ts-workflow-engine-lite";

import type { JourneyGraph, JourneyNode } from "./types";

export interface CompileResult {
  definition: WorkflowDefinition;
  warnings: string[];
}

interface CompileOptions {
  workflowId: string;
  name: string;
  version?: string;
}

/**
 * Compiles a JourneyGraph (the visual, source-of-truth representation
 * React Flow edits) into an engine WorkflowDefinition. The graph's node
 * ids are used verbatim as engine TaskNode ids — round-tripping (see
 * decompile.ts) depends on that identity holding.
 *
 * Compilation table (journey node type -> engine node type):
 *   trigger    -> not a node; becomes startNode via the first edge out of it
 *   delay      -> wait (config.externalTimer.enabled: true, durable: true)
 *   email      -> notification (channel: "loopkit-email")
 *   branch     -> condition (config.trueBranch/falseBranch)
 *   split      -> router (config.routes)
 *   filter     -> condition, false branch implicitly routes to an
 *                 auto-inserted exit node (no user-visible "false" target
 *                 needed for a filter — falling the filter just ends the
 *                 journey for that contact)
 *   waitEvent  -> event (node.onEvent), requireInstanceIdMatch is forced
 *                 true by the engine regardless of what we configure
 *   webhook    -> http
 *   exit       -> terminal node, no `next`
 */
export function compile(graph: JourneyGraph, options: CompileOptions): CompileResult {
  const warnings: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const outgoing = new Map<string, { target: string; sourceHandle?: string }[]>();
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
  const startNode = triggerOut[0]!.target;
  if (!byId.has(startNode)) {
    throw new CompileError(`trigger edge targets unknown node ${startNode}`);
  }

  const nodes: Record<string, TaskNode> = {};

  for (const node of graph.nodes) {
    if (node.type === "trigger") continue; // not an engine node
    const edges = outgoing.get(node.id) ?? [];
    for (const edge of edges) {
      if (!byId.has(edge.target)) {
        warnings.push(`node ${node.id} has an edge to unknown node ${edge.target}`);
      }
    }
    const compiled = compileNode(node, edges, warnings);
    nodes[node.id] = compiled;
  }

  const definition: WorkflowDefinition = {
    id: options.workflowId,
    name: options.name,
    version: options.version,
    startNode,
    nodes,
  };

  return { definition, warnings };
}

export class CompileError extends Error {}

type NonTriggerJourneyNode = Exclude<JourneyNode, { type: "trigger" }>;

function compileNode(
  node: NonTriggerJourneyNode,
  edges: { target: string; sourceHandle?: string }[],
  warnings: string[],
): TaskNode {
  const base = { id: node.id };

  switch (node.type) {
    case "delay": {
      const target = requireSingleTarget(node, edges, warnings);
      const config =
        node.data.mode === "duration"
          ? { durationMs: node.data.ms, externalTimer: { enabled: true }, durable: true }
          : { until: node.data.iso, externalTimer: { enabled: true }, durable: true };
      return { ...base, type: "wait", config, next: target ? [target] : [] };
    }

    case "email": {
      const target = requireSingleTarget(node, edges, warnings);
      return {
        ...base,
        type: "notification",
        config: {
          channel: "loopkit-email",
          // Resolved by the engine's {{}} interpolation before the
          // notification channel ever sees it — see @loopkit/email's
          // channel.ts for why the body carries only a template marker,
          // never the HTML itself.
          target: "{{ contact.email }}",
          subject: node.data.subject,
          template: `template:${node.data.templateId}`,
          data: {
            workspaceId: "{{ workspaceId }}",
            contactId: "{{ contactId }}",
            journeyId: "{{ journeyId }}",
            // journeyRunId is set into instance.context by
            // startJourneyRun() before engine.start() is called (its
            // value is known — the journey_run row is inserted first —
            // see journeys.ts). Combined with this node's own id, which
            // is a compile-time constant baked in as a literal below
            // rather than an interpolation marker, (journeyRunId,
            // nodeId) uniquely identifies one enrollment's visit to this
            // email node — the engine has no way to expose
            // instance.instanceId to a notification node's config, so
            // this is what the channel's idempotency key is built from
            // instead.
            journeyRunId: "{{ journeyRunId }}",
            nodeId: node.id,
            templateId: node.data.templateId,
          },
        },
        next: target ? [target] : [],
      };
    }

    case "branch": {
      const trueEdge = edges.find((e) => e.sourceHandle === "true");
      const falseEdge = edges.find((e) => e.sourceHandle === "false");
      if (!trueEdge || !falseEdge) {
        warnings.push(`branch node ${node.id} is missing a true or false edge`);
      }
      return {
        ...base,
        type: "condition",
        config: {
          condition: node.data.expression,
          trueBranch: trueEdge?.target ?? "",
          falseBranch: falseEdge?.target ?? "",
        },
      };
    }

    case "split": {
      const routes = node.data.routes.map((route, index) => {
        const edge = edges.find((e) => e.sourceHandle === route.name);
        if (!edge)
          warnings.push(`split node ${node.id} route "${route.name}" has no outgoing edge`);
        return { condition: route.expression, target: edge?.target ?? "", priority: index };
      });
      const defaultEdge = edges.find((e) => e.sourceHandle === "default");
      return {
        ...base,
        type: "router",
        config: { routes, defaultTarget: defaultEdge?.target },
      };
    }

    case "filter": {
      const trueEdge = edges.find((e) => e.sourceHandle === "true") ?? edges[0];
      const falseEdge = edges.find((e) => e.sourceHandle === "false");
      if (!trueEdge) {
        warnings.push(`filter node ${node.id} has no outgoing edge for a passing contact`);
      }
      if (!falseEdge) {
        warnings.push(
          `filter node ${node.id} has no explicit false edge; a filtered-out contact's instance will simply end`,
        );
      }
      return {
        ...base,
        type: "condition",
        config: {
          condition: node.data.expression,
          trueBranch: trueEdge?.target ?? "",
          falseBranch: falseEdge?.target ?? "",
        },
      };
    }

    case "waitEvent": {
      const target = requireSingleTarget(node, edges, warnings);
      return {
        ...base,
        type: "event",
        onEvent: `loopkit.event.${node.data.eventName}`,
        timeout: node.data.timeoutMs,
        next: target ? [target] : [],
      };
    }

    case "webhook": {
      const target = requireSingleTarget(node, edges, warnings);
      return {
        ...base,
        type: "http",
        config: { method: node.data.method, url: node.data.url, body: node.data.body },
        next: target ? [target] : [],
      };
    }

    case "exit": {
      if (edges.length > 0) {
        warnings.push(`exit node ${node.id} has outgoing edges; they will be ignored`);
      }
      return {
        ...base,
        type: "action",
        action: async () => ({ exited: true, reason: node.data.reason }),
        next: [],
      };
    }

    default: {
      const _exhaustive: never = node;
      throw new CompileError(`unknown journey node type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function requireSingleTarget(
  node: NonTriggerJourneyNode,
  edges: { target: string; sourceHandle?: string }[],
  warnings: string[],
): string | undefined {
  if (edges.length === 0) {
    warnings.push(`node ${node.id} (${node.type}) has no outgoing edge`);
    return undefined;
  }
  if (edges.length > 1) {
    warnings.push(`node ${node.id} (${node.type}) has multiple outgoing edges; using the first`);
  }
  return edges[0]!.target;
}
