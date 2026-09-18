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
    edges.push(...edgesForNode(id, node, decompiled));
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
      const weekly = config.weekly as
        | { dayOfWeek?: number; hour?: number; minute?: number }
        | undefined;
      if (until) {
        return { id, type: "delay", data: { mode: "until", iso: until } };
      }
      if (weekly && typeof weekly.dayOfWeek === "number") {
        return {
          id,
          type: "delay",
          data: {
            mode: "weekly",
            dayOfWeek: weekly.dayOfWeek,
            hour: weekly.hour ?? 9,
            minute: weekly.minute ?? 0,
          },
        };
      }
      return { id, type: "delay", data: { mode: "duration", ms: durationMs ?? node.timeout ?? 0 } };
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
      const data = (config.data ?? {}) as Record<string, unknown>;
      return {
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
    }

    case "condition": {
      const conditionConfig = config as { condition?: string; op?: string };
      if (conditionConfig.op === "timeWindow") {
        return {
          id,
          type: "timeWindow",
          data: {
            days: (config.days as number[]) ?? [1, 2, 3, 4, 5],
            startHour: Number(config.startHour ?? 9),
            endHour: Number(config.endHour ?? 18),
          },
        };
      }
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
      const httpConfig = config as {
        method?: string;
        url?: string;
        body?: unknown;
        headers?: Record<string, string>;
        timeoutMs?: number;
      };
      const body = httpConfig.body as { message?: string; subject?: string } | undefined;
      if (typeof body?.message === "string" && typeof httpConfig.url === "string") {
        return {
          id,
          type: "notify",
          data: {
            url: httpConfig.url,
            subject: body.subject,
            message: body.message,
            headers: httpConfig.headers,
          },
        };
      }
      return {
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

    case "action": {
      const op = config.journeyOp ?? config.op;
      if (op === "updateContact") {
        return {
          id,
          type: "updateContact",
          data: {
            set: config.set as Record<string, unknown> | undefined,
            addTags: config.addTags as string[] | undefined,
            removeTags: config.removeTags as string[] | undefined,
          },
        };
      }
      if (op === "score") {
        return {
          id,
          type: "score",
          data: {
            property: (config.property as string) ?? "score",
            value: Number(config.value ?? 0),
            op: (config.op === "set" ? "set" : "add") as "add" | "set",
          },
        };
      }
      if (op === "goal") {
        return {
          id,
          type: "goal",
          data: {
            name: String(config.name ?? "converted"),
            value: typeof config.value === "number" ? config.value : undefined,
            properties: config.properties as Record<string, unknown> | undefined,
          },
        };
      }
      if (op === "abSplit") {
        const variants = (config.variants as { name: string; weight: number }[]) ?? [];
        return { id, type: "abSplit", data: { variants } };
      }
      if (op === "timeWindow") {
        return {
          id,
          type: "timeWindow",
          data: {
            days: (config.days as number[]) ?? [1, 2, 3, 4, 5],
            startHour: Number(config.startHour ?? 9),
            endHour: Number(config.endHour ?? 18),
          },
        };
      }
      if (op === "parallel") {
        return { id, type: "parallel", data: {} };
      }
      if (op === "join") {
        const mode = config.mode === "any" ? "any" : "all";
        return { id, type: "join", data: { mode } };
      }
      // exit / unknown action
      if (op !== undefined) {
        warnings.push(
          `node ${id}: action op "${String(op)}" is not a known journey op; imported as exit`,
        );
      } else {
        warnings.push(`node ${id}: engine action node has no journey op marker; imported as exit`);
      }
      return {
        id,
        type: "exit",
        data: { reason: typeof config.reason === "string" ? config.reason : undefined },
      };
    }

    case "subworkflow": {
      const subId = typeof node.subworkflowId === "string" ? node.subworkflowId : "";
      const journeyId = subId.startsWith("journey-") ? subId.slice("journey-".length) : "";
      if (!journeyId) {
        warnings.push(
          `node ${id}: subworkflow id "${subId}" is not a journey workflow id; imported as a subJourney node with an empty reference`,
        );
      }
      return { id, type: "subJourney", data: { journeyId } };
    }

    default: {
      warnings.push(
        `node ${id}: engine node type "${node.type}" has no journey-graph equivalent; imported as a placeholder webhook node`,
      );
      return { id, type: "webhook", data: { url: "", method: "GET" } };
    }
  }
}

function edgesForNode(
  id: string,
  node: TaskNode,
  decompiled: { type: string; data?: unknown },
): JourneyEdge[] {
  const out: JourneyEdge[] = [];
  const config = (node.config ?? {}) as Record<string, unknown>;
  const data = (decompiled.data ?? {}) as Record<string, unknown>;

  if (node.type === "condition" || (node.type === "action" && config.op === "timeWindow")) {
    const conditionConfig = (node.config ?? {}) as { trueBranch?: string; falseBranch?: string };
    // action timeWindow uses conditionalNext instead
    if (node.type === "condition") {
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
  }

  if (node.type === "router") {
    const routerConfig = (node.config ?? {}) as {
      routes?: { target: string }[];
      defaultTarget?: string;
    };
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

  if (node.type === "event") {
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

  // action nodes with conditionalNext (abSplit / timeWindow / join)
  if (node.conditionalNext?.length) {
    if (decompiled.type === "join") {
      // The gate's single conditional entry IS the post-join edge — no handle.
      return node.conditionalNext.map((branch) => ({
        id: `${id}-${branch.target}`,
        source: id,
        target: branch.target,
      }));
    }
    for (const branch of node.conditionalNext) {
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

  for (const target of node.next ?? []) {
    out.push({ id: `${id}-${target}`, source: id, target });
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
