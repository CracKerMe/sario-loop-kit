import type { JourneyEdgeDto, JourneyGraphDto, JourneyNodeDto } from "@/lib/api";
import {
  standardWelcomeSequenceGraph as standardWelcomeSequencePreset,
  welcomeAbScoreHoursGraph as welcomeAbScoreHoursPreset,
} from "@loopkit/journey/presets";
import type { JourneyEdge, JourneyGraph, JourneyNode } from "@loopkit/journey/types";
import type { Edge, Node } from "@xyflow/react";

export type BuilderNodeType = JourneyNode["type"];

/** Loops-style core palette. Everything else stays available under Advanced. */
export type NodeTier = "core" | "advanced";

export const CORE_NODE_TYPES = [
  "trigger",
  "email",
  "delay",
  "filter",
  "branch",
  "abSplit",
] as const satisfies readonly BuilderNodeType[];

export function nodeTier(type: BuilderNodeType): NodeTier {
  return (CORE_NODE_TYPES as readonly string[]).includes(type) ? "core" : "advanced";
}

/** Palette listing: core always; advanced only when open or when searching. */
export function paletteNodeTypes(options: {
  query?: string;
  showAdvanced?: boolean;
  hasTrigger?: boolean;
}): BuilderNodeType[] {
  const q = (options.query ?? "").trim().toLowerCase();
  return (Object.keys(NODE_META) as BuilderNodeType[]).filter((type) => {
    if (type === "trigger" && options.hasTrigger) return false;
    const tier = nodeTier(type);
    if (!q && tier === "advanced" && !options.showAdvanced) return false;
    if (!q) return true;
    const meta = NODE_META[type];
    return (
      meta.label.toLowerCase().includes(q) ||
      type.toLowerCase().includes(q) ||
      meta.description.toLowerCase().includes(q)
    );
  });
}

export const NODE_META: Record<
  BuilderNodeType,
  {
    label: string;
    color: string;
    description: string;
    handles: "single" | "branch" | "split" | "none" | "abSplit";
    category: "trigger" | "flow" | "channel" | "logic" | "data";
  }
> = {
  trigger: {
    label: "Trigger",
    color: "#38bdf8",
    description: "Journey entry point",
    handles: "single",
    category: "trigger",
  },
  delay: {
    label: "Delay",
    color: "#a78bfa",
    description: "Wait duration or until a date",
    handles: "single",
    category: "flow",
  },
  email: {
    label: "Email",
    color: "#34d399",
    description: "Send a templated email",
    handles: "single",
    category: "channel",
  },
  sendCampaign: {
    label: "Send Campaign",
    color: "#22d3ee",
    description: "Send an existing campaign's email",
    handles: "single",
    category: "channel",
  },
  notify: {
    label: "Notify",
    color: "#2dd4bf",
    description: "Ping team via webhook",
    handles: "single",
    category: "channel",
  },
  branch: {
    label: "Branch",
    color: "#fbbf24",
    description: "True / false split",
    handles: "branch",
    category: "logic",
  },
  split: {
    label: "Split",
    color: "#fb923c",
    description: "Multi-route router",
    handles: "split",
    category: "logic",
  },
  abSplit: {
    label: "A/B Split",
    color: "#e879f9",
    description: "Weighted experiment buckets",
    handles: "abSplit",
    category: "logic",
  },
  filter: {
    label: "Filter",
    color: "#f472b6",
    description: "Continue only if matches",
    handles: "branch",
    category: "logic",
  },
  timeWindow: {
    label: "Time Window",
    color: "#67e8f9",
    description: "Only continue on days/hours",
    handles: "branch",
    category: "logic",
  },
  waitEvent: {
    label: "Wait Event",
    color: "#60a5fa",
    description: "Wait for a contact event",
    handles: "single",
    category: "flow",
  },
  webhook: {
    label: "Webhook",
    color: "#94a3b8",
    description: "HTTP callout",
    handles: "single",
    category: "channel",
  },
  updateContact: {
    label: "Update Contact",
    color: "#4ade80",
    description: "Set properties / tags",
    handles: "single",
    category: "data",
  },
  score: {
    label: "Lead Score",
    color: "#c084fc",
    description: "Add or set a score property",
    handles: "single",
    category: "data",
  },
  goal: {
    label: "Goal",
    color: "#facc15",
    description: "Record a conversion event",
    handles: "single",
    category: "data",
  },
  exit: {
    label: "Exit",
    color: "#f87171",
    description: "End journey for contact",
    handles: "none",
    category: "flow",
  },
  parallel: {
    label: "Parallel",
    color: "#6366f1",
    description: "Fan out into concurrent branches",
    handles: "single",
    category: "logic",
  },
  join: {
    label: "Join",
    color: "#84cc16",
    description: "Wait for parallel branches to converge",
    handles: "single",
    category: "logic",
  },
  subJourney: {
    label: "Sub-Journey",
    color: "#7c3aed",
    description: "Run another published journey",
    handles: "single",
    category: "flow",
  },
};

export const NODE_CATEGORY_LABELS: Record<string, string> = {
  trigger: "Trigger",
  channel: "Channels",
  flow: "Timing",
  logic: "Logic",
  data: "Audience data",
};

export function defaultNodeData(type: BuilderNodeType): Record<string, unknown> {
  switch (type) {
    case "trigger":
      return { trigger: { kind: "contact_created" } };
    case "delay":
      return { mode: "duration", ms: 86_400_000, value: 1, unit: "days" };
    case "email":
      return { templateId: "", subject: "", preheader: "", fromName: "", replyTo: "" };
    case "sendCampaign":
      return { campaignId: "" };
    case "notify":
      return {
        url: "",
        subject: "Journey alert",
        message: "Contact {{ contact.email }} reached a journey step",
        method: "POST",
      };
    case "branch":
      return { expression: 'contact.plan == "pro"' };
    case "split":
      return {
        routes: [
          { name: "vip", expression: "contact.vip == true" },
          { name: "other", expression: "true" },
        ],
      };
    case "abSplit":
      return {
        variants: [
          { name: "A", weight: 50 },
          { name: "B", weight: 50 },
        ],
      };
    case "filter":
      return { expression: "contact.subscribed == true" };
    case "timeWindow":
      return { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18, label: "Business hours" };
    case "waitEvent":
      return { eventName: "order.placed", timeoutMs: 3 * 24 * 60 * 60 * 1000 };
    case "webhook":
      return {
        url: "https://example.com/hook",
        method: "POST",
        body: {},
        headers: {},
        timeoutMs: 10000,
        maxRetries: 2,
      };
    case "updateContact":
      return { set: { lifecycle: "engaged" }, addTags: [], removeTags: [] };
    case "score":
      return { property: "score", value: 10, op: "add" };
    case "goal":
      return { name: "activated", value: 1 };
    case "exit":
      return { reason: "completed" };
    case "parallel":
      return { label: "" };
    case "join":
      return { mode: "all" };
    case "subJourney":
      return { journeyId: "" };
  }
}

export function graphToFlow(graph: JourneyGraphDto | JourneyGraph): {
  nodes: Node[];
  edges: Edge[];
} {
  const nodes: Node[] = graph.nodes.map((n: JourneyNodeDto | JourneyNode) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: { ...n.data },
  }));
  const edges: Edge[] = graph.edges.map((e: JourneyEdgeDto | JourneyEdge) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    type: "insert",
  }));
  return { nodes, edges };
}

export function flowToGraph(nodes: Node[], edges: Edge[]): JourneyGraphDto {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: (n.type ?? "exit") as string,
      position: n.position,
      data: (n.data ?? {}) as Record<string, unknown>,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
    })),
  };
}

/** Default seed: Loops-style welcome drip — trigger → email → delay → email → exit. */
export function emptyWelcomeGraph(): JourneyGraphDto {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 280, y: 40 },
        data: { trigger: { kind: "contact_created" } },
      },
      {
        id: "email_welcome",
        type: "email",
        position: { x: 280, y: 160 },
        data: { templateId: "", subject: "Welcome aboard", preheader: "" },
      },
      {
        id: "delay_1d",
        type: "delay",
        position: { x: 280, y: 280 },
        data: { mode: "duration", ms: 86_400_000, value: 1, unit: "days" },
      },
      {
        id: "email_followup",
        type: "email",
        position: { x: 280, y: 400 },
        data: { templateId: "", subject: "Getting started tips" },
      },
      { id: "exit", type: "exit", position: { x: 280, y: 520 }, data: { reason: "completed" } },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "email_welcome" },
      { id: "e2", source: "email_welcome", target: "delay_1d" },
      { id: "e3", source: "delay_1d", target: "email_followup" },
      { id: "e4", source: "email_followup", target: "exit" },
    ],
  };
}

/** Simple onboarding: branch paid vs free after a day. */
export function onboardingBranchGraph(): JourneyGraphDto {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 360, y: 40 },
        data: { trigger: { kind: "contact_created" } },
      },
      {
        id: "email_welcome",
        type: "email",
        position: { x: 360, y: 160 },
        data: { templateId: "", subject: "Welcome — let's get you set up" },
      },
      {
        id: "delay_1d",
        type: "delay",
        position: { x: 360, y: 280 },
        data: { mode: "duration", ms: 86_400_000, value: 1, unit: "days" },
      },
      {
        id: "branch_paid",
        type: "branch",
        position: { x: 360, y: 400 },
        data: { expression: 'contact.plan == "paid"' },
      },
      {
        id: "email_paid",
        type: "email",
        position: { x: 160, y: 540 },
        data: { templateId: "", subject: "You're in — next steps on the paid plan" },
      },
      {
        id: "email_free",
        type: "email",
        position: { x: 560, y: 540 },
        data: { templateId: "", subject: "Make the most of your free account" },
      },
      {
        id: "exit",
        type: "exit",
        position: { x: 360, y: 680 },
        data: { reason: "onboarding-done" },
      },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "email_welcome" },
      { id: "e2", source: "email_welcome", target: "delay_1d" },
      { id: "e3", source: "delay_1d", target: "branch_paid" },
      { id: "e4", source: "branch_paid", target: "email_paid", sourceHandle: "true" },
      { id: "e5", source: "branch_paid", target: "email_free", sourceHandle: "false" },
      { id: "e6", source: "email_paid", target: "exit" },
      { id: "e7", source: "email_free", target: "exit" },
    ],
  };
}

/** Simple winback: inactive event → nudge → last chance if still inactive. */
export function winbackGraph(): JourneyGraphDto {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 280, y: 40 },
        data: { trigger: { kind: "event", name: "inactive" } },
      },
      {
        id: "email_nudge",
        type: "email",
        position: { x: 280, y: 160 },
        data: { templateId: "", subject: "We miss you — here's what's new" },
      },
      {
        id: "delay_3d",
        type: "delay",
        position: { x: 280, y: 280 },
        data: { mode: "duration", ms: 3 * 86_400_000, value: 3, unit: "days" },
      },
      {
        id: "filter_active",
        type: "filter",
        position: { x: 280, y: 400 },
        data: { expression: "contact.active == true" },
      },
      {
        id: "email_last",
        type: "email",
        position: { x: 280, y: 540 },
        data: { templateId: "", subject: "Last chance — still interested?" },
      },
      { id: "exit", type: "exit", position: { x: 280, y: 660 }, data: { reason: "winback-done" } },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "email_nudge" },
      { id: "e2", source: "email_nudge", target: "delay_3d" },
      { id: "e3", source: "delay_3d", target: "filter_active" },
      // false = still inactive → last chance; true = recovered → exit
      { id: "e4", source: "filter_active", target: "email_last", sourceHandle: "false" },
      { id: "e5", source: "filter_active", target: "exit", sourceHandle: "true" },
      { id: "e6", source: "email_last", target: "exit" },
    ],
  };
}

/**
 * Marketing sample: welcome drip + A/B experiment + lead score + business-hours gate.
 * Canonical definition lives in @loopkit/journey presets (validated + compile-tested).
 */
export function welcomeAbScoreHoursGraph(): JourneyGraphDto {
  return welcomeAbScoreHoursPreset() as unknown as JourneyGraphDto;
}

/** The reusable "standard welcome sequence" child journey (see presets). */
export function standardWelcomeSequenceGraph(): JourneyGraphDto {
  return standardWelcomeSequencePreset() as unknown as JourneyGraphDto;
}

export type JourneyTemplateId =
  | "blank-welcome"
  | "onboarding-branch"
  | "winback"
  | "marketing-ab-score-hours"
  | "standard-welcome-sequence";

export interface JourneyTemplate {
  id: JourneyTemplateId;
  name: string;
  description: string;
  /** "simple" is always visible; "example" hides under More examples. */
  tier: "simple" | "example";
  build: () => JourneyGraphDto;
}

export const JOURNEY_TEMPLATES: JourneyTemplate[] = [
  {
    id: "blank-welcome",
    name: "Welcome drip",
    description: "Welcome → 1 day → follow-up",
    tier: "simple",
    build: emptyWelcomeGraph,
  },
  {
    id: "onboarding-branch",
    name: "Onboarding branch",
    description: "Welcome, then split paid vs free after a day",
    tier: "simple",
    build: onboardingBranchGraph,
  },
  {
    id: "winback",
    name: "Winback",
    description: "Inactive contact nudge, then a last chance",
    tier: "simple",
    build: winbackGraph,
  },
  {
    id: "marketing-ab-score-hours",
    name: "Welcome + A/B + Score + Hours",
    description: "Experiment split, lead score, business-hours gate, goal",
    tier: "example",
    build: welcomeAbScoreHoursGraph,
  },
  {
    id: "standard-welcome-sequence",
    name: "Standard welcome sequence",
    description: "Reusable child journey for subJourney nodes",
    tier: "example",
    build: standardWelcomeSequenceGraph,
  },
];

export function journeyTemplateById(id: JourneyTemplateId): JourneyTemplate {
  return JOURNEY_TEMPLATES.find((t) => t.id === id) ?? JOURNEY_TEMPLATES[0]!;
}
