import type { TaskNode, WorkflowDefinition } from "ts-workflow-engine-lite";

import type {
  JourneyCompileActions,
  JourneyDelayData,
  JourneyGraph,
  JourneyNode,
  JourneyTimeWindowData,
} from "./types";

export interface CompileResult {
  definition: WorkflowDefinition;
  warnings: string[];
}

export interface CompileOptions {
  workflowId: string;
  name: string;
  version?: string;
  /**
   * Runtime side-effect handlers for updateContact/score/goal. Injected by
   * the server (packages/core) at publish and at boot re-register. Omitted
   * in pure graph tooling — those nodes then no-op with a warning result.
   */
  actions?: JourneyCompileActions;
}

/**
 * Compiles a JourneyGraph (the visual, source-of-truth representation
 * React Flow edits) into an engine WorkflowDefinition. The graph's node
 * ids are used verbatim as engine TaskNode ids — round-tripping (see
 * decompile.ts) depends on that identity holding.
 *
 * Compilation table (journey node type -> engine node type):
 *   trigger       -> not a node; becomes startNode via the first edge out of it
 *   delay         -> wait (config.externalTimer.enabled: true, durable: true)
 *   email         -> notification (channel: "loopkit-email")
 *   sendCampaign  -> notification (channel: "loopkit-email"), using a
 *                    snapshot of the referenced campaign's composition
 *                    taken at publish time (see JourneySendCampaignData)
 *   branch        -> condition (config.trueBranch/falseBranch)
 *   split         -> router (config.routes)
 *   filter        -> condition, false branch may be empty (journey ends)
 *   waitEvent     -> event (node.onEvent), requireInstanceIdMatch is forced
 *                    true by the engine regardless of what we configure
 *   webhook       -> http
 *   exit          -> terminal action, no `next`
 *   abSplit       -> action (deterministic hash bucket) + conditionalNext
 *   timeWindow    -> action (evaluate day/hour window) + conditionalNext
 *   updateContact -> action (injected runtime handler)
 *   score         -> action (injected runtime handler)
 *   goal          -> action (injected runtime handler)
 *   notify        -> http (team webhook / Slack incoming URL)
 *   parallel      -> action (marker) + fan-out `next` (one entry per branch)
 *   join          -> action (arrival gate on state output presence; see
 *                    compileJoinGateAction) + conditionalNext
 *   subJourney    -> subworkflow (fire-and-forget; child context mapped from
 *                    the parent run — see the subJourney case)
 */
export function compile(graph: JourneyGraph, options: CompileOptions): CompileResult {
  const warnings: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const outgoing = new Map<string, { target: string; sourceHandle?: string }[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push({ target: edge.target, sourceHandle: edge.sourceHandle });
    outgoing.set(edge.source, list);
  }

  const triggerNode = graph.nodes.find((n) => n.type === "trigger");
  if (!triggerNode) {
    throw new CompileError("journey graph has no trigger node");
  }
  const triggerOut = outgoing.get(triggerNode.id) ?? [];
  if (triggerOut.length === 0) {
    throw new CompileError("trigger node has no outgoing edge");
  }
  if (triggerOut.length > 1) {
    warnings.push(`trigger node ${triggerNode.id} has multiple outgoing edges; using the first`);
  }
  const startNode = triggerOut[0]!.target;
  if (!byId.has(startNode)) {
    throw new CompileError(`trigger edge targets unknown node ${startNode}`);
  }

  const nodes: Record<string, TaskNode> = {};

  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    const list = incoming.get(edge.target) ?? [];
    if (!list.includes(edge.source)) list.push(edge.source);
    incoming.set(edge.target, list);
  }

  for (const node of graph.nodes) {
    if (node.type === "trigger") continue; // not an engine node
    const edges = outgoing.get(node.id) ?? [];
    for (const edge of edges) {
      if (!byId.has(edge.target)) {
        warnings.push(`node ${node.id} has an edge to unknown node ${edge.target}`);
      }
    }
    const compiled = compileNode(node, edges, incoming.get(node.id) ?? [], warnings, options);
    nodes[node.id] = compiled;
  }

  const definition: WorkflowDefinition = {
    id: options.workflowId,
    name: options.name,
    version: options.version,
    startNode,
    nodes,
  };

  return { definition, warnings };
}

export class CompileError extends Error {}

/**
 * The join gate's action closure. Exported for unit tests.
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

type NonTriggerJourneyNode = Exclude<JourneyNode, { type: "trigger" }>;
type EdgeRef = { target: string; sourceHandle?: string };

const UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

export function delayDataToMs(data: JourneyDelayData): number {
  if (data.mode === "until") return 0; // uses until, not durationMs
  if (data.mode === "weekly") return 0; // paired with timeWindow in the builder
  if (typeof data.value === "number" && data.unit) {
    return Math.max(0, Math.round(data.value * (UNIT_MS[data.unit] ?? 60_000)));
  }
  return Math.max(0, data.ms ?? 0);
}

/** Stable non-crypto hash for deterministic A/B bucketing. */
export function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function isInTimeWindow(data: JourneyTimeWindowData, now = new Date()): boolean {
  const day = now.getDay();
  if (!data.days.includes(day)) return false;
  const hour = now.getHours();
  const start = data.startHour;
  const end = data.endHour;
  if (end > start) return hour >= start && hour < end;
  // Overnight window, e.g. 22–6
  return hour >= start || hour < end;
}

function compileNode(
  node: NonTriggerJourneyNode,
  edges: EdgeRef[],
  incomingSources: string[],
  warnings: string[],
  options: CompileOptions,
): TaskNode {
  const base = { id: node.id };

  switch (node.type) {
    case "delay": {
      const target = requireSingleTarget(node, edges, warnings);
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
      return { ...base, type: "wait", config, next: target ? [target] : [] };
    }

    case "email": {
      const target = requireSingleTarget(node, edges, warnings);
      const d = node.data;
      return {
        ...base,
        type: "notification",
        config: {
          channel: "loopkit-email",
          // Resolved by the engine's {{}} interpolation before the
          // notification channel ever sees it — see @loopkit/email's
          // channel.ts for why the body carries only a template marker,
          // never the HTML itself.
          target: "{{ contact.email }}",
          subject: d.subject,
          template: `template:${d.templateId}`,
          data: {
            workspaceId: "{{ workspaceId }}",
            contactId: "{{ contactId }}",
            journeyId: "{{ journeyId }}",
            journeyRunId: "{{ journeyRunId }}",
            nodeId: node.id,
            templateId: d.templateId,
            preheader: d.preheader,
            fromName: d.fromName,
            replyTo: d.replyTo,
            utm: d.utm,
          },
        },
        next: target ? [target] : [],
      };
    }

    case "sendCampaign": {
      const target = requireSingleTarget(node, edges, warnings);
      const d = node.data;
      if (!d.snapshot) {
        warnings.push(
          `node ${node.id} (sendCampaign): campaign ${d.campaignId} has no resolved snapshot — publish again once the campaign exists`,
        );
        return {
          ...base,
          type: "action",
          action: async () => ({ ok: false }),
          next: target ? [target] : [],
        };
      }
      return {
        ...base,
        type: "notification",
        config: {
          channel: "loopkit-email",
          target: "{{ contact.email }}",
          subject: d.snapshot.subject,
          template: `template:${d.snapshot.templateId}`,
          data: {
            workspaceId: "{{ workspaceId }}",
            contactId: "{{ contactId }}",
            journeyId: "{{ journeyId }}",
            journeyRunId: "{{ journeyRunId }}",
            nodeId: node.id,
            templateId: d.snapshot.templateId,
            preheader: d.snapshot.preheader,
            fromName: d.snapshot.fromName,
            replyTo: d.snapshot.replyTo,
          },
        },
        next: target ? [target] : [],
      };
    }

    case "branch": {
      const trueEdge = edges.find((e) => e.sourceHandle === "true");
      const falseEdge = edges.find((e) => e.sourceHandle === "false");
      if (!trueEdge || !falseEdge) {
        warnings.push(`branch node ${node.id} is missing a true or false edge`);
      }
      return {
        ...base,
        type: "condition",
        config: {
          condition: node.data.expression,
          trueBranch: trueEdge?.target ?? "",
          falseBranch: falseEdge?.target ?? "",
        },
      };
    }

    case "split": {
      const routes = node.data.routes.map((route, index) => {
        const edge = edges.find((e) => e.sourceHandle === route.name);
        if (!edge)
          warnings.push(`split node ${node.id} route "${route.name}" has no outgoing edge`);
        return { condition: route.expression, target: edge?.target ?? "", priority: index };
      });
      const defaultEdge = edges.find((e) => e.sourceHandle === "default");
      return {
        ...base,
        type: "router",
        config: { routes, defaultTarget: defaultEdge?.target },
      };
    }

    case "filter": {
      const trueEdge = edges.find((e) => e.sourceHandle === "true") ?? edges[0];
      const falseEdge = edges.find((e) => e.sourceHandle === "false");
      if (!trueEdge) {
        warnings.push(`filter node ${node.id} has no outgoing edge for a passing contact`);
      }
      if (!falseEdge) {
        warnings.push(
          `filter node ${node.id} has no explicit false edge; a filtered-out contact's instance will simply end`,
        );
      }
      return {
        ...base,
        type: "condition",
        config: {
          condition: node.data.expression,
          trueBranch: trueEdge?.target ?? "",
          falseBranch: falseEdge?.target ?? "",
        },
      };
    }

    case "waitEvent": {
      // Event success path is `next`; engine timeout calls onError and
      // proceeds along failureNext (ExecutionOrchestrator). Builder edges
      // use sourceHandle "event" (or default) vs "timeout".
      const eventEdge =
        edges.find((e) => !e.sourceHandle || e.sourceHandle === "event") ?? edges[0];
      const timeoutEdge = edges.find((e) => e.sourceHandle === "timeout");
      if (!eventEdge) {
        warnings.push(`waitEvent node ${node.id} has no event-success outgoing edge`);
      }
      return {
        ...base,
        type: "event",
        onEvent: `loopkit.event.${node.data.eventName}`,
        timeout: node.data.timeoutMs,
        next: eventEdge ? [eventEdge.target] : [],
        ...(timeoutEdge ? { failureNext: [timeoutEdge.target] } : {}),
        ...(node.data.eventFilter ? { config: { eventFilter: node.data.eventFilter } } : {}),
      };
    }

    case "webhook": {
      const target = requireSingleTarget(node, edges, warnings);
      const d = node.data;
      return {
        ...base,
        type: "http",
        config: {
          method: d.method,
          url: d.url,
          body: d.body,
          headers: d.headers,
          timeoutMs: d.timeoutMs,
        },
        ...(typeof d.maxRetries === "number" ? { maxRetries: d.maxRetries } : {}),
        next: target ? [target] : [],
      };
    }

    case "exit": {
      if (edges.length > 0) {
        warnings.push(`exit node ${node.id} has outgoing edges; they will be ignored`);
      }
      return {
        ...base,
        type: "action",
        action: async () => ({ exited: true, reason: node.data.reason }),
        next: [],
      };
    }

    case "abSplit": {
      const variants = (node.data.variants ?? []).filter((v) => v.name);
      if (variants.length === 0) {
        warnings.push(`abSplit node ${node.id} has no variants`);
      }
      const total = variants.reduce((s, v) => s + Math.max(0, Number(v.weight) || 0), 0) || 1;
      const defaultEdge =
        edges.find((e) => e.sourceHandle === "default") ?? edges.find((e) => !e.sourceHandle);

      return {
        ...base,
        type: "action",
        config: { journeyOp: "abSplit", variants, totalWeight: total },
        // Pure closure — deterministic bucket from contact identity, written
        // into instance.context so conditionalNext can read it on the same
        // node completion (handleRouting evaluates against instance.context).
        action: async (instance) => {
          const ctx = (instance.context ?? {}) as Record<string, unknown>;
          const contact = ctx.contact as { id?: string } | undefined;
          const seed = String(ctx.contactId ?? contact?.id ?? instance.instanceId ?? "");
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
          ctx.__abVariant = chosen;
          return { variant: chosen, bucket };
        },
        conditionalNext: variants.flatMap((v) => {
          const edge = edges.find((e) => e.sourceHandle === v.name);
          if (!edge) {
            warnings.push(`abSplit node ${node.id} variant "${v.name}" has no outgoing edge`);
            return [];
          }
          return [{ condition: `__abVariant == "${v.name}"`, target: edge.target }];
        }),
        defaultNext: defaultEdge?.target,
        next: defaultEdge ? [defaultEdge.target] : [],
      };
    }

    case "timeWindow": {
      const trueEdge = edges.find((e) => e.sourceHandle === "true") ?? edges[0];
      const falseEdge = edges.find((e) => e.sourceHandle === "false");
      if (!trueEdge) {
        warnings.push(`timeWindow node ${node.id} has no "true" edge (in-window path)`);
      }
      if (!falseEdge) {
        warnings.push(
          `timeWindow node ${node.id} has no "false" edge; out-of-window contacts will end`,
        );
      }
      const data = node.data;
      return {
        ...base,
        type: "action",
        config: { journeyOp: "timeWindow", ...data },
        action: async (instance) => {
          const inWindow = isInTimeWindow(data);
          const ctx = instance.context as Record<string, unknown> | undefined;
          if (ctx) ctx.__timeWindowOk = inWindow;
          return { inWindow };
        },
        conditionalNext: [
          { condition: "__timeWindowOk == true", target: trueEdge?.target ?? "" },
          ...(falseEdge
            ? [{ condition: "__timeWindowOk == false", target: falseEdge.target }]
            : []),
        ],
        defaultNext: falseEdge?.target,
        next: falseEdge ? [falseEdge.target] : [],
      };
    }

    case "updateContact": {
      const target = requireSingleTarget(node, edges, warnings);
      const data = node.data;
      return {
        ...base,
        type: "action",
        // journeyOp marks the catalog op; data fields stay intact underneath.
        // Never use bare `op` — score data itself has an `op: add|set` field.
        config: { journeyOp: "updateContact", ...data },
        action: async (instance) => {
          const handler = options.actions?.updateContact;
          if (!handler) return { ok: false, error: "updateContact handler not configured" };
          return handler(data, (instance.context ?? {}) as never);
        },
        next: target ? [target] : [],
      };
    }

    case "score": {
      const target = requireSingleTarget(node, edges, warnings);
      const data = node.data;
      return {
        ...base,
        type: "action",
        config: { journeyOp: "score", ...data },
        action: async (instance) => {
          const handler = options.actions?.score;
          if (!handler) return { ok: false, error: "score handler not configured" };
          return handler(data, (instance.context ?? {}) as never);
        },
        next: target ? [target] : [],
      };
    }

    case "goal": {
      const target = requireSingleTarget(node, edges, warnings);
      const data = node.data;
      return {
        ...base,
        type: "action",
        config: { journeyOp: "goal", ...data },
        action: async (instance) => {
          const handler = options.actions?.goal;
          if (!handler) return { ok: false, error: "goal handler not configured" };
          const ctx = (instance.context ?? {}) as Record<string, unknown>;
          return handler(data, ctx as never, {
            nodeId: node.id,
            journeyId: typeof ctx.journeyId === "string" ? ctx.journeyId : undefined,
            journeyRunId: typeof ctx.journeyRunId === "string" ? ctx.journeyRunId : undefined,
          });
        },
        next: target ? [target] : [],
      };
    }

    case "notify": {
      const target = requireSingleTarget(node, edges, warnings);
      const d = node.data;
      return {
        ...base,
        type: "http",
        config: {
          method: d.method ?? "POST",
          url: d.url,
          headers: {
            "content-type": "application/json",
            ...d.headers,
          },
          body: {
            subject: d.subject ?? "Loopkit journey alert",
            message: d.message,
            contactId: "{{ contactId }}",
            journeyId: "{{ journeyId }}",
            journeyRunId: "{{ journeyRunId }}",
            contactEmail: "{{ contact.email }}",
            ...d.payload,
          },
        },
        next: target ? [target] : [],
      };
    }

    case "parallel": {
      // Fan-out: the engine advances ALL entries of a node's `next` array as
      // one concurrent batch (ExecutionOrchestrator batch loop), so parallel
      // is a marker action whose next carries every outgoing edge. Branches
      // execute in batch order; a branch that PARKS (delay/waitEvent) does
      // not resolve its executeNode promise until it completes, which
      // postpones its batch siblings — wait-free branches converge at the
      // join instantly, parked branches converge when they wake. The
      // journey's `join` node gates convergence across those cases — see
      // compileJoinGateAction.
      if (edges.length < 2) {
        warnings.push(`parallel node ${node.id} has fewer than two outgoing edges`);
      }
      return {
        ...base,
        type: "action",
        config: { journeyOp: "parallel", branches: edges.length },
        action: async () => ({ started: true, branches: edges.length }),
        next: edges.map((e) => e.target),
      };
    }

    case "join": {
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
      const outgoingEdges = edges;
      if (outgoingEdges.length === 0) {
        warnings.push(
          `join node ${node.id} has no outgoing edge; the post-join path is unreachable`,
        );
      }
      if (outgoingEdges.length > 1) {
        warnings.push(`join node ${node.id} has multiple outgoing edges; using the first`);
      }
      const postJoinTarget = outgoingEdges[0]?.target;
      const mode = node.data.mode ?? "all";
      // waitFor = the branch TAIL nodes that feed the join. Every engine
      // node type writes `state.nodes[id].output` on completion (actions,
      // notifications, waits, event wakes), so output presence is the
      // arrival signal.
      const waitFor = incomingSources;
      if (waitFor.length < 2) {
        warnings.push(
          `join node ${node.id} has fewer than two incoming branches; the gate opens on the first arrival`,
        );
      }
      return {
        ...base,
        type: "action",
        config: { journeyOp: "join", mode, waitFor },
        action: compileJoinGateAction(node.id, mode, waitFor),
        // Routing reads the flag the action just wrote (same executeNode,
        // before any await) — see compileJoinGateAction for the flag
        // lifecycle. No `next`: a not-yet-ready arrival simply ends its
        // branch path.
        ...(postJoinTarget
          ? {
              conditionalNext: [
                { condition: `__joinGo_${node.id} == true`, target: postJoinTarget },
              ],
            }
          : {}),
        next: [],
      };
    }

    case "subJourney": {
      // Compiles to the engine's native `subworkflow` node. The child runs
      // as its OWN engine instance (wf_instance.parentInstanceId links back
      // to this run). waitForCompletion stays false — the hook-based wait
      // is an in-memory promise that dies on process restart (the parent
      // would then re-execute this node and spawn a duplicate child), and
      // marketing children live for days. Product semantics: the child
      // sequence advances independently; the parent continues immediately.
      // Email idempotency (`${journeyRunId}:${nodeId}` with the PARENT's
      // runId mapped into the child context) absorbs the tiny crash-window
      // duplicate-child-start for email nodes.
      const target = requireSingleTarget(node, edges, warnings);
      if (!node.data.journeyId) {
        warnings.push(`subJourney node ${node.id} has no journey selected`);
      }
      return {
        ...base,
        type: "subworkflow",
        // The engine workflow id scheme for journeys is `journey-<id>`
        // (core's createJourneyDraft). The child resolves at RUN time via
        // the registry / persisted-definition hydration, so it picks up the
        // child journey's currently active (latest published) version.
        subworkflowId: `journey-${node.data.journeyId}`,
        subworkflowInput: {
          contactId: "contactId",
          workspaceId: "workspaceId",
          contact: "contact",
          // The email channel's idempotency run key — the PARENT's run id
          // keeps child sends unique per parent run + child node id.
          journeyRunId: "journeyRunId",
          // Static per node: child emails/notify attribute to the child journey.
          journeyId: `$literal:${node.data.journeyId}`,
        },
        waitForCompletion: false,
        next: target ? [target] : [],
      };
    }

    default: {
      const _exhaustive: never = node;
      throw new CompileError(`unknown journey node type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function requireSingleTarget(
  node: NonTriggerJourneyNode,
  edges: EdgeRef[],
  warnings: string[],
): string | undefined {
  if (edges.length === 0) {
    warnings.push(`node ${node.id} (${node.type}) has no outgoing edge`);
    return undefined;
  }
  if (edges.length > 1) {
    warnings.push(`node ${node.id} (${node.type}) has multiple outgoing edges; using the first`);
  }
  return edges[0]!.target;
}
