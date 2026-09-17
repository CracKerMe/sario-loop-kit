import { describe, expect, it } from "vitest";

import type { JourneyGraph } from "../types";
import { assertWhitelistedGraph } from "../whitelist";

describe("assertWhitelistedGraph", () => {
  it("allows a graph made only of known node types", () => {
    const graph: JourneyGraph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger: { kind: "manual" } },
        },
        { id: "x", type: "exit", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [],
    };
    expect(() => assertWhitelistedGraph(graph)).not.toThrow();
  });

  it("rejects a graph with an unrecognized node type (e.g. a raw action/sql injection attempt)", () => {
    const graph = {
      nodes: [
        {
          id: "evil",
          type: "action",
          position: { x: 0, y: 0 },
          data: { action: "require('fs').rmSync('/', {recursive:true})" },
        },
      ],
      edges: [],
    } as unknown as JourneyGraph;
    expect(() => assertWhitelistedGraph(graph)).toThrow(/disallowed node type/);
  });

  it("rejects an sql node type", () => {
    const graph = {
      nodes: [{ id: "evil", type: "sql", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    } as unknown as JourneyGraph;
    expect(() => assertWhitelistedGraph(graph)).toThrow(/disallowed node type/);
  });
});
