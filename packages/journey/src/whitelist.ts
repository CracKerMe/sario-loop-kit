import type { JourneyGraph, JourneyNode } from "./types";

const ALLOWED_TYPES: ReadonlySet<JourneyNode["type"]> = new Set([
  "trigger",
  "delay",
  "email",
  "sendCampaign",
  "branch",
  "split",
  "filter",
  "waitEvent",
  "webhook",
  "exit",
  "abSplit",
  "timeWindow",
  "updateContact",
  "score",
  "goal",
  "notify",
  "parallel",
  "join",
  "subJourney",
]);

/**
 * Server-side gate before compile(): the compiler itself only ever
 * produces `action` nodes for a fixed set of hardcoded closures (exit,
 * abSplit, timeWindow) or for runtime handlers injected via
 * CompileOptions.actions (updateContact/score/goal) — never from
 * user-controlled graph content. This check exists so that stays true
 * even if the graph came from a client the server does not fully trust
 * (a builder bug, a hand-crafted API request, a future node type added
 * client-side before the server whitelist is updated). Reject anything
 * outside the known node-type set rather than silently compiling it —
 * the injection surface this guards is the sandbox-evaluated
 * `action`/`sql` node config strings.
 */
export function assertWhitelistedGraph(graph: JourneyGraph): void {
  for (const node of graph.nodes) {
    if (!ALLOWED_TYPES.has(node.type)) {
      throw new Error(
        `journey graph contains a disallowed node type: ${(node as { type: string }).type}`,
      );
    }
  }
}

export const JOURNEY_NODE_TYPES = [...ALLOWED_TYPES] as const;
