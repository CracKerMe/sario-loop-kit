import { describe, expect, it } from "vitest";
import type { JourneyGraph } from "@loopkit/journey";
import { AiGraphError, extractJsonObject, guardAiGraph } from "../graphGuard";

export function validGraph(): JourneyGraph {
  return {
    nodes: [
      {
        id: "t1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { trigger: { kind: "event", name: "signed_up" } },
      },
      {
        id: "n1",
        type: "email",
        position: { x: 260, y: 0 },
        data: { templateId: "tpl-1", subject: "Welcome" },
      },
      {
        id: "n2",
        type: "delay",
        position: { x: 520, y: 0 },
        data: { mode: "duration", ms: 86_400_000, value: 1, unit: "days" },
      },
      { id: "n3", type: "exit", position: { x: 780, y: 0 }, data: { reason: "done" } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "n1" },
      { id: "e2", source: "n1", target: "n2" },
      { id: "e3", source: "n2", target: "n3" },
    ],
  };
}

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonObject('{"nodes":[],"edges":[]}')).toEqual({ nodes: [], edges: [] });
  });

  it("strips markdown fences and surrounding prose", () => {
    const raw = 'Here is your journey:\n```json\n{"nodes":[],"edges":[]}\n```\nHope that helps!';
    expect(extractJsonObject(raw)).toEqual({ nodes: [], edges: [] });
  });

  it("takes the outermost braces when prose contains braces", () => {
    const raw = 'Note {like this} then {"nodes":1}';
    expect(extractJsonObject(raw)).toEqual({ nodes: 1 });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJsonObject("no json here")).toThrow(AiGraphError);
  });

  it("throws on malformed JSON with the underlying message", () => {
    expect(() => extractJsonObject('{"nodes":')).toThrow(AiGraphError);
  });
});

describe("guardAiGraph", () => {
  it("accepts a structurally valid graph", () => {
    const graph = guardAiGraph(validGraph());
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(3);
  });

  it("accepts a fenced JSON string", () => {
    const graph = guardAiGraph(`\`\`\`json\n${JSON.stringify(validGraph())}\n\`\`\``);
    expect(graph.nodes[0]!.id).toBe("t1");
  });

  it("rejects non-whitelisted node types before they reach compile()", () => {
    const evil = validGraph();
    (evil.nodes as { type: string }[]).splice(1, 0, {
      id: "x1",
      type: "action",
      position: { x: 100, y: 0 },
      data: { action: "process.exit(1)" },
    } as never);
    expect(() => guardAiGraph(evil)).toThrow(AiGraphError);
    try {
      guardAiGraph(evil);
    } catch (err) {
      const issues = (err as AiGraphError).issues.join(" ");
      expect(issues).toMatch(/action/i);
    }
  });

  it("strips unknown/injected fields from nodes and data", () => {
    const dirty = validGraph() as unknown as Record<string, unknown>;
    const emailNode = dirty.nodes as Record<string, unknown>[];
    emailNode[1] = { ...emailNode[1], injected: "prompt" };
    emailNode[1] = {
      ...emailNode[1],
      data: { ...(emailNode[1].data as object), evilSql: "DROP TABLE users" },
    };
    const graph = guardAiGraph(dirty);
    expect(graph.nodes[1]).not.toHaveProperty("injected");
    expect((graph.nodes[1] as { data: Record<string, unknown> }).data).not.toHaveProperty(
      "evilSql",
    );
  });

  it("rejects a graph without a trigger via validateGraph", () => {
    const noTrigger = validGraph();
    noTrigger.nodes = noTrigger.nodes.filter((n) => n.type !== "trigger");
    expect(() => guardAiGraph(noTrigger)).toThrow(/no trigger node/);
  });

  it("rejects a graph that fails the same pre-flight a human draft must clear", () => {
    const deadEnd = validGraph();
    deadEnd.edges = deadEnd.edges.filter((e) => e.source !== "n1");
    expect(() => guardAiGraph(deadEnd)).toThrow(/no outgoing edge/);
  });

  it("rejects non-object payloads", () => {
    expect(() => guardAiGraph([1, 2, 3])).toThrow(AiGraphError);
    expect(() => guardAiGraph(null)).toThrow(AiGraphError);
  });

  it("coerces string numbers the model may emit", () => {
    const graph = validGraph();
    (graph.nodes[2]!.data as { ms: unknown }).ms = "86400000";
    const parsed = guardAiGraph(graph);
    expect((parsed.nodes[2]!.data as { ms: number }).ms).toBe(86_400_000);
  });
});
