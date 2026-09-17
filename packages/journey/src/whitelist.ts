import type { JourneyGraph, JourneyNode } from "./types";

const ALLOWED_TYPES: ReadonlySet<JourneyNode["type"]> = new Set([
  "trigger",
  "delay",
  "email",
  "branch",
  "split",
  "filter",
  "waitEvent",
  "webhook",
  "exit",
]);

/**
 * Server-side gate before compile(): the compiler itself only ever
 * produces `action`/`sql`/etc. engine nodes for the `exit` node's fixed,
 * hardcoded action closure — never from user-controlled graph content.
 * This check exists so that stays true even if the graph came from a
 * client the server does not fully trust (a builder bug, a hand-crafted
 * API request, a future node type added client-side before the server
 * whitelist is updated). Reject anything outside the known node-type set
 * rather than silently compiling it — the injection surface this guards
 * is the sandbox-evaluated `action`/`sql` node config strings.
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
