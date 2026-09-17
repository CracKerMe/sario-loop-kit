import type { JourneyGraph } from "./types";

export interface ValidationIssue {
  nodeId?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Structural pre-flight check for a journey graph — cheap enough to run
 * on every builder edit, client-side (this package has zero runtime deps
 * on the engine, only `import type`, so it's safe to bundle into the
 * browser). Catches the mistakes a builder UI can trivially make before
 * they reach the server-side compile() + publish path, which does the
 * authoritative validation and node-type whitelist check.
 */
export function validateGraph(graph: JourneyGraph): ValidationResult {
  const issues: ValidationIssue[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  if (triggers.length === 0) {
    issues.push({ message: "journey has no trigger node" });
  } else if (triggers.length > 1) {
    issues.push({ message: "journey has more than one trigger node" });
  }

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      issues.push({ nodeId: node.id, message: `duplicate node id: ${node.id}` });
    }
    ids.add(node.id);
  }

  for (const edge of graph.edges) {
    if (!byId.has(edge.source)) {
      issues.push({ message: `edge references unknown source node: ${edge.source}` });
    }
    if (!byId.has(edge.target)) {
      issues.push({ message: `edge references unknown target node: ${edge.target}` });
    }
  }

  const outgoingCount = new Map<string, number>();
  for (const edge of graph.edges) {
    outgoingCount.set(edge.source, (outgoingCount.get(edge.source) ?? 0) + 1);
  }

  for (const node of graph.nodes) {
    const count = outgoingCount.get(node.id) ?? 0;
    switch (node.type) {
      case "exit":
        if (count > 0) issues.push({ nodeId: node.id, message: "exit node has outgoing edges" });
        break;
      case "branch": {
        const edges = graph.edges.filter((e) => e.source === node.id);
        if (!edges.some((e) => e.sourceHandle === "true")) {
          issues.push({ nodeId: node.id, message: "branch node is missing a true edge" });
        }
        if (!edges.some((e) => e.sourceHandle === "false")) {
          issues.push({ nodeId: node.id, message: "branch node is missing a false edge" });
        }
        break;
      }
      case "split": {
        const edges = graph.edges.filter((e) => e.source === node.id);
        for (const route of node.data.routes) {
          if (!edges.some((e) => e.sourceHandle === route.name)) {
            issues.push({
              nodeId: node.id,
              message: `split route "${route.name}" has no outgoing edge`,
            });
          }
        }
        break;
      }
      case "trigger":
        if (count === 0)
          issues.push({ nodeId: node.id, message: "trigger node has no outgoing edge" });
        break;
      default:
        if (count === 0) {
          issues.push({ nodeId: node.id, message: `${node.type} node has no outgoing edge` });
        }
    }
  }

  // Reachability: every non-trigger node should be reachable from the trigger.
  if (triggers.length === 1) {
    const reachable = new Set<string>();
    const queue = [triggers[0]!.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const edge of graph.edges) {
        if (edge.source === current) queue.push(edge.target);
      }
    }
    for (const node of graph.nodes) {
      if (node.type !== "trigger" && !reachable.has(node.id)) {
        issues.push({
          nodeId: node.id,
          message: `node ${node.id} is not reachable from the trigger`,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
