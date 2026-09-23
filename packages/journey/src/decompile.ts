import type { TaskNode, WorkflowDefinition } from "ts-workflow-engine-lite";

import { decompileEngineNode } from "./decompileMap";
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
  const edges: JourneyEdge[] = [
    { id: "__trigger_edge__", source: "__trigger__", target: definition.startNode },
  ];

  let y = 0;
  for (const [id, node] of Object.entries(definition.nodes)) {
    y += 1;
    const parts = decompileEngineNode(id, node as TaskNode);
    warnings.push(...parts.warnings);
    nodes.push({ ...parts.node, position: { x: 0, y: y * 120 } } as JourneyNode);
    edges.push(...parts.edges);
  }

  return { graph: { nodes, edges }, warnings };
}

// Kept for potential external use / symmetry with the previous module shape.
export type { DecompileParts, EngineNodeDecompiler } from "./decompileMap";
