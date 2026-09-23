import type { JourneyNodeDef, ValidationIssue } from "../nodeDefTypes";
import { hashString, isInTimeWindow } from "../runtimeUtils";
import { nodeBase } from "./helpers";

/**
 * The join gate's action closure. Exported for unit tests and re-exported
 * from compile.ts (historical export surface).
 *
 * Flag lifecycle (all synchronous, evaluated by handleRouting right after
 * the action returns, before any other node in the batch runs):
 *   - not ready      → `__joinGo_<id> = false` → no conditionalNext match →
 *                      the arriving branch path ends here;
 *   - gate opens     → `__joinDone_<id> = true`, `__joinGo_<id> = true` →
 *                      routes to the post-join node;
 *   - already done   → `__joinGo_<id> = false` → late arrivals are consumed
 *                      (mode "any" / redundant arrivals never re-run the
 *                      post-join path).
 *
 * Known engine-level caveat: two branch wakes that interleave INSIDE the
 * join node's own execution window can both observe the pre-open state or
 * clobber the other's flag (the instance context is shared mutable state —
 * the same limitation any concurrent wake has on this engine). The dominant
 * flows — same-batch convergence and well-separated arrivals — are exact.
 */
export function compileJoinGateAction(
  joinNodeId: string,
  mode: "all" | "any",
  waitFor: string[],
): (instance: {
  context?: Record<string, unknown>;
  state?: { nodes?: Record<string, { output?: unknown } | undefined> } | null;
}) => Promise<Record<string, unknown>> {
  const doneKey = `__joinDone_${joinNodeId}`;
  const goKey = `__joinGo_${joinNodeId}`;
  return async (instance) => {
    const nodes = instance.state?.nodes ?? {};
    const ctx = (instance.context ?? {}) as Record<string, unknown>;
    const arrived = waitFor.filter(
      (nid) => (nodes[nid] as { output?: unknown } | undefined)?.output !== undefined,
    );
    const need = mode === "any" ? 1 : waitFor.length;
    if (ctx[doneKey] === true) {
      ctx[goKey] = false;
      return { join: "consumed", arrived: arrived.length, of: waitFor.length };
    }
    if (arrived.length >= need) {
      ctx[doneKey] = true;
      ctx[goKey] = true;
      return { join: "proceed", arrived: arrived.length, of: waitFor.length };
    }
    ctx[goKey] = false;
    return { join: "wait", arrived: arrived.length, of: waitFor.length };
  };
}

export const abSplitDef: JourneyNodeDef<"abSplit"> = {
  type: "abSplit",
  compile: (node, ctx) => {
    const edges = ctx.edges;
    const variants = (node.data.variants ?? []).filter((v) => v.name);
    if (variants.length === 0) {
      ctx.warnings.push(`abSplit node ${node.id} has no variants`);
    }
    const total = variants.reduce((s, v) => s + Math.max(0, Number(v.weight) || 0), 0) || 1;
    const defaultEdge =
      edges.find((e) => e.sourceHandle === "default") ?? edges.find((e) => !e.sourceHandle);

    return {
      ...nodeBase(node.id),
      type: "action",
      config: { journeyOp: "abSplit", variants, totalWeight: total },
      // Pure closure — deterministic bucket from contact identity, written
      // into instance.context so conditionalNext can read it on the same
      // node completion (handleRouting evaluates against instance.context).
      action: async (instance) => {
        const runCtx = (instance.context ?? {}) as Record<string, unknown>;
        const contact = runCtx.contact as { id?: string } | undefined;
        const seed = String(runCtx.contactId ?? contact?.id ?? instance.instanceId ?? "");
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
        runCtx.__abVariant = chosen;
        return { variant: chosen, bucket };
      },
      conditionalNext: variants.flatMap((v) => {
        const edge = edges.find((e) => e.sourceHandle === v.name);
        if (!edge) {
          ctx.warnings.push(`abSplit node ${node.id} variant "${v.name}" has no outgoing edge`);
          return [];
        }
        return [{ condition: `__abVariant == "${v.name}"`, target: edge.target }];
      }),
      defaultNext: defaultEdge?.target,
      next: defaultEdge ? [defaultEdge.target] : [],
    };
  },
  validate: (node, _graph, ctx): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    const edges = ctx.outgoingEdges;
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
    return issues;
  },
  dryRun: (node, ctx) => {
    const out = ctx.out;
    const variants = (node.data.variants ?? []).filter((v) => v.name);
    const total = variants.reduce((s, v) => s + Math.max(0, Number(v.weight) || 0), 0) || 1;
    // Identical arithmetic to compile()'s action closure — same seed
    // (contact identity), same hash, so the dry-run variant IS the
    // variant the contact will land in.
    const seed = String(
      ctx.ctx.contactId ?? (ctx.ctx.contact as { id?: string } | undefined)?.id ?? "",
    );
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
    ctx.ctx.__abVariant = chosen;
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
  },
};

export const timeWindowDef: JourneyNodeDef<"timeWindow"> = {
  type: "timeWindow",
  compile: (node, ctx) => {
    const trueEdge = ctx.edges.find((e) => e.sourceHandle === "true") ?? ctx.edges[0];
    const falseEdge = ctx.edges.find((e) => e.sourceHandle === "false");
    if (!trueEdge) {
      ctx.warnings.push(`timeWindow node ${node.id} has no "true" edge (in-window path)`);
    }
    if (!falseEdge) {
      ctx.warnings.push(
        `timeWindow node ${node.id} has no "false" edge; out-of-window contacts will end`,
      );
    }
    const data = node.data;
    return {
      ...nodeBase(node.id),
      type: "action",
      config: { journeyOp: "timeWindow", ...data },
      action: async (instance) => {
        const inWindow = isInTimeWindow(data);
        const runCtx = instance.context as Record<string, unknown> | undefined;
        if (runCtx) runCtx.__timeWindowOk = inWindow;
        return { inWindow };
      },
      conditionalNext: [
        { condition: "__timeWindowOk == true", target: trueEdge?.target ?? "" },
        ...(falseEdge ? [{ condition: "__timeWindowOk == false", target: falseEdge.target }] : []),
      ],
      defaultNext: falseEdge?.target,
      next: falseEdge ? [falseEdge.target] : [],
    };
  },
  validate: (node, _graph, ctx): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    const edges = ctx.outgoingEdges;
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
    return issues;
  },
  dryRun: (node, ctx) => {
    const inWindow = isInTimeWindow(node.data, ctx.now);
    ctx.ctx.__timeWindowOk = inWindow;
    const edge = ctx.out.find((e) => e.sourceHandle === (inWindow ? "true" : "false"));
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
  },
};

export const parallelDef: JourneyNodeDef<"parallel"> = {
  type: "parallel",
  compile: (node, ctx) => {
    // Fan-out: the engine advances ALL entries of a node's `next` array as
    // one concurrent batch (ExecutionOrchestrator batch loop), so parallel
    // is a marker action whose next carries every outgoing edge. Branches
    // execute in batch order; a branch that PARKS (delay/waitEvent) does
    // not resolve its executeNode promise until it completes, which
    // postpones its batch siblings — wait-free branches converge at the
    // join instantly, parked branches converge when they wake. The
    // journey's `join` node gates convergence across those cases — see
    // compileJoinGateAction.
    const edges = ctx.edges;
    if (edges.length < 2) {
      ctx.warnings.push(`parallel node ${node.id} has fewer than two outgoing edges`);
    }
    return {
      ...nodeBase(node.id),
      type: "action",
      config: { journeyOp: "parallel", branches: edges.length },
      action: async () => ({ started: true, branches: edges.length }),
      next: edges.map((e) => e.target),
    };
  },
  validate: (node, _graph, ctx): ValidationIssue[] => {
    if (ctx.outgoingCount < 2) {
      return [
        {
          nodeId: node.id,
          message: "parallel node needs at least two outgoing branch edges",
        },
      ];
    }
    return [];
  },
  dryRun: (node, ctx) => ({
    nodeId: node.id,
    type: "parallel",
    description: `fan out into ${Math.max(ctx.nextTargets.length, 0)} concurrent branches`,
    detail: { branches: ctx.nextTargets },
    next: ctx.nextTargets,
  }),
};

export const joinDef: JourneyNodeDef<"join"> = {
  type: "join",
  compile: (node, ctx) => {
    // Arrival-gate barrier compiled as an ACTION, not the engine's native
    // `join` node. Reason: the engine's batch orchestrator collapses all
    // same-batch arrivals into one join execution, and a native join with
    // mode "all" THROWS when reached before every branch has output —
    // which is exactly what happens when a branch tail is a wait/event
    // node that completes in a later batch. The gate below re-derives
    // arrival from `instance.state` output presence instead, so it is
    // idempotent across any arrival interleaving:
    //   - all branches arrive in one batch → one execution, gate opens
    //     (dedupe collapses the arrivals, the count still sees them all);
    //   - branches arrive in different batches → premature executions
    //     set __joinGo false and route nowhere (their branch path ends;
    //     the still-running branches keep the instance alive), and the
    //     LAST arrival opens the gate;
    //   - mode "any" opens on the first arrival; the __joinDone latch
    //     consumes later arrivals so the post-join path never re-runs.
    const outgoingEdges = ctx.edges;
    if (outgoingEdges.length === 0) {
      ctx.warnings.push(
        `join node ${node.id} has no outgoing edge; the post-join path is unreachable`,
      );
    }
    if (outgoingEdges.length > 1) {
      ctx.warnings.push(`join node ${node.id} has multiple outgoing edges; using the first`);
    }
    const postJoinTarget = outgoingEdges[0]?.target;
    const mode = node.data.mode ?? "all";
    // waitFor = the branch TAIL nodes that feed the join. Every engine
    // node type writes `state.nodes[id].output` on completion (actions,
    // notifications, waits, event wakes), so output presence is the
    // arrival signal.
    const waitFor = ctx.incomingSources;
    if (waitFor.length < 2) {
      ctx.warnings.push(
        `join node ${node.id} has fewer than two incoming branches; the gate opens on the first arrival`,
      );
    }
    return {
      ...nodeBase(node.id),
      type: "action",
      config: { journeyOp: "join", mode, waitFor },
      action: compileJoinGateAction(node.id, mode, waitFor),
      // Routing reads the flag the action just wrote (same executeNode,
      // before any await) — see compileJoinGateAction for the flag
      // lifecycle. No `next`: a not-yet-ready arrival simply ends its
      // branch path.
      ...(postJoinTarget
        ? {
            conditionalNext: [{ condition: `__joinGo_${node.id} == true`, target: postJoinTarget }],
          }
        : {}),
      next: [],
    };
  },
  // Per-node config only. Join-region closure (mode "all") is a graph-level
  // rule enforced by validateGraph's top level via joinRegionIssues.
  validate: (node, _graph, ctx): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    const edges = ctx.outgoingEdges;
    const incoming = ctx.incomingEdges;
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
    return issues;
  },
  dryRun: (node, ctx) => {
    const mode = node.data.mode ?? "all";
    ctx.warnings.push(
      `node '${node.id}': dry-run follows a single path and cannot simulate sibling branches; assumes the join gate (mode ${mode}) opens`,
    );
    return {
      nodeId: node.id,
      type: "join",
      description: `wait for parallel branches to converge (mode ${mode})`,
      detail: { mode },
      next: ctx.nextTargets.slice(0, 1),
    };
  },
};
