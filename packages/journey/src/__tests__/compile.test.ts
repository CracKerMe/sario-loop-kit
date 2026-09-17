import { describe, expect, it } from "vitest";

import { compile, CompileError } from "../compile";
import type { JourneyGraph } from "../types";

const welcomeDripGraph: JourneyGraph = {
  nodes: [
    {
      id: "trig",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { trigger: { kind: "contact_created" } },
    },
    {
      id: "welcome",
      type: "email",
      position: { x: 0, y: 1 },
      data: { templateId: "tpl-welcome", subject: "Welcome!" },
    },
    {
      id: "wait",
      type: "delay",
      position: { x: 0, y: 2 },
      data: { mode: "duration", ms: 300_000 },
    },
    {
      id: "followup",
      type: "email",
      position: { x: 0, y: 3 },
      data: { templateId: "tpl-followup" },
    },
    { id: "end", type: "exit", position: { x: 0, y: 4 }, data: {} },
  ],
  edges: [
    { id: "e1", source: "trig", target: "welcome" },
    { id: "e2", source: "welcome", target: "wait" },
    { id: "e3", source: "wait", target: "followup" },
    { id: "e4", source: "followup", target: "end" },
  ],
};

describe("compile: linear trigger -> email -> delay -> email -> exit", () => {
  it("sets startNode to the trigger's outgoing target, not the trigger itself", () => {
    const { definition } = compile(welcomeDripGraph, { workflowId: "wf-1", name: "welcome drip" });
    expect(definition.startNode).toBe("welcome");
    expect(definition.nodes.trig).toBeUndefined(); // trigger is not an engine node
  });

  it("compiles email nodes to notification nodes with the loopkit-email channel", () => {
    const { definition } = compile(welcomeDripGraph, { workflowId: "wf-1", name: "welcome drip" });
    const node = definition.nodes.welcome!;
    expect(node.type).toBe("notification");
    expect(node.config?.channel).toBe("loopkit-email");
    expect(node.config?.template).toBe("template:tpl-welcome");
    expect(node.next).toEqual(["wait"]);
  });

  it("compiles delay nodes to wait nodes with externalTimer enabled and durable", () => {
    const { definition } = compile(welcomeDripGraph, { workflowId: "wf-1", name: "welcome drip" });
    const node = definition.nodes.wait!;
    expect(node.type).toBe("wait");
    expect(node.config).toMatchObject({
      durationMs: 300_000,
      externalTimer: { enabled: true },
      durable: true,
    });
    expect(node.next).toEqual(["followup"]);
  });

  it("compiles a delay with an absolute deadline via until", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        {
          id: "d",
          type: "delay",
          position: { x: 0, y: 1 },
          data: { mode: "until", iso: "2027-01-01T00:00:00.000Z" },
        },
        { id: "e", type: "exit", position: { x: 0, y: 2 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "t", target: "d" },
        { id: "e2", source: "d", target: "e" },
      ],
    };
    const { definition } = compile(graph, { workflowId: "wf-2", name: "x" });
    expect(definition.nodes.d!.config).toMatchObject({
      until: "2027-01-01T00:00:00.000Z",
      externalTimer: { enabled: true },
    });
  });

  it("compiles exit nodes with no outgoing next", () => {
    const { definition } = compile(welcomeDripGraph, { workflowId: "wf-1", name: "welcome drip" });
    expect(definition.nodes.end!.next).toEqual([]);
  });

  it("round-trips through the engine's WorkflowDefinition shape (all referenced next/config targets exist)", () => {
    const { definition } = compile(welcomeDripGraph, { workflowId: "wf-1", name: "welcome drip" });
    for (const node of Object.values(definition.nodes)) {
      for (const target of node.next ?? []) {
        expect(
          definition.nodes[target] ?? (target === definition.startNode ? true : undefined),
        ).toBeTruthy();
      }
    }
  });
});

describe("compile: branch node", () => {
  it("maps true/false edges to config.trueBranch/falseBranch", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        {
          id: "b",
          type: "branch",
          position: { x: 0, y: 1 },
          data: { expression: "context.plan == 'pro'" },
        },
        { id: "yes", type: "exit", position: { x: 0, y: 2 }, data: {} },
        { id: "no", type: "exit", position: { x: 0, y: 2 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "t", target: "b" },
        { id: "e2", source: "b", target: "yes", sourceHandle: "true" },
        { id: "e3", source: "b", target: "no", sourceHandle: "false" },
      ],
    };
    const { definition, warnings } = compile(graph, { workflowId: "wf-3", name: "x" });
    expect(definition.nodes.b!.type).toBe("condition");
    expect(definition.nodes.b!.config).toMatchObject({
      condition: "context.plan == 'pro'",
      trueBranch: "yes",
      falseBranch: "no",
    });
    expect(warnings).toHaveLength(0);
  });

  it("warns when a branch is missing its false edge", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        { id: "b", type: "branch", position: { x: 0, y: 1 }, data: { expression: "true" } },
        { id: "yes", type: "exit", position: { x: 0, y: 2 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "t", target: "b" },
        { id: "e2", source: "b", target: "yes", sourceHandle: "true" },
      ],
    };
    const { warnings } = compile(graph, { workflowId: "wf-4", name: "x" });
    expect(warnings.some((w) => w.includes("false"))).toBe(true);
  });
});

describe("compile: split node", () => {
  it("maps named routes to router config with priority order preserved", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        {
          id: "s",
          type: "split",
          position: { x: 0, y: 1 },
          data: {
            routes: [
              { name: "vip", expression: "context.tier == 'vip'" },
              { name: "regular", expression: "true" },
            ],
          },
        },
        { id: "vip-exit", type: "exit", position: { x: 0, y: 2 }, data: {} },
        { id: "reg-exit", type: "exit", position: { x: 0, y: 2 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "t", target: "s" },
        { id: "e2", source: "s", target: "vip-exit", sourceHandle: "vip" },
        { id: "e3", source: "s", target: "reg-exit", sourceHandle: "regular" },
      ],
    };
    const { definition } = compile(graph, { workflowId: "wf-5", name: "x" });
    expect(definition.nodes.s!.type).toBe("router");
    const config = definition.nodes.s!.config as { routes: { target: string; priority: number }[] };
    expect(config.routes[0]).toMatchObject({ target: "vip-exit", priority: 0 });
    expect(config.routes[1]).toMatchObject({ target: "reg-exit", priority: 1 });
  });
});

describe("compile: waitEvent node", () => {
  it("prefixes the event name and sets the timeout at the TaskNode level", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        {
          id: "w",
          type: "waitEvent",
          position: { x: 0, y: 1 },
          data: { eventName: "order.placed", timeoutMs: 259_200_000 },
        },
        { id: "e", type: "exit", position: { x: 0, y: 2 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "t", target: "w" },
        { id: "e2", source: "w", target: "e" },
      ],
    };
    const { definition } = compile(graph, { workflowId: "wf-6", name: "x" });
    expect(definition.nodes.w!.type).toBe("event");
    expect(definition.nodes.w!.onEvent).toBe("loopkit.event.order.placed");
    expect(definition.nodes.w!.timeout).toBe(259_200_000);
  });
});

describe("compile: webhook node", () => {
  it("maps to an http node with method/url/body", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        {
          id: "h",
          type: "webhook",
          position: { x: 0, y: 1 },
          data: { url: "https://example.com/hook", method: "POST", body: { x: 1 } },
        },
        { id: "e", type: "exit", position: { x: 0, y: 2 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "t", target: "h" },
        { id: "e2", source: "h", target: "e" },
      ],
    };
    const { definition } = compile(graph, { workflowId: "wf-7", name: "x" });
    expect(definition.nodes.h!.type).toBe("http");
    expect(definition.nodes.h!.config).toMatchObject({
      method: "POST",
      url: "https://example.com/hook",
      body: { x: 1 },
    });
  });
});

describe("compile: error and warning cases", () => {
  it("throws when the graph has no trigger", () => {
    const graph: JourneyGraph = {
      nodes: [{ id: "e", type: "exit", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    };
    expect(() => compile(graph, { workflowId: "wf-8", name: "x" })).toThrow(CompileError);
  });

  it("throws when the trigger has no outgoing edge", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
      ],
      edges: [],
    };
    expect(() => compile(graph, { workflowId: "wf-9", name: "x" })).toThrow(/no outgoing edge/);
  });

  it("warns (does not throw) when a non-branching node has no outgoing edge", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        { id: "email1", type: "email", position: { x: 0, y: 1 }, data: { templateId: "x" } },
      ],
      edges: [{ id: "e1", source: "t", target: "email1" }],
    };
    const { warnings } = compile(graph, { workflowId: "wf-10", name: "x" });
    expect(warnings.some((w) => w.includes("no outgoing edge"))).toBe(true);
  });
});
