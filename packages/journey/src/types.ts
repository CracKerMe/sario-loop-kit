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

export type JourneyDelayUnit = "minutes" | "hours" | "days" | "weeks";

export type JourneyDelayData =
  | {
      mode: "duration";
      /** Canonical milliseconds; kept for backward compatibility with existing graphs. */
      ms: number;
      /** Optional pretty fields the inspector edits; compile uses ms when present. */
      value?: number;
      unit?: JourneyDelayUnit;
    }
  | { mode: "until"; iso: string }
  | {
      /** Calendar gate helper metadata — pair with a timeWindow node, or use for documentation. */
      mode: "weekly";
      /** 0 = Sunday … 6 = Saturday */
      dayOfWeek: number;
      hour: number;
      minute?: number;
    };

export interface JourneyEmailData {
  templateId: string;
  subject?: string;
  preheader?: string;
  fromName?: string;
  replyTo?: string;
  /** UTM / analytics params appended at send time by the email channel when provided. */
  utm?: { source?: string; medium?: string; campaign?: string };
}

export interface JourneySplitRoute {
  name: string;
  expression: string;
}

export interface JourneyWaitEventData {
  eventName: string;
  timeoutMs?: number;
  /** Optional property match on the waking event, compiled into a follow-up condition filter when set. */
  eventFilter?: { property: string; op: "eq" | "neq" | "contains"; value: unknown };
}

export type JourneyWebhookMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface JourneyWebhookData {
  url: string;
  method: JourneyWebhookMethod;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface JourneyAbVariant {
  name: string;
  /** Relative weight (not required to sum to 100). */
  weight: number;
}

export interface JourneyAbSplitData {
  variants: JourneyAbVariant[];
}

export interface JourneyTimeWindowData {
  /** Days the window is open. 0 = Sunday … 6 = Saturday */
  days: number[];
  /** Inclusive start hour, 0–23 (local server time). */
  startHour: number;
  /** Exclusive end hour, 0–24. */
  endHour: number;
  /** Optional label shown on the node. */
  label?: string;
}

export interface JourneyUpdateContactData {
  /** Property key → value. String values matching `{{ path }}` resolve from run context. */
  set?: Record<string, unknown>;
  addTags?: string[];
  removeTags?: string[];
}

export interface JourneyScoreData {
  /** Contact property that holds the score. Default: "score". */
  property?: string;
  /** Delta to apply (add) or absolute value (set). */
  value: number;
  op?: "add" | "set";
}

export interface JourneyGoalData {
  name: string;
  value?: number;
  properties?: Record<string, unknown>;
}

export interface JourneySendCampaignData {
  /** The campaign whose email composition this node sends. */
  campaignId: string;
  /**
   * Snapshot of the campaign's template/subject/etc., taken from the
   * campaign row the moment this journey was last published — compile()
   * bakes this into the engine definition the same way an `email` node
   * bakes in its own inline data, so re-registering the SAME published
   * version at boot never needs a fresh DB lookup. Editing the campaign
   * afterward does not retroactively change an already-published journey;
   * republishing re-snapshots it. Empty until the first publish (the
   * builder only has `campaignId` before then).
   */
  snapshot?: {
    templateId: string;
    subject?: string;
    preheader?: string;
    fromName?: string;
    replyTo?: string;
  };
}

export interface JourneyNotifyData {
  /** HTTP endpoint (Slack/Discord/飞书 incoming webhook, Zapier, internal API…). */
  url: string;
  subject?: string;
  message: string;
  method?: JourneyWebhookMethod;
  headers?: Record<string, string>;
  /** Extra JSON fields merged into the POST body. */
  payload?: Record<string, unknown>;
}

/** No per-node config — branches are simply the node's outgoing edges. */
export interface JourneyParallelData {
  label?: string;
}

export interface JourneyJoinData {
  /**
   * "all" (default): continue once every branch feeding the join has
   * completed. "any": continue as soon as the first branch arrives; later
   * arrivals are consumed and skipped (the post-join path never re-runs).
   */
  mode?: "all" | "any";
}

export interface JourneySubJourneyData {
  /** The referenced (child) journey. Must be published at parent publish time. */
  journeyId: string;
}

export type JourneyNode =
  | (JourneyNodeBase & { type: "trigger"; data: { trigger: JourneyTrigger } })
  | (JourneyNodeBase & { type: "delay"; data: JourneyDelayData })
  | (JourneyNodeBase & { type: "email"; data: JourneyEmailData })
  | (JourneyNodeBase & { type: "sendCampaign"; data: JourneySendCampaignData })
  | (JourneyNodeBase & { type: "branch"; data: { expression: string } })
  | (JourneyNodeBase & { type: "split"; data: { routes: JourneySplitRoute[] } })
  | (JourneyNodeBase & { type: "filter"; data: { expression: string } })
  | (JourneyNodeBase & { type: "waitEvent"; data: JourneyWaitEventData })
  | (JourneyNodeBase & { type: "webhook"; data: JourneyWebhookData })
  | (JourneyNodeBase & { type: "exit"; data: { reason?: string } })
  | (JourneyNodeBase & { type: "abSplit"; data: JourneyAbSplitData })
  | (JourneyNodeBase & { type: "timeWindow"; data: JourneyTimeWindowData })
  | (JourneyNodeBase & { type: "updateContact"; data: JourneyUpdateContactData })
  | (JourneyNodeBase & { type: "score"; data: JourneyScoreData })
  | (JourneyNodeBase & { type: "goal"; data: JourneyGoalData })
  | (JourneyNodeBase & { type: "notify"; data: JourneyNotifyData })
  | (JourneyNodeBase & { type: "parallel"; data: JourneyParallelData })
  | (JourneyNodeBase & { type: "join"; data: JourneyJoinData })
  | (JourneyNodeBase & { type: "subJourney"; data: JourneySubJourneyData });

export type JourneyNodeNonTrigger = Exclude<JourneyNode, { type: "trigger" }>;

export interface JourneyEdge {
  id: string;
  source: string;
  target: string;
  /** Which outgoing branch this edge represents, for nodes with more than
   *  one exit (branch/filter/timeWindow: "true"|"false"; split: a route name;
   *  abSplit: a variant name). */
  sourceHandle?: string;
}

export interface JourneyGraph {
  nodes: JourneyNode[];
  edges: JourneyEdge[];
}

/** Context shape available to compile-time action closures at run time. */
export interface JourneyRuntimeContext extends Record<string, unknown> {
  contactId?: string;
  workspaceId?: string;
  journeyId?: string;
  journeyRunId?: string;
  contact?: { id?: string; email?: string; [key: string]: unknown };
}

/**
 * Side-effect handlers injected by the server into compile(). The browser
 * bundle only calls validateGraph(), never compile(), so these stay out of
 * client code. Journey package itself does not import the DB.
 */
export interface JourneyCompileActions {
  updateContact: (data: JourneyUpdateContactData, ctx: JourneyRuntimeContext) => Promise<unknown>;
  score: (data: JourneyScoreData, ctx: JourneyRuntimeContext) => Promise<unknown>;
  goal: (
    data: JourneyGoalData,
    ctx: JourneyRuntimeContext,
    meta: { nodeId: string; journeyId?: string; journeyRunId?: string },
  ) => Promise<unknown>;
}
