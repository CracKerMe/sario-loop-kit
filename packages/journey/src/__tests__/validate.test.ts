import { describe, expect, it } from "vitest";

import type { JourneyGraph } from "../types";
import { validateGraph } from "../validate";

describe("validateGraph", () => {
  it("passes for a well-formed linear graph", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        { id: "e1", type: "email", position: { x: 0, y: 1 }, data: { templateId: "x" } },
        { id: "x", type: "exit", position: { x: 0, y: 2 }, data: {} },
      ],
      edges: [
        { id: "a", source: "t", target: "e1" },
        { id: "b", source: "e1", target: "x" },
      ],
    };
    expect(validateGraph(graph).valid).toBe(true);
  });

  it("flags a missing trigger", () => {
    const graph: JourneyGraph = {
      nodes: [{ id: "x", type: "exit", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("no trigger"))).toBe(true);
  });

  it("flags more than one trigger", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t1",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        {
          id: "t2",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
      ],
      edges: [],
    };
    const result = validateGraph(graph);
    expect(result.issues.some((i) => i.message.includes("more than one trigger"))).toBe(true);
  });

  it("flags duplicate node ids", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        { id: "dup", type: "exit", position: { x: 0, y: 0 }, data: {} },
        { id: "dup", type: "exit", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [],
    };
    const result = validateGraph(graph);
    expect(result.issues.some((i) => i.message.includes("duplicate node id"))).toBe(true);
  });

  it("flags an edge referencing an unknown node", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
      ],
      edges: [{ id: "e", source: "t", target: "does-not-exist" }],
    };
    const result = validateGraph(graph);
    expect(result.issues.some((i) => i.message.includes("unknown target"))).toBe(true);
  });

  it("flags a branch node missing its false edge", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        { id: "b", type: "branch", position: { x: 0, y: 0 }, data: { expression: "true" } },
        { id: "x", type: "exit", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "t", target: "b" },
        { id: "e2", source: "b", target: "x", sourceHandle: "true" },
      ],
    };
    const result = validateGraph(graph);
    expect(result.issues.some((i) => i.nodeId === "b" && i.message.includes("false"))).toBe(true);
  });

  it("flags an unreachable node", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        { id: "reachable", type: "exit", position: { x: 0, y: 0 }, data: {} },
        { id: "orphan", type: "exit", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [{ id: "e1", source: "t", target: "reachable" }],
    };
    const result = validateGraph(graph);
    expect(
      result.issues.some((i) => i.nodeId === "orphan" && i.message.includes("not reachable")),
    ).toBe(true);
  });

  it("flags an exit node with outgoing edges", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        { id: "x", type: "exit", position: { x: 0, y: 0 }, data: {} },
        { id: "x2", type: "exit", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "t", target: "x" },
        { id: "e2", source: "x", target: "x2" },
      ],
    };
    const result = validateGraph(graph);
    expect(
      result.issues.some((i) => i.nodeId === "x" && i.message.includes("outgoing edges")),
    ).toBe(true);
  });
});
