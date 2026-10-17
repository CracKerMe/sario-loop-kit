import type { TaskNode, WorkflowDefinition } from "ts-workflow-engine-lite";

import { decompileEngineNode, type DecompiledNode } from "./decompileMap";
import type { JourneyEdge, JourneyGraph, JourneyNode } from "./types";

export interface DecompileResult {
  graph: JourneyGraph;
  warnings: string[];
}

export type { DecompiledNode } from "./decompileMap";

/**
 * Best-effort import of a hand-written WorkflowDefinition into a
 * JourneyGraph, for pasting/importing an existing engine definition into
 * the builder. Deliberately lossy where the graph is the source of truth
 * everywhere else in the system: this exists so an import doesn't lose
 * the user's work, not to guarantee compile(decompile(x)) === x. A node
 * type outside the compiler's known set becomes a best-effort "webhook"
 * placeholder node with a warning, rather than failing the whole import.
 *
 * Engine-type → journey-node reconstruction lives in decompileMap.ts.
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

  // STO delay pair: `${waitId}__sto` action + `${waitId}` wait. Collapse
  // back into one `delay` node with mode "bestTime" so the builder shows
  // the marketing concept, not the engine's two-node expansion.
  const stoByWaitId = new Map<string, TaskNode>();
  for (const [id, node] of Object.entries(definition.nodes)) {
    const cfg = (node as TaskNode).config as
      | { journeyOp?: string; waitNodeId?: string }
      | undefined;
    if ((node as TaskNode).type === "action" && cfg?.journeyOp === "stoWait") {
      const waitId = cfg.waitNodeId ?? (id.endsWith("__sto") ? id.slice(0, -5) : id);
      stoByWaitId.set(waitId, node as TaskNode);
    }
  }

  const edges: JourneyEdge[] = [
    { id: "__trigger_edge__", source: "__trigger__", target: definition.startNode },
  ];

  let y = 0;
  for (const [id, node] of Object.entries(definition.nodes)) {
    const engineNode = node as TaskNode;
    // The STO preparatory action is an implementation detail of the
    // companion wait; skip it so it does not appear as its own journey node.
    if (
      engineNode.type === "action" &&
      stoByWaitId.has(id.endsWith("__sto") ? id.slice(0, -5) : id)
    ) {
      continue;
    }

    y += 1;
    let parts = decompileEngineNode(id, engineNode);
    warnings.push(...parts.warnings);

    const sto = stoByWaitId.get(id);
    if (sto && engineNode.type === "wait") {
      const stoCfg = sto.config as {
        maxWaitHours?: number;
        fallbackHour?: number;
        waitNodeId?: string;
      };
      parts = {
        node: {
          id,
          type: "delay",
          data: {
            mode: "bestTime",
            maxWaitHours: stoCfg.maxWaitHours ?? 48,
            fallbackHour: stoCfg.fallbackHour ?? 10,
          },
        } as DecompiledNode,
        // Prefer the wait's outgoing edges (the sto action only pointed at
        // the wait, which we have already collapsed).
        edges: parts.edges,
        warnings: parts.warnings,
      };
    }

    nodes.push({ ...parts.node, position: { x: 0, y: y * 120 } } as JourneyNode);
    edges.push(...parts.edges);
  }

  // Any edge that still points at a collapsed `__sto` action must land on
  // the wait (the journey node id).
  const redirect = new Map<string, string>();
  for (const waitId of stoByWaitId.keys()) {
    redirect.set(`${waitId}__sto`, waitId);
  }
  for (const edge of edges) {
    const to = redirect.get(edge.target);
    if (to) edge.target = to;
  }
  if (redirect.has(definition.startNode)) {
    // Trigger should enter the journey delay node, not the dropped action.
    for (const edge of edges) {
      if (edge.source === "__trigger__") edge.target = redirect.get(edge.target) ?? edge.target;
    }
  }

  return { graph: { nodes, edges }, warnings };
}

// Kept for potential external use / symmetry with the previous module shape.
export type { DecompileParts, EngineNodeDecompiler } from "./decompileMap";
