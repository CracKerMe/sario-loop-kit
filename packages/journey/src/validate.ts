import type { JourneyGraph } from "./types";
import type { ValidateNodeContext, ValidationIssue } from "./nodeDefs";
import { validateNodeWithDef } from "./nodeDefs";

export type { ValidationIssue } from "./nodeDefs";

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
 *
 * Per-node config checks live on NODE_DEFS descriptors. Graph-level rules
 * (trigger uniqueness, edge integrity, reachability, join-region closure)
 * stay here.
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

  for (const node of graph.nodes) {
    const outgoingEdges = graph.edges.filter((e) => e.source === node.id);
    const incomingEdges = graph.edges.filter((e) => e.target === node.id && e.source !== node.id);
    const ctx: ValidateNodeContext = {
      outgoingCount: outgoingEdges.length,
      outgoingEdges,
      incomingEdges,
    };
    issues.push(...validateNodeWithDef(node, graph, ctx));
  }

  // Graph-level: join region closure for mode-"all" joins. A branch that
  // dead-ends, exits, or escapes the region before the join would deadlock
  // the post-join path — fail loudly at validate time instead.
  for (const node of graph.nodes) {
    if (node.type === "join" && (node.data.mode ?? "all") === "all") {
      issues.push(...joinRegionIssues(graph, node.id));
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

/**
 * Closure check for a mode-"all" join: every path fanning out of the shared
 * parallel ancestor must reach the join. The compiled gate opens on the last
 * arrival, so a branch that dead-ends, exits, or escapes the region before
 * the join would deadlock the post-join path forever (the run completes with
 * it silently skipped — worse than a loud validation failure at publish).
 *
 * Mode "any" deliberately skips this: branches are allowed to exit early,
 * and the gate opens on the first arrival.
 */
function joinRegionIssues(graph: JourneyGraph, joinId: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const parents = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.source === e.target) continue;
    const list = parents.get(e.target) ?? [];
    if (!list.includes(e.source)) list.push(e.source);
    parents.set(e.target, list);
  }

  const ancestorsOf = (start: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(parents.get(start) ?? [])];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      queue.push(...(parents.get(cur) ?? []));
    }
    return seen;
  };

  const incoming = graph.edges
    .filter((e) => e.target === joinId && e.source !== joinId)
    .map((e) => e.source)
    .filter((id, i, all) => all.indexOf(id) === i);
  if (incoming.length === 0) return [];

  const ancestorSets = incoming.map((id) => ancestorsOf(id));
  const common = [...ancestorSets[0]!].filter((id) => ancestorSets.every((set) => set.has(id)));
  const parallelAncestors = common.filter((id) => byId.get(id)?.type === "parallel");
  if (parallelAncestors.length === 0) {
    issues.push({
      nodeId: joinId,
      message:
        "join node (mode all) has no shared parallel ancestor; all branches must fan out of one parallel node",
    });
    return issues;
  }

  // Deepest common parallel ancestor = the innermost parallel region (a
  // nested parallel inside another parallel is still a common ancestor).
  const depthFromTrigger = new Map<string, number>();
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (trigger) {
    const children = new Map<string, string[]>();
    for (const e of graph.edges) {
      if (e.source === e.target) continue;
      const list = children.get(e.source) ?? [];
      if (!list.includes(e.target)) list.push(e.target);
      children.set(e.source, list);
    }
    const queue: [string, number][] = [[trigger.id, 0]];
    while (queue.length > 0) {
      const [id, depth] = queue.shift()!;
      if ((depthFromTrigger.get(id) ?? Infinity) <= depth) continue;
      depthFromTrigger.set(id, depth);
      for (const child of children.get(id) ?? []) queue.push([child, depth + 1]);
    }
  }
  const root = parallelAncestors.sort(
    (a, b) => (depthFromTrigger.get(b) ?? 0) - (depthFromTrigger.get(a) ?? 0),
  )[0]!;

  // Region: everything reachable from the parallel node without crossing
  // the join.
  const region = new Set<string>();
  const queue = graph.edges
    .filter((e) => e.source === root && e.target !== root)
    .map((e) => e.target);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === joinId || region.has(id)) continue;
    region.add(id);
    for (const e of graph.edges) {
      if (e.source === id) queue.push(e.target);
    }
  }

  for (const id of region) {
    const node = byId.get(id);
    if (!node) continue;
    const out = graph.edges.filter((e) => e.source === id);
    if (node.type === "exit") {
      issues.push({
        nodeId: id,
        message: `exit node "${id}" inside the parallel region — with join mode "all", a branch that exits before the join deadlocks it`,
      });
      continue;
    }
    if (out.length === 0) {
      issues.push({
        nodeId: id,
        message: `node "${id}" never reaches the join node — join mode "all" would wait forever`,
      });
      continue;
    }
    const escaping = out.filter((e) => e.target !== joinId && !region.has(e.target));
    if (escaping.length > 0) {
      issues.push({
        nodeId: id,
        message: `node "${id}" has an edge leaving the parallel region without passing through the join node`,
      });
    }
  }

  for (const source of incoming) {
    if (!region.has(source)) {
      issues.push({
        nodeId: joinId,
        message: `join input "${source}" is not reachable from the shared parallel node "${root}"`,
      });
    }
  }

  return issues;
}
