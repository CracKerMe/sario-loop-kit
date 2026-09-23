/**
 * Reverse of the compile table: engine TaskNode → journey JourneyNode + edges.
 * Keyed by engine node type (wait / notification / condition / router /
 * event / http / action / subworkflow), NOT journey node type — decompile is
 * best-effort import of a hand-written WorkflowDefinition into the builder.
 *
 * Action nodes are further keyed by their `journeyOp` marker (see
 * ACTION_OP_DECOMPILE_MAP) so each journey action type owns its reverse.
 * Edge reconstruction is driven by the ENGINE node shape (matching the
 * historical edgesForNode), with the decompiled journey type used only to
 * infer sourceHandle names.
 */
import type { TaskNode } from "ts-workflow-engine-lite";

import type { JourneyEdge, JourneyNode } from "./types";

export type DecompiledNode = {
  [K in JourneyNode as K["type"]]: Omit<K, "position">;
}[JourneyNode["type"]];

export interface DecompileParts {
  node: DecompiledNode;
  edges: JourneyEdge[];
  warnings: string[];
}

export type EngineNodeDecompiler = (id: string, node: TaskNode) => DecompileParts;

function configOf(node: TaskNode): Record<string, unknown> {
  return (node.config ?? {}) as Record<string, unknown>;
}

function linearEdges(id: string, node: TaskNode): JourneyEdge[] {
  return (node.next ?? []).map((target) => ({ id: `${id}-${target}`, source: id, target }));
}

function conditionBranchEdges(id: string, node: TaskNode): JourneyEdge[] {
  const out: JourneyEdge[] = [];
  const conditionConfig = configOf(node) as { trueBranch?: string; falseBranch?: string };
  if (conditionConfig.trueBranch)
    out.push({
      id: `${id}-true`,
      source: id,
      target: conditionConfig.trueBranch,
      sourceHandle: "true",
    });
  if (conditionConfig.falseBranch)
    out.push({
      id: `${id}-false`,
      source: id,
      target: conditionConfig.falseBranch,
      sourceHandle: "false",
    });
  return out;
}

function routerEdges(id: string, node: TaskNode, decompiled: DecompiledNode): JourneyEdge[] {
  const out: JourneyEdge[] = [];
  const routerConfig = configOf(node) as {
    routes?: { target: string }[];
    defaultTarget?: string;
  };
  const data = (decompiled.data ?? {}) as Record<string, unknown>;
  const routeNames =
    decompiled.type === "split"
      ? ((data.routes as { name: string }[]) ?? []).map((r) => r.name)
      : [];
  (routerConfig.routes ?? []).forEach((route, i) => {
    out.push({
      id: `${id}-route-${i}`,
      source: id,
      target: route.target,
      sourceHandle: routeNames[i] ?? `route-${i}`,
    });
  });
  if (routerConfig.defaultTarget) {
    out.push({
      id: `${id}-default`,
      source: id,
      target: routerConfig.defaultTarget,
      sourceHandle: "default",
    });
  }
  return out;
}

function eventEdges(id: string, node: TaskNode): JourneyEdge[] {
  const out: JourneyEdge[] = [];
  const eventTarget = node.next?.[0];
  if (eventTarget) {
    out.push({ id: `${id}-event`, source: id, target: eventTarget, sourceHandle: "event" });
  }
  const timeoutTarget = node.failureNext?.[0];
  if (timeoutTarget) {
    out.push({
      id: `${id}-timeout`,
      source: id,
      target: timeoutTarget,
      sourceHandle: "timeout",
    });
  }
  return out;
}

function inferHandleFromCondition(
  condition: string,
  decompiled: { type: string; data?: unknown },
): string {
  if (decompiled.type === "abSplit") {
    const m = condition.match(/__abVariant\s*==\s*"([^"]+)"/);
    if (m) return m[1]!;
  }
  if (condition.includes("__timeWindowOk == true") || condition.includes("__timeWindowOk ==true")) {
    return "true";
  }
  if (
    condition.includes("__timeWindowOk == false") ||
    condition.includes("__timeWindowOk ==false")
  ) {
    return "false";
  }
  return "default";
}

function conditionalNextEdges(
  id: string,
  node: TaskNode,
  decompiled: DecompiledNode,
): JourneyEdge[] {
  const out: JourneyEdge[] = [];
  if (decompiled.type === "join") {
    // The gate's single conditional entry IS the post-join edge — no handle.
    return (node.conditionalNext ?? []).map((branch) => ({
      id: `${id}-${branch.target}`,
      source: id,
      target: branch.target,
    }));
  }
  for (const branch of node.conditionalNext ?? []) {
    const handle = inferHandleFromCondition(branch.condition, decompiled);
    out.push({
      id: `${id}-${handle}-${branch.target}`,
      source: id,
      target: branch.target,
      sourceHandle: handle,
    });
  }
  if (node.defaultNext) {
    out.push({
      id: `${id}-default`,
      source: id,
      target: node.defaultNext,
      sourceHandle: decompiled.type === "abSplit" ? "default" : "false",
    });
  }
  return out;
}

/**
 * Mirrors the historical edgesForNode: engine shape decides the edge
 * strategy; the decompiled journey type only names sourceHandles.
 */
export function edgesForDecompiled(
  id: string,
  node: TaskNode,
  decompiled: DecompiledNode,
): JourneyEdge[] {
  const config = configOf(node);

  if (node.type === "condition" || (node.type === "action" && config.op === "timeWindow")) {
    // action timeWindow uses conditionalNext instead
    if (node.type === "condition") {
      return conditionBranchEdges(id, node);
    }
  }

  if (node.type === "router") {
    return routerEdges(id, node, decompiled);
  }

  if (node.type === "event") {
    return eventEdges(id, node);
  }

  // action nodes with conditionalNext (abSplit / timeWindow / join)
  if (node.conditionalNext?.length) {
    return conditionalNextEdges(id, node, decompiled);
  }

  return linearEdges(id, node);
}

// ---------------------------------------------------------------------------
// Node reconstruction by engine type
// ---------------------------------------------------------------------------

function decompileWait(id: string, node: TaskNode): DecompileParts {
  const config = configOf(node);
  const durationMs = typeof config.durationMs === "number" ? config.durationMs : undefined;
  const until = typeof config.until === "string" ? config.until : undefined;
  const weekly = config.weekly as
    | { dayOfWeek?: number; hour?: number; minute?: number }
    | undefined;
  let decompiled: DecompiledNode;
  if (until) {
    decompiled = { id, type: "delay", data: { mode: "until", iso: until } };
  } else if (weekly && typeof weekly.dayOfWeek === "number") {
    decompiled = {
      id,
      type: "delay",
      data: {
        mode: "weekly",
        dayOfWeek: weekly.dayOfWeek,
        hour: weekly.hour ?? 9,
        minute: weekly.minute ?? 0,
      },
    };
  } else {
    decompiled = {
      id,
      type: "delay",
      data: { mode: "duration", ms: durationMs ?? node.timeout ?? 0 },
    };
  }
  return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
}

function decompileNotification(id: string, node: TaskNode): DecompileParts {
  const config = configOf(node);
  const warnings: string[] = [];
  const template = typeof config.template === "string" ? config.template : "";
  const templateId = template.startsWith("template:")
    ? template.slice("template:".length)
    : template;
  if (config.channel !== "loopkit-email") {
    warnings.push(
      `node ${id}: notification channel "${String(config.channel)}" is not loopkit-email; imported as an email node anyway`,
    );
  }
  const data = (config.data ?? {}) as Record<string, unknown>;
  const decompiled: DecompiledNode = {
    id,
    type: "email",
    data: {
      templateId,
      subject: typeof config.subject === "string" ? config.subject : undefined,
      preheader: typeof data.preheader === "string" ? data.preheader : undefined,
      fromName: typeof data.fromName === "string" ? data.fromName : undefined,
      replyTo: typeof data.replyTo === "string" ? data.replyTo : undefined,
    },
  };
  return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings };
}

function decompileCondition(id: string, node: TaskNode): DecompileParts {
  const config = configOf(node);
  const conditionConfig = config as { condition?: string; op?: string };
  let decompiled: DecompiledNode;
  if (conditionConfig.op === "timeWindow") {
    decompiled = {
      id,
      type: "timeWindow",
      data: {
        days: (config.days as number[]) ?? [1, 2, 3, 4, 5],
        startHour: Number(config.startHour ?? 9),
        endHour: Number(config.endHour ?? 18),
      },
    };
  } else {
    decompiled = { id, type: "branch", data: { expression: conditionConfig.condition ?? "" } };
  }
  return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
}

function decompileRouter(id: string, node: TaskNode): DecompileParts {
  const config = configOf(node);
  const routerConfig = config as { routes?: { condition: string; target: string }[] };
  const routes = (routerConfig.routes ?? []).map((r, i) => ({
    name: `route-${i}`,
    expression: r.condition,
  }));
  const decompiled: DecompiledNode = { id, type: "split", data: { routes } };
  return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
}

function decompileEvent(id: string, node: TaskNode): DecompileParts {
  const eventName = node.onEvent?.startsWith("loopkit.event.")
    ? node.onEvent.slice("loopkit.event.".length)
    : (node.onEvent ?? "");
  const decompiled: DecompiledNode = {
    id,
    type: "waitEvent",
    data: { eventName, timeoutMs: node.timeout },
  };
  return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
}

function decompileHttp(id: string, node: TaskNode): DecompileParts {
  const config = configOf(node);
  const httpConfig = config as {
    method?: string;
    url?: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
  };
  const body = httpConfig.body as { message?: string; subject?: string } | undefined;
  let decompiled: DecompiledNode;
  if (typeof body?.message === "string" && typeof httpConfig.url === "string") {
    decompiled = {
      id,
      type: "notify",
      data: {
        url: httpConfig.url,
        subject: body.subject,
        message: body.message,
        headers: httpConfig.headers,
      },
    };
  } else {
    decompiled = {
      id,
      type: "webhook",
      data: {
        url: httpConfig.url ?? "",
        method: (httpConfig.method as "GET") ?? "GET",
        body: httpConfig.body,
        headers: httpConfig.headers,
        timeoutMs: httpConfig.timeoutMs,
        maxRetries: node.maxRetries,
      },
    };
  }
  return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
}

function decompileSubworkflow(id: string, node: TaskNode): DecompileParts {
  const warnings: string[] = [];
  const subId = typeof node.subworkflowId === "string" ? node.subworkflowId : "";
  const journeyId = subId.startsWith("journey-") ? subId.slice("journey-".length) : "";
  if (!journeyId) {
    warnings.push(
      `node ${id}: subworkflow id "${subId}" is not a journey workflow id; imported as a subJourney node with an empty reference`,
    );
  }
  const decompiled: DecompiledNode = { id, type: "subJourney", data: { journeyId } };
  return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings };
}

// ---------------------------------------------------------------------------
// Action-op reverse map (engine `action` + config.journeyOp → journey node)
// ---------------------------------------------------------------------------

export type ActionOpDecompiler = (id: string, node: TaskNode) => DecompileParts;

export const ACTION_OP_DECOMPILE_MAP: Record<string, ActionOpDecompiler> = {
  updateContact: (id, node) => {
    const config = configOf(node);
    const decompiled: DecompiledNode = {
      id,
      type: "updateContact",
      data: {
        set: config.set as Record<string, unknown> | undefined,
        addTags: config.addTags as string[] | undefined,
        removeTags: config.removeTags as string[] | undefined,
      },
    };
    return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
  },
  score: (id, node) => {
    const config = configOf(node);
    const decompiled: DecompiledNode = {
      id,
      type: "score",
      data: {
        property: (config.property as string) ?? "score",
        value: Number(config.value ?? 0),
        op: (config.op === "set" ? "set" : "add") as "add" | "set",
      },
    };
    return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
  },
  goal: (id, node) => {
    const config = configOf(node);
    const decompiled: DecompiledNode = {
      id,
      type: "goal",
      data: {
        name: String(config.name ?? "converted"),
        value: typeof config.value === "number" ? config.value : undefined,
        properties: config.properties as Record<string, unknown> | undefined,
      },
    };
    return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
  },
  abSplit: (id, node) => {
    const config = configOf(node);
    const variants = (config.variants as { name: string; weight: number }[]) ?? [];
    const decompiled: DecompiledNode = { id, type: "abSplit", data: { variants } };
    return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
  },
  timeWindow: (id, node) => {
    const config = configOf(node);
    const decompiled: DecompiledNode = {
      id,
      type: "timeWindow",
      data: {
        days: (config.days as number[]) ?? [1, 2, 3, 4, 5],
        startHour: Number(config.startHour ?? 9),
        endHour: Number(config.endHour ?? 18),
      },
    };
    return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
  },
  parallel: (id, node) => {
    const decompiled: DecompiledNode = { id, type: "parallel", data: {} };
    return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
  },
  join: (id, node) => {
    const config = configOf(node);
    const mode = config.mode === "any" ? "any" : "all";
    const decompiled: DecompiledNode = { id, type: "join", data: { mode } };
    return { node: decompiled, edges: edgesForDecompiled(id, node, decompiled), warnings: [] };
  },
};

function decompileAction(id: string, node: TaskNode): DecompileParts {
  const config = configOf(node);
  const op = config.journeyOp ?? config.op;
  const exitNode: DecompiledNode = {
    id,
    type: "exit",
    data: { reason: typeof config.reason === "string" ? config.reason : undefined },
  };
  if (typeof op === "string") {
    const handler = ACTION_OP_DECOMPILE_MAP[op];
    if (handler) return handler(id, node);
    return {
      node: exitNode,
      edges: edgesForDecompiled(id, node, exitNode),
      warnings: [
        `node ${id}: action op "${String(op)}" is not a known journey op; imported as exit`,
      ],
    };
  }
  return {
    node: exitNode,
    edges: edgesForDecompiled(id, node, exitNode),
    warnings: [`node ${id}: engine action node has no journey op marker; imported as exit`],
  };
}

// ---------------------------------------------------------------------------
// Engine-type reverse map
// ---------------------------------------------------------------------------

export const ENGINE_DECOMPILE_MAP: Record<string, EngineNodeDecompiler> = {
  wait: decompileWait,
  notification: decompileNotification,
  condition: decompileCondition,
  router: decompileRouter,
  event: decompileEvent,
  http: decompileHttp,
  action: decompileAction,
  subworkflow: decompileSubworkflow,
};

export function decompileEngineNode(id: string, node: TaskNode): DecompileParts {
  const handler = ENGINE_DECOMPILE_MAP[node.type];
  if (handler) return handler(id, node);
  const decompiled: DecompiledNode = { id, type: "webhook", data: { url: "", method: "GET" } };
  return {
    node: decompiled,
    edges: edgesForDecompiled(id, node, decompiled),
    warnings: [
      `node ${id}: engine node type "${node.type}" has no journey-graph equivalent; imported as a placeholder webhook node`,
    ],
  };
}
