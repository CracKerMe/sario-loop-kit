/**
 * The visual journey graph — what React Flow edits and what journey_version.graph
 * stores. This is the source of truth; compile() derives an engine
 * WorkflowDefinition from it, cached in journey_version.compiled.
 */

export type JourneyTrigger =
  | { kind: "contact_created"; filter?: SegmentFilter }
  | { kind: "event"; name: string; filter?: SegmentFilter }
  | { kind: "property_changed"; property: string; from?: unknown; to?: unknown }
  | { kind: "manual" };

/** Segment filter AST — evaluated to SQL by @loopkit/core, not interpreted here. */
export type SegmentFilter =
  | { op: "and" | "or"; filters: SegmentFilter[] }
  | {
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
      property: string;
      value: unknown;
    }
  | { op: "exists" | "not_exists"; property: string };

export interface JourneyNodeBase {
  id: string;
  position: { x: number; y: number };
}

export type JourneyNode =
  | (JourneyNodeBase & { type: "trigger"; data: { trigger: JourneyTrigger } })
  | (JourneyNodeBase & { type: "delay"; data: JourneyDelayData })
  | (JourneyNodeBase & { type: "email"; data: JourneyEmailData })
  | (JourneyNodeBase & { type: "branch"; data: { expression: string } })
  | (JourneyNodeBase & { type: "split"; data: { routes: JourneySplitRoute[] } })
  | (JourneyNodeBase & { type: "filter"; data: { expression: string } })
  | (JourneyNodeBase & { type: "waitEvent"; data: JourneyWaitEventData })
  | (JourneyNodeBase & { type: "webhook"; data: JourneyWebhookData })
  | (JourneyNodeBase & { type: "exit"; data: { reason?: string } });

export type JourneyDelayData = { mode: "duration"; ms: number } | { mode: "until"; iso: string };

export interface JourneyEmailData {
  templateId: string;
  subject?: string;
}

export interface JourneySplitRoute {
  name: string;
  expression: string;
}

export interface JourneyWaitEventData {
  eventName: string;
  timeoutMs?: number;
}

export interface JourneyWebhookData {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
}

export interface JourneyEdge {
  id: string;
  source: string;
  target: string;
  /** Which outgoing branch this edge represents, for nodes with more than
   *  one exit (branch: "true"|"false"; split: a route name). */
  sourceHandle?: string;
}

export interface JourneyGraph {
  nodes: JourneyNode[];
  edges: JourneyEdge[];
}
