import type { TaskNode, WorkflowDefinition } from "ts-workflow-engine-lite";

import type { JourneyEdge, JourneyGraph, JourneyNode } from "./types";

export interface DecompileResult {
  graph: JourneyGraph;
  warnings: string[];
}

/**
 * Best-effort import of a hand-written WorkflowDefinition into a
 * JourneyGraph, for pasting/importing an existing engine definition into
 * the builder. Deliberately lossy where the graph is the source of truth
 * everywhere else in the system: this exists so an import doesn't lose
 * the user's work, not to guarantee compile(decompile(x)) === x. A node
 * type outside the compiler's known set becomes a best-effort "webhook"
 * placeholder node with a warning, rather than failing the whole import.
 */
export function decompile(definition: WorkflowDefinition): DecompileResult {
  const warnings: string[] = [];
  const nodes: JourneyNode[] = [
    {
      id: "__trigger__",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { trigger: { kind: "manual" } },
    },
  ];
  const edges: JourneyEdge[] = [
    { id: "__trigger_edge__", source: "__trigger__", target: definition.startNode },
  ];

  let y = 0;
  for (const [id, node] of Object.entries(definition.nodes)) {
    y += 1;
    const decompiled = decompileNode(id, node, warnings);
    nodes.push({ ...decompiled, position: { x: 0, y: y * 120 } });
    edges.push(...edgesForNode(id, node));
  }

  return { graph: { nodes, edges }, warnings };
}

type DecompiledNode = { [K in JourneyNode as K["type"]]: Omit<K, "position"> }[JourneyNode["type"]];

function decompileNode(id: string, node: TaskNode, warnings: string[]): DecompiledNode {
  const config = (node.config ?? {}) as Record<string, unknown>;

  switch (node.type) {
    case "wait": {
      const durationMs = typeof config.durationMs === "number" ? config.durationMs : undefined;
      const until = typeof config.until === "string" ? config.until : undefined;
      return {
        id,
        type: "delay",
        data: until
          ? { mode: "until", iso: until }
          : { mode: "duration", ms: durationMs ?? node.timeout ?? 0 },
      };
    }

    case "notification": {
      const template = typeof config.template === "string" ? config.template : "";
      const templateId = template.startsWith("template:")
        ? template.slice("template:".length)
        : template;
      if (config.channel !== "loopkit-email") {
        warnings.push(
          `node ${id}: notification channel "${String(config.channel)}" is not loopkit-email; imported as an email node anyway`,
        );
      }
      return {
        id,
        type: "email",
        data: {
          templateId,
          subject: typeof config.subject === "string" ? config.subject : undefined,
        },
      };
    }

    case "condition": {
      const conditionConfig = config as { condition?: string };
      return { id, type: "branch", data: { expression: conditionConfig.condition ?? "" } };
    }

    case "router": {
      const routerConfig = config as { routes?: { condition: string; target: string }[] };
      const routes = (routerConfig.routes ?? []).map((r, i) => ({
        name: `route-${i}`,
        expression: r.condition,
      }));
      return { id, type: "split", data: { routes } };
    }

    case "event": {
      const eventName = node.onEvent?.startsWith("loopkit.event.")
        ? node.onEvent.slice("loopkit.event.".length)
        : (node.onEvent ?? "");
      return { id, type: "waitEvent", data: { eventName, timeoutMs: node.timeout } };
    }

    case "http": {
      const httpConfig = config as { method?: string; url?: string; body?: unknown };
      return {
        id,
        type: "webhook",
        data: {
          url: httpConfig.url ?? "",
          method: (httpConfig.method as "GET") ?? "GET",
          body: httpConfig.body,
        },
      };
    }

    default: {
      warnings.push(
        `node ${id}: engine node type "${node.type}" has no journey-graph equivalent; imported as a placeholder webhook node`,
      );
      return { id, type: "webhook", data: { url: "", method: "GET" } };
    }
  }
}

function edgesForNode(id: string, node: TaskNode): JourneyEdge[] {
  const out: JourneyEdge[] = [];

  if (node.type === "condition") {
    const config = (node.config ?? {}) as { trueBranch?: string; falseBranch?: string };
    if (config.trueBranch)
      out.push({ id: `${id}-true`, source: id, target: config.trueBranch, sourceHandle: "true" });
    if (config.falseBranch)
      out.push({
        id: `${id}-false`,
        source: id,
        target: config.falseBranch,
        sourceHandle: "false",
      });
    return out;
  }

  if (node.type === "router") {
    const config = (node.config ?? {}) as { routes?: { target: string }[]; defaultTarget?: string };
    (config.routes ?? []).forEach((route, i) => {
      out.push({
        id: `${id}-route-${i}`,
        source: id,
        target: route.target,
        sourceHandle: `route-${i}`,
      });
    });
    if (config.defaultTarget) {
      out.push({
        id: `${id}-default`,
        source: id,
        target: config.defaultTarget,
        sourceHandle: "default",
      });
    }
    return out;
  }

  for (const target of node.next ?? []) {
    out.push({ id: `${id}-${target}`, source: id, target });
  }
  return out;
}
