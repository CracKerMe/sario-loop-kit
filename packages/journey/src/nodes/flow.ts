import type { JourneyNodeDef } from "../nodeDefTypes";
import { evaluateCondition } from "../expression";
import { delayDataToMs } from "../runtimeUtils";
import { describeDuration, nodeBase, requireSingleTarget, validateHasOutgoing } from "./helpers";

export const delayDef: JourneyNodeDef<"delay"> = {
  type: "delay",
  compile: (node, ctx) => {
    const target = requireSingleTarget(node, ctx.edges, ctx.warnings);

    // Send-time optimization: one journey node becomes two engine nodes.
    //   `${id}__sto`  action  — resolve the contact's best hour, seed the
    //                           wait deadline in instance node-state
    //   `${id}`       wait    — bounded durable wait that respects the
    //                           seeded deadline (see resolveWaitDurationMs)
    // Incoming edges are redirected onto the action via setRedirectIncomingTo.
    if (node.data.mode === "bestTime") {
      const maxWaitHours = Math.max(1, Math.min(72, node.data.maxWaitHours ?? 48));
      const waitNodeId = node.id;
      const stoId = `${node.id}__sto`;
      const data = {
        maxWaitHours,
        fallbackHour: node.data.fallbackHour ?? 10,
        waitNodeId,
      };
      ctx.setRedirectIncomingTo?.(stoId);
      ctx.emitExtra?.({
        ...nodeBase(stoId),
        type: "action",
        config: { journeyOp: "stoWait", ...data },
        action: async (instance: {
          context?: unknown;
          state?: { nodes?: Record<string, Record<string, unknown>> };
        }) => {
          const handler = ctx.actions?.stoWait;
          if (!handler) return { ok: false, error: "stoWait handler not configured" };
          return handler(data, (instance.context ?? {}) as never, {
            seedWaitDeadline: (deadlineMs: number) => {
              if (!instance.state) instance.state = { nodes: {} };
              if (!instance.state.nodes) instance.state.nodes = {};
              const prior = instance.state.nodes[waitNodeId] ?? {};
              instance.state.nodes[waitNodeId] = { ...prior, deadline: deadlineMs };
            },
          });
        },
        next: [waitNodeId],
      } as Parameters<NonNullable<typeof ctx.emitExtra>>[0]);
      return {
        ...nodeBase(waitNodeId),
        type: "wait",
        config: {
          durationMs: maxWaitHours * 3600_000,
          externalTimer: { enabled: true },
          durable: true,
        },
        next: target ? [target] : [],
      };
    }

    const config =
      node.data.mode === "until"
        ? { until: node.data.iso, externalTimer: { enabled: true }, durable: true }
        : node.data.mode === "weekly"
          ? {
              // Engine has no native weekly wait — emit a 7-day durable
              // upper bound and leave the precise gate to a timeWindow
              // node. Builder UI surfaces this pairing.
              durationMs: 7 * 86_400_000,
              weekly: {
                dayOfWeek: node.data.dayOfWeek,
                hour: node.data.hour,
                minute: node.data.minute ?? 0,
              },
              externalTimer: { enabled: true },
              durable: true,
            }
          : {
              durationMs: delayDataToMs(node.data),
              externalTimer: { enabled: true },
              durable: true,
            };
    return { ...nodeBase(node.id), type: "wait", config, next: target ? [target] : [] };
  },
  // Matches the previous default validate case (outgoing-edge check only).
  validate: (node, _graph, ctx) => validateHasOutgoing(node, ctx),
  dryRun: (node, ctx) => {
    const d = node.data;
    const description =
      d.mode === "until"
        ? `wait until ${d.iso}`
        : d.mode === "weekly"
          ? `wait until weekly gate (day ${d.dayOfWeek}, ${String(d.hour).padStart(2, "0")}:${String(d.minute ?? 0).padStart(2, "0")})`
          : d.mode === "bestTime"
            ? `wait until the contact's best engagement hour (max ${d.maxWaitHours ?? 48}h, fallback ${String(d.fallbackHour ?? 10).padStart(2, "0")}:00)`
            : `wait ${describeDuration(delayDataToMs(d))}`;
    return {
      nodeId: node.id,
      type: "delay",
      description,
      detail: {
        mode: d.mode,
        ms: d.mode === "duration" ? delayDataToMs(d) : null,
        ...(d.mode === "bestTime"
          ? { maxWaitHours: d.maxWaitHours ?? 48, fallbackHour: d.fallbackHour ?? 10 }
          : {}),
      },
      next: ctx.nextTargets.slice(0, 1),
    };
  },
};

export const waitEventDef: JourneyNodeDef<"waitEvent"> = {
  type: "waitEvent",
  compile: (node, ctx) => {
    // Event success path is `next`; engine timeout calls onError and
    // proceeds along failureNext (ExecutionOrchestrator). Builder edges
    // use sourceHandle "event" (or default) vs "timeout".
    const eventEdge =
      ctx.edges.find((e) => !e.sourceHandle || e.sourceHandle === "event") ?? ctx.edges[0];
    const timeoutEdge = ctx.edges.find((e) => e.sourceHandle === "timeout");
    if (!eventEdge) {
      ctx.warnings.push(`waitEvent node ${node.id} has no event-success outgoing edge`);
    }
    return {
      ...nodeBase(node.id),
      type: "event",
      onEvent: `loopkit.event.${node.data.eventName}`,
      timeout: node.data.timeoutMs,
      next: eventEdge ? [eventEdge.target] : [],
      ...(timeoutEdge ? { failureNext: [timeoutEdge.target] } : {}),
      ...(node.data.eventFilter ? { config: { eventFilter: node.data.eventFilter } } : {}),
    };
  },
  validate: (node, _graph, ctx) => {
    const issues = [];
    const edges = ctx.outgoingEdges;
    const eventEdge = edges.some((e) => !e.sourceHandle || e.sourceHandle === "event");
    if (!eventEdge && edges.length === 0) {
      issues.push({ nodeId: node.id, message: "waitEvent node has no outgoing edge" });
    }
    if (!node.data.eventName) {
      issues.push({ nodeId: node.id, message: "waitEvent node has no event name" });
    }
    return issues;
  },
  dryRun: (node, ctx) => {
    ctx.warnings.push(
      `node '${node.id}': dry-run assumes event "${node.data.eventName}" arrives and follows the success path`,
    );
    return {
      nodeId: node.id,
      type: "waitEvent",
      description: `wait for event "${node.data.eventName}"${node.data.timeoutMs ? ` (timeout ${describeDuration(node.data.timeoutMs)})` : ""}`,
      detail: { eventName: node.data.eventName, timeoutMs: node.data.timeoutMs ?? null },
      next: ctx.nextTargets.slice(0, 1),
    };
  },
};

function evalBranch(
  node: { id: string; type: string; data: { expression: string } },
  ctxRecord: Record<string, unknown>,
  out: { sourceHandle?: string; target: string }[],
  warnings: string[],
): { description: string; detail: Record<string, unknown>; next: string[] } {
  const expression = node.data.expression;
  let passed = false;
  try {
    passed = evaluateCondition(expression, ctxRecord);
  } catch (error) {
    warnings.push(
      `node '${node.id}' expression failed to evaluate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const taken = out.find((e) => e.sourceHandle === (passed ? "true" : "false"));
  return {
    description: passed ? `condition passed: ${expression}` : `condition failed: ${expression}`,
    detail: { expression, result: passed },
    next: taken ? [taken.target] : [],
  };
}

export const branchDef: JourneyNodeDef<"branch"> = {
  type: "branch",
  compile: (node, ctx) => {
    const trueEdge = ctx.edges.find((e) => e.sourceHandle === "true");
    const falseEdge = ctx.edges.find((e) => e.sourceHandle === "false");
    if (!trueEdge || !falseEdge) {
      ctx.warnings.push(`branch node ${node.id} is missing a true or false edge`);
    }
    return {
      ...nodeBase(node.id),
      type: "condition",
      config: {
        condition: node.data.expression,
        trueBranch: trueEdge?.target ?? "",
        falseBranch: falseEdge?.target ?? "",
      },
    };
  },
  validate: (node, _graph, ctx) => {
    const issues = [];
    const edges = ctx.outgoingEdges;
    if (!edges.some((e) => e.sourceHandle === "true")) {
      issues.push({ nodeId: node.id, message: "branch node is missing a true edge" });
    }
    if (!edges.some((e) => e.sourceHandle === "false")) {
      issues.push({ nodeId: node.id, message: "branch node is missing a false edge" });
    }
    return issues;
  },
  dryRun: (node, ctx) => ({
    nodeId: node.id,
    type: "branch",
    ...evalBranch(node, ctx.ctx, ctx.out, ctx.warnings),
  }),
};

export const filterDef: JourneyNodeDef<"filter"> = {
  type: "filter",
  compile: (node, ctx) => {
    const trueEdge = ctx.edges.find((e) => e.sourceHandle === "true") ?? ctx.edges[0];
    const falseEdge = ctx.edges.find((e) => e.sourceHandle === "false");
    if (!trueEdge) {
      ctx.warnings.push(`filter node ${node.id} has no outgoing edge for a passing contact`);
    }
    if (!falseEdge) {
      ctx.warnings.push(
        `filter node ${node.id} has no explicit false edge; a filtered-out contact's instance will simply end`,
      );
    }
    return {
      ...nodeBase(node.id),
      type: "condition",
      config: {
        condition: node.data.expression,
        trueBranch: trueEdge?.target ?? "",
        falseBranch: falseEdge?.target ?? "",
      },
    };
  },
  // Matches the previous default validate case (outgoing-edge check only).
  validate: (node, _graph, ctx) => validateHasOutgoing(node, ctx),
  dryRun: (node, ctx) => ({
    nodeId: node.id,
    type: "filter",
    ...evalBranch(node, ctx.ctx, ctx.out, ctx.warnings),
  }),
};

export const splitDef: JourneyNodeDef<"split"> = {
  type: "split",
  compile: (node, ctx) => {
    const routes = node.data.routes.map((route, index) => {
      const edge = ctx.edges.find((e) => e.sourceHandle === route.name);
      if (!edge)
        ctx.warnings.push(`split node ${node.id} route "${route.name}" has no outgoing edge`);
      return { condition: route.expression, target: edge?.target ?? "", priority: index };
    });
    const defaultEdge = ctx.edges.find((e) => e.sourceHandle === "default");
    return {
      ...nodeBase(node.id),
      type: "router",
      config: { routes, defaultTarget: defaultEdge?.target },
    };
  },
  validate: (node, _graph, ctx) => {
    const issues = [];
    const edges = ctx.outgoingEdges;
    for (const route of node.data.routes) {
      if (!edges.some((e) => e.sourceHandle === route.name)) {
        issues.push({
          nodeId: node.id,
          message: `split route "${route.name}" has no outgoing edge`,
        });
      }
    }
    return issues;
  },
  dryRun: (node, ctx) => {
    let matched: string | undefined;
    for (const route of node.data.routes) {
      try {
        if (evaluateCondition(route.expression, ctx.ctx)) {
          matched = route.name;
          break;
        }
      } catch (error) {
        ctx.warnings.push(
          `node '${node.id}' route "${route.name}" failed to evaluate: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const edge = matched
      ? ctx.out.find((e) => e.sourceHandle === matched)
      : ctx.out.find((e) => e.sourceHandle === "default");
    return {
      nodeId: node.id,
      type: "split",
      description: matched ? `matched route "${matched}"` : "no route matched, taking default",
      detail: { matchedRoute: matched ?? null, routes: node.data.routes.map((r) => r.name) },
      next: edge ? [edge.target] : [],
    };
  },
};
