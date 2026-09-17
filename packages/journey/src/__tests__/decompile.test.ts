import type { WorkflowDefinition } from "ts-workflow-engine-lite";
import { describe, expect, it } from "vitest";

import { compile } from "../compile";
import { decompile } from "../decompile";
import type { JourneyGraph } from "../types";

describe("decompile", () => {
  it("preserves node ids and topology for a linear workflow", () => {
    const definition: WorkflowDefinition = {
      id: "wf-1",
      name: "test",
      startNode: "a",
      nodes: {
        a: { id: "a", type: "action", action: async () => ({}), next: ["b"] },
        b: { id: "b", type: "wait", config: { durationMs: 1000 }, next: [] },
      },
    };
    const { graph, warnings } = decompile(definition);

    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(graph.edges.some((e) => e.source === "a" && e.target === "b")).toBe(true);
    // The action node has no journey-graph equivalent -> imported with a
    // warning rather than failing.
    expect(warnings.some((w) => w.includes("action"))).toBe(true);
  });

  it("round-trips node ids and topology through compile(decompile(x))", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "trig",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        { id: "welcome", type: "email", position: { x: 0, y: 1 }, data: { templateId: "tpl-1" } },
        {
          id: "wait",
          type: "delay",
          position: { x: 0, y: 2 },
          data: { mode: "duration", ms: 1000 },
        },
        { id: "end", type: "exit", position: { x: 0, y: 3 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "trig", target: "welcome" },
        { id: "e2", source: "welcome", target: "wait" },
        { id: "e3", source: "wait", target: "end" },
      ],
    };

    const { definition } = compile(graph, { workflowId: "wf-2", name: "x" });
    const { graph: reimported } = decompile(definition);

    // Not asserting deep equality (decompile is intentionally lossy —
    // positions, the trigger, and exact node "type" naming don't
    // round-trip 1:1) — only that node ids and edge topology survive.
    const reimportedIds = new Set(reimported.nodes.map((n) => n.id));
    expect(reimportedIds.has("welcome")).toBe(true);
    expect(reimportedIds.has("wait")).toBe(true);
    expect(reimportedIds.has("end")).toBe(true);
    expect(reimported.edges.some((e) => e.source === "welcome" && e.target === "wait")).toBe(true);
    expect(reimported.edges.some((e) => e.source === "wait" && e.target === "end")).toBe(true);
  });

  it("decompiles a wait node's externalTimer config back into a delay node", () => {
    const definition: WorkflowDefinition = {
      id: "wf-3",
      name: "x",
      startNode: "d",
      nodes: {
        d: {
          id: "d",
          type: "wait",
          config: { durationMs: 5000, externalTimer: { enabled: true } },
          next: [],
        },
      },
    };
    const { graph } = decompile(definition);
    const node = graph.nodes.find((n) => n.id === "d");
    expect(node?.type).toBe("delay");
    expect(node?.data).toMatchObject({ mode: "duration", ms: 5000 });
  });

  it("decompiles a notification node with the loopkit-email channel into an email node", () => {
    const definition: WorkflowDefinition = {
      id: "wf-4",
      name: "x",
      startNode: "n",
      nodes: {
        n: {
          id: "n",
          type: "notification",
          config: {
            channel: "loopkit-email",
            target: "{{ contact.email }}",
            template: "template:tpl-abc",
            subject: "Hi",
          },
          next: [],
        },
      },
    };
    const { graph } = decompile(definition);
    const node = graph.nodes.find((n) => n.id === "n");
    expect(node?.type).toBe("email");
    expect(node?.data).toMatchObject({ templateId: "tpl-abc", subject: "Hi" });
  });
});
