import type { JourneyEdgeDto, JourneyGraphDto, JourneyNodeDto } from "@/lib/api";
import { welcomeAbScoreHoursGraph as welcomeAbScoreHoursPreset } from "@loopkit/journey/presets";
import type { JourneyEdge, JourneyGraph, JourneyNode } from "@loopkit/journey/types";
import type { Edge, Node } from "@xyflow/react";

export type BuilderNodeType = JourneyNode["type"];

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
      return { mode: "duration", ms: 5 * 60_000, value: 5, unit: "minutes" };
    case "email":
      return { templateId: "", subject: "", preheader: "", fromName: "", replyTo: "" };
    case "notify":
      return {
        url: "",
        subject: "Journey alert",
        message: "Contact {{ contact.email }} reached a journey step",
        method: "POST",
      };
    case "branch":
      return { expression: '{{ contact.plan }} == "pro"' };
    case "split":
      return {
        routes: [
          { name: "vip", expression: "{{ contact.vip }} == true" },
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
      return { expression: "{{ contact.subscribed }} == true" };
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
        id: "score_onboarding",
        type: "score",
        position: { x: 280, y: 280 },
        data: { property: "score", value: 5, op: "add" },
      },
      {
        id: "delay_5m",
        type: "delay",
        position: { x: 280, y: 400 },
        data: { mode: "duration", ms: 5 * 60_000, value: 5, unit: "minutes" },
      },
      {
        id: "email_followup",
        type: "email",
        position: { x: 280, y: 520 },
        data: { templateId: "", subject: "Getting started tips" },
      },
      { id: "exit", type: "exit", position: { x: 280, y: 640 }, data: { reason: "completed" } },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "email_welcome" },
      { id: "e2", source: "email_welcome", target: "score_onboarding" },
      { id: "e3", source: "score_onboarding", target: "delay_5m" },
      { id: "e4", source: "delay_5m", target: "email_followup" },
      { id: "e5", source: "email_followup", target: "exit" },
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

export type JourneyTemplateId = "blank-welcome" | "marketing-ab-score-hours";

export interface JourneyTemplate {
  id: JourneyTemplateId;
  name: string;
  description: string;
  build: () => JourneyGraphDto;
}

export const JOURNEY_TEMPLATES: JourneyTemplate[] = [
  {
    id: "blank-welcome",
    name: "Simple welcome drip",
    description: "Welcome email → score → short delay → follow-up",
    build: emptyWelcomeGraph,
  },
  {
    id: "marketing-ab-score-hours",
    name: "Welcome + A/B + Score + Hours",
    description: "Full marketing sample: experiment split, lead score, business-hours gate, goal",
    build: welcomeAbScoreHoursGraph,
  },
];

export function journeyTemplateById(id: JourneyTemplateId): JourneyTemplate {
  return JOURNEY_TEMPLATES.find((t) => t.id === id) ?? JOURNEY_TEMPLATES[0]!;
}
