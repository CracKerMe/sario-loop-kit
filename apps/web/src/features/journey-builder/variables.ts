import { MERGE_TAG_SUGGESTIONS } from "@loopkit/email-doc";
import type { Edge, Node } from "@xyflow/react";

/**
 * Variable paths always available in `{{ }}` interpolation, regardless of the
 * selected node's position in the graph — mirrors the run context the engine
 * injects for every node (see packages/journey/src/types.ts JourneyRuntimeContext).
 */
const GLOBAL_VARIABLES: readonly string[] = [
  ...MERGE_TAG_SUGGESTIONS,
  "workspaceId",
  "contactId",
  "journeyId",
  "journeyRunId",
];

export type JourneyVariable = {
  path: string;
  /** Where this variable comes from, for grouping in the picker. */
  group: "Contact" | "Journey" | "Event";
};

/**
 * Variables available at a given node = globals + any event payload fields
 * exposed by trigger/waitEvent nodes upstream of it in the graph, plus any
 * real contact property keys observed in this workspace (`contactPropertyKeys`
 * — optional, since it comes from an API call the caller may not have made
 * yet). Only an `event`-kind trigger or a `waitEvent` node introduces
 * `event.*` fields — everything else in the graph just passes the run
 * context through.
 */
export function variablesForNode(
  nodeId: string | undefined,
  nodes: Node[],
  edges: Edge[],
  contactPropertyKeys: readonly string[] = [],
): JourneyVariable[] {
  const suggestedPaths = new Set(GLOBAL_VARIABLES);
  const contactVars: JourneyVariable[] = contactPropertyKeys
    .filter((key) => !suggestedPaths.has(`contact.${key}`))
    .map((key) => ({ path: `contact.${key}`, group: "Contact" as const }));

  const globals: JourneyVariable[] = [
    ...GLOBAL_VARIABLES.map((path) => ({
      path,
      group: (path.startsWith("contact.") || path === "contactId" ? "Contact" : "Journey") as
        | "Contact"
        | "Journey",
    })),
    ...contactVars,
  ];

  if (!nodeId) return globals;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    const list = incoming.get(e.target) ?? [];
    list.push(e.source);
    incoming.set(e.target, list);
  }

  const seen = new Set<string>();
  const queue = [...(incoming.get(nodeId) ?? [])];
  const eventVars: JourneyVariable[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) {
      if (node.type === "trigger") {
        const trigger = (node.data as { trigger?: { kind?: string } }).trigger;
        if (trigger?.kind === "event") {
          eventVars.push({ path: "event.name", group: "Event" });
          eventVars.push({ path: "event.properties", group: "Event" });
        }
      }
      if (node.type === "waitEvent") {
        eventVars.push({ path: "event.name", group: "Event" });
        eventVars.push({ path: "event.properties", group: "Event" });
      }
    }
    queue.push(...(incoming.get(id) ?? []));
  }

  const dedupedEventVars = eventVars.filter(
    (v, i) => eventVars.findIndex((o) => o.path === v.path) === i,
  );

  return [...globals, ...dedupedEventVars];
}

export function wrapVariable(path: string): string {
  return `{{ ${path} }}`;
}

/**
 * A contact's own custom properties (firstName, plan, ...) aren't just
 * reachable via `contact.<key>` — the email/notify channels spread them onto
 * the top level of the render context too (see packages/email/src/channel.ts
 * renderData), so `{{ plan }}` and `{{ contact.plan }}` both resolve to the
 * same value. `MERGE_TAG_SUGGESTIONS` only lists the nested form; this note
 * exists so the picker/panel can tell users the flat alias exists even
 * though it can't enumerate every possible property key.
 */
export const CONTACT_PROPERTY_FLAT_ALIAS_NOTE =
  'Contact properties are also available without the "contact." prefix (e.g. {{ plan }} works the same as {{ contact.plan }}).';
