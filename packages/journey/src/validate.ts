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
      case "timeWindow": {
        const edges = graph.edges.filter((e) => e.source === node.id);
        if (!edges.some((e) => e.sourceHandle === "true")) {
          issues.push({
            nodeId: node.id,
            message: "timeWindow node is missing an in-window (true) edge",
          });
        }
        const days = node.data.days;
        if (!Array.isArray(days) || days.length === 0) {
          issues.push({ nodeId: node.id, message: "timeWindow node has no open days selected" });
        }
        if (node.data.startHour === node.data.endHour) {
          issues.push({
            nodeId: node.id,
            message: "timeWindow start and end hour are identical — window is empty",
          });
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
      case "abSplit": {
        const edges = graph.edges.filter((e) => e.source === node.id);
        const variants = node.data.variants;
        if (!Array.isArray(variants) || variants.length < 2) {
          issues.push({
            nodeId: node.id,
            message: "abSplit needs at least two variants",
          });
        } else {
          for (const v of variants) {
            if (!v.name) {
              issues.push({ nodeId: node.id, message: "abSplit variant is missing a name" });
            } else if (!edges.some((e) => e.sourceHandle === v.name)) {
              issues.push({
                nodeId: node.id,
                message: `abSplit variant "${v.name}" has no outgoing edge`,
              });
            }
            if (!(Number(v.weight) > 0)) {
              issues.push({
                nodeId: node.id,
                message: `abSplit variant "${v.name || "?"}" weight must be > 0`,
              });
            }
          }
        }
        break;
      }
      case "waitEvent": {
        const edges = graph.edges.filter((e) => e.source === node.id);
        const eventEdge = edges.some((e) => !e.sourceHandle || e.sourceHandle === "event");
        if (!eventEdge && edges.length === 0) {
          issues.push({ nodeId: node.id, message: "waitEvent node has no outgoing edge" });
        }
        if (!node.data.eventName) {
          issues.push({ nodeId: node.id, message: "waitEvent node has no event name" });
        }
        break;
      }
      case "parallel": {
        if (count < 2) {
          issues.push({
            nodeId: node.id,
            message: "parallel node needs at least two outgoing branch edges",
          });
        }
        break;
      }
      case "join": {
        const edges = graph.edges.filter((e) => e.source === node.id);
        const incoming = graph.edges.filter((e) => e.target === node.id && e.source !== node.id);
        if (incoming.length < 2) {
          issues.push({
            nodeId: node.id,
            message: "join node needs at least two incoming branch edges",
          });
        }
        if (edges.length === 0) {
          issues.push({ nodeId: node.id, message: "join node has no outgoing edge" });
        } else if (edges.length > 1) {
          issues.push({
            nodeId: node.id,
            message: "join node supports a single outgoing edge (the post-join path)",
          });
        }
        if ((node.data.mode ?? "all") === "all") {
          issues.push(...joinRegionIssues(graph, node.id));
        }
        break;
      }
      case "subJourney":
        if (!node.data.journeyId) {
          issues.push({ nodeId: node.id, message: "subJourney node has no journey selected" });
        }
        if (count === 0) {
          issues.push({ nodeId: node.id, message: "subJourney node has no outgoing edge" });
        }
        break;
      case "email":
        if (!node.data.templateId) {
          issues.push({ nodeId: node.id, message: "email node has no template selected" });
        }
        if (count === 0) {
          issues.push({ nodeId: node.id, message: "email node has no outgoing edge" });
        }
        break;
      case "sendCampaign":
        if (!node.data.campaignId) {
          issues.push({ nodeId: node.id, message: "sendCampaign node has no campaign selected" });
        }
        if (count === 0) {
          issues.push({ nodeId: node.id, message: "sendCampaign node has no outgoing edge" });
        }
        break;
      case "webhook":
        if (!node.data.url) {
          issues.push({ nodeId: node.id, message: "webhook node has no URL" });
        }
        if (count === 0) {
          issues.push({ nodeId: node.id, message: "webhook node has no outgoing edge" });
        }
        break;
      case "notify":
        if (!node.data.url) {
          issues.push({ nodeId: node.id, message: "notify node has no webhook URL" });
        }
        if (!node.data.message) {
          issues.push({ nodeId: node.id, message: "notify node has no message" });
        }
        if (count === 0) {
          issues.push({ nodeId: node.id, message: "notify node has no outgoing edge" });
        }
        break;
      case "updateContact": {
        const d = node.data;
        const hasWork =
          (d.set && Object.keys(d.set).length > 0) ||
          (d.addTags && d.addTags.length > 0) ||
          (d.removeTags && d.removeTags.length > 0);
        if (!hasWork) {
          issues.push({
            nodeId: node.id,
            message: "updateContact node has nothing to set or tag",
          });
        }
        if (count === 0) {
          issues.push({ nodeId: node.id, message: "updateContact node has no outgoing edge" });
        }
        break;
      }
      case "score":
        if (typeof node.data.value !== "number" || Number.isNaN(node.data.value)) {
          issues.push({ nodeId: node.id, message: "score node needs a numeric value" });
        }
        if (count === 0) {
          issues.push({ nodeId: node.id, message: "score node has no outgoing edge" });
        }
        break;
      case "goal":
        if (!node.data.name) {
          issues.push({ nodeId: node.id, message: "goal node has no name" });
        }
        if (count === 0) {
          issues.push({ nodeId: node.id, message: "goal node has no outgoing edge" });
        }
        break;
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
