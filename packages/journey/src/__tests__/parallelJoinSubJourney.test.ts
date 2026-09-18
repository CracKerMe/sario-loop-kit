import { describe, expect, it } from "vitest";

import { compile, compileJoinGateAction, delayDataToMs } from "../compile";
import { decompile } from "../decompile";
import { standardWelcomeSequenceGraph } from "../presets";
import { validateGraph } from "../validate";
import { assertWhitelistedGraph } from "../whitelist";
import type { JourneyGraph } from "../types";

function graph(
  nodes: { id: string; type: string; data?: object }[],
  edges: { source: string; target: string; sourceHandle?: string }[],
): JourneyGraph {
  return {
    nodes: nodes.map((n, i) => ({
      ...n,
      data: n.data ?? {},
      position: { x: i * 100, y: 0 },
    })),
    edges: edges.map((e, i) => ({ id: `e${i}`, ...e })),
  } as unknown as JourneyGraph;
}

const trigger = { id: "t", type: "trigger", data: { trigger: { kind: "manual" } } };

describe("compile: parallel fan-out", () => {
  it("compiles to a marker action with one next entry per branch", () => {
    const g = graph(
      [
        trigger,
        { id: "p", type: "parallel" },
        { id: "a", type: "score", data: { value: 1 } },
        { id: "b", type: "updateContact", data: { set: { k: "v" } } },
        { id: "j", type: "join", data: {} },
        { id: "x", type: "exit", data: { reason: "done" } },
      ],
      [
        { source: "t", target: "p" },
        { source: "p", target: "a" },
        { source: "p", target: "b" },
        { source: "a", target: "j" },
        { source: "b", target: "j" },
        { source: "j", target: "x" },
      ],
    );
    assertWhitelistedGraph(g);
    const { definition, warnings } = compile(g, { workflowId: "wf", name: "wf" });

    expect(definition.startNode).toBe("p");
    const p = definition.nodes.p!;
    expect(p.type).toBe("action");
    expect((p.config as { journeyOp?: string }).journeyOp).toBe("parallel");
    expect(p.next).toEqual(["a", "b"]);

    const join = definition.nodes.j!;
    expect(join.type).toBe("action");
    const joinConfig = join.config as { journeyOp?: string; mode?: string; waitFor?: string[] };
    expect(joinConfig.journeyOp).toBe("join");
    expect(joinConfig.mode).toBe("all");
    // waitFor = the branch tails feeding the join
    expect(joinConfig.waitFor).toEqual(["a", "b"]);
    // gate routes via conditionalNext, plain next is empty (premature arrivals dead-end)
    expect(join.next).toEqual([]);
    expect(join.conditionalNext).toEqual([{ condition: "__joinGo_j == true", target: "x" }]);
    expect(warnings).toEqual([]);
  });

  it("propagates mode any", () => {
    const g = graph(
      [
        trigger,
        { id: "p", type: "parallel" },
        { id: "a", type: "score", data: { value: 1 } },
        { id: "b", type: "score", data: { value: 2 } },
        { id: "j", type: "join", data: { mode: "any" } },
        { id: "x", type: "exit", data: {} },
      ],
      [
        { source: "t", target: "p" },
        { source: "p", target: "a" },
        { source: "p", target: "b" },
        { source: "a", target: "j" },
        { source: "b", target: "j" },
        { source: "j", target: "x" },
      ],
    );
    const { definition } = compile(g, { workflowId: "wf", name: "wf" });
    expect((definition.nodes.j!.config as { mode?: string }).mode).toBe("any");
  });
});

describe("compileJoinGateAction", () => {
  const gate = compileJoinGateAction("j", "all", ["a", "b"]);

  function instance(opts: { outputs: string[]; done?: boolean }): {
    context: Record<string, unknown>;
    state: { nodes: Record<string, { output?: unknown }> };
  } {
    const nodes: Record<string, { output?: unknown }> = {};
    for (const id of opts.outputs) nodes[id] = { output: { v: id } };
    return {
      context: opts.done ? { __joinDone_j: true } : {},
      state: { nodes },
    };
  }

  it("routes nowhere (wait) until every branch has output", async () => {
    const inst = instance({ outputs: ["a"] });
    expect(await gate(inst)).toEqual({ join: "wait", arrived: 1, of: 2 });
    expect(inst.context.__joinGo_j).toBe(false);
  });

  it("opens the gate on the last arrival and latches done", async () => {
    const inst = instance({ outputs: ["a", "b"] });
    expect(await gate(inst)).toEqual({ join: "proceed", arrived: 2, of: 2 });
    expect(inst.context.__joinDone_j).toBe(true);
    expect(inst.context.__joinGo_j).toBe(true);
  });

  it("consumes arrivals after the gate already opened", async () => {
    const inst = instance({ outputs: ["a", "b"], done: true });
    expect(await gate(inst)).toEqual({ join: "consumed", arrived: 2, of: 2 });
    expect(inst.context.__joinGo_j).toBe(false);
  });

  it("mode any opens on the first arrival", async () => {
    const gateAny = compileJoinGateAction("j", "any", ["a", "b"]);
    const inst = instance({ outputs: ["b"] });
    expect(await gateAny(inst)).toEqual({ join: "proceed", arrived: 1, of: 2 });
    expect(inst.context.__joinGo_j).toBe(true);
  });
});

describe("compile: subJourney", () => {
  it("compiles to a fire-and-forget subworkflow with mapped child context", () => {
    const g = graph(
      [
        trigger,
        { id: "s", type: "subJourney", data: { journeyId: "child-1" } },
        { id: "x", type: "exit", data: {} },
      ],
      [
        { source: "t", target: "s" },
        { source: "s", target: "x" },
      ],
    );
    const { definition, warnings } = compile(g, { workflowId: "wf", name: "wf" });
    expect(warnings).toEqual([]);
    const s = definition.nodes.s!;
    expect(s.type).toBe("subworkflow");
    expect(s.subworkflowId).toBe("journey-child-1");
    expect(s.waitForCompletion).toBe(false);
    expect(s.subworkflowInput).toEqual({
      contactId: "contactId",
      workspaceId: "workspaceId",
      contact: "contact",
      journeyRunId: "journeyRunId",
      journeyId: "$literal:child-1",
    });
    expect(s.next).toEqual(["x"]);
  });

  it("warns when no journey is selected", () => {
    const g = graph(
      [
        trigger,
        { id: "s", type: "subJourney", data: { journeyId: "" } },
        { id: "x", type: "exit", data: {} },
      ],
      [
        { source: "t", target: "s" },
        { source: "s", target: "x" },
      ],
    );
    const { warnings } = compile(g, { workflowId: "wf", name: "wf" });
    expect(warnings.some((w) => w.includes("subJourney node s"))).toBe(true);
  });
});

describe("validate: parallel / join / subJourney", () => {
  const happyGraph = () =>
    graph(
      [
        trigger,
        { id: "p", type: "parallel" },
        { id: "a", type: "score", data: { value: 1 } },
        { id: "b", type: "score", data: { value: 2 } },
        { id: "j", type: "join", data: {} },
        { id: "x", type: "exit", data: {} },
      ],
      [
        { source: "t", target: "p" },
        { source: "p", target: "a" },
        { source: "p", target: "b" },
        { source: "a", target: "j" },
        { source: "b", target: "j" },
        { source: "j", target: "x" },
      ],
    );

  it("accepts a well-formed parallel/join graph", () => {
    const result = validateGraph(happyGraph());
    expect(result.valid).toBe(true);
  });

  it("rejects a parallel with fewer than two branches", () => {
    const g = happyGraph();
    g.edges = g.edges.filter((e) => !(e.source === "p" && e.target === "b"));
    const result = validateGraph(g);
    expect(
      result.issues.some((i) => i.message.includes("at least two outgoing branch edges")),
    ).toBe(true);
  });

  it("rejects a join with fewer than two incoming edges", () => {
    const g = happyGraph();
    g.edges = g.edges.filter((e) => !(e.source === "b" && e.target === "j"));
    const result = validateGraph(g);
    expect(
      result.issues.some((i) => i.message.includes("at least two incoming branch edges")),
    ).toBe(true);
  });

  it("rejects a join with multiple outgoing edges", () => {
    const g = happyGraph();
    g.nodes.push({ id: "x2", type: "exit", data: {}, position: { x: 0, y: 0 } } as never);
    g.edges.push({ id: "e-x2", source: "j", target: "x2" });
    const result = validateGraph(g);
    expect(result.issues.some((i) => i.message.includes("single outgoing edge"))).toBe(true);
  });

  it("rejects a mode-all join whose branch dead-ends before the join", () => {
    const g = happyGraph();
    // branch b's tail no longer routes to the join — it dead-ends
    g.edges = g.edges.filter((e) => !(e.source === "b" && e.target === "j"));
    const result = validateGraph(g);
    expect(
      result.issues.some((i) => i.nodeId === "b" && i.message.includes("never reaches the join")),
    ).toBe(true);
  });

  it("rejects a mode-all join with an exit inside the parallel region", () => {
    const g = happyGraph();
    g.nodes.push({ id: "ex", type: "exit", data: {}, position: { x: 0, y: 0 } } as never);
    // branch b exits early instead of converging
    g.edges = g.edges.filter((e) => !(e.source === "b" && e.target === "j"));
    g.edges.push({ id: "e-b-ex", source: "b", target: "ex" });
    const result = validateGraph(g);
    expect(result.issues.some((i) => i.nodeId === "ex" && i.message.includes("deadlocks"))).toBe(
      true,
    );
  });

  it("rejects a join with no shared parallel ancestor", () => {
    const g = happyGraph();
    // remove the parallel node: both branches now hang off the trigger
    g.nodes = g.nodes.filter((n) => n.id !== "p");
    g.edges = g.edges.filter((e) => e.source !== "p");
    g.edges.push({ id: "e-t-a", source: "t", target: "a" });
    g.edges.push({ id: "e-t-b", source: "t", target: "b" });
    const result = validateGraph(g);
    expect(result.issues.some((i) => i.message.includes("no shared parallel ancestor"))).toBe(true);
  });

  it("accepts a mode-any join whose branch exits early", () => {
    const g = happyGraph();
    (g.nodes.find((n) => n.id === "j")!.data as { mode?: string }).mode = "any";
    // third branch exits early instead of converging — allowed for mode "any"
    g.nodes.push({ id: "c", type: "score", data: { value: 3 }, position: { x: 0, y: 0 } } as never);
    g.nodes.push({ id: "ex", type: "exit", data: {}, position: { x: 0, y: 0 } } as never);
    g.edges.push({ id: "e-p-c", source: "p", target: "c" });
    g.edges.push({ id: "e-c-ex", source: "c", target: "ex" });
    const result = validateGraph(g);
    expect(result.valid).toBe(true);
  });

  it("requires a journeyId on subJourney", () => {
    const g = graph(
      [
        trigger,
        { id: "s", type: "subJourney", data: { journeyId: "" } },
        { id: "x", type: "exit", data: {} },
      ],
      [
        { source: "t", target: "s" },
        { source: "s", target: "x" },
      ],
    );
    const result = validateGraph(g);
    expect(result.issues.some((i) => i.message.includes("no journey selected"))).toBe(true);
  });
});

describe("decompile: parallel / join / subJourney round-trip", () => {
  it("round-trips a parallel/join graph", () => {
    const g = happyGraphShape();
    const { definition } = compile(g, { workflowId: "wf", name: "wf" });
    const { graph: back } = decompile(definition);
    const byId = new Map(back.nodes.map((n) => [n.id, n]));
    expect(byId.get("p")?.type).toBe("parallel");
    expect(byId.get("j")?.type).toBe("join");
    const joinData = byId.get("j")?.data as { mode?: string } | undefined;
    expect(joinData?.mode).toBe("all");
    const joinEdges = back.edges.filter((e) => e.source === "j");
    expect(joinEdges).toHaveLength(1);
    expect(joinEdges[0]!.target).toBe("x");
    expect(joinEdges[0]!.sourceHandle).toBeUndefined();
    const parallelEdges = back.edges.filter((e) => e.source === "p");
    expect(new Set(parallelEdges.map((e) => e.target))).toEqual(new Set(["a", "b"]));
  });

  it("round-trips a subJourney node", () => {
    const g = graph(
      [
        trigger,
        { id: "s", type: "subJourney", data: { journeyId: "child-9" } },
        { id: "x", type: "exit", data: {} },
      ],
      [
        { source: "t", target: "s" },
        { source: "s", target: "x" },
      ],
    );
    const { definition } = compile(g, { workflowId: "wf", name: "wf" });
    const { graph: back, warnings } = decompile(definition);
    const s = back.nodes.find((n) => n.id === "s")!;
    expect(s.type).toBe("subJourney");
    expect((s.data as { journeyId?: string }).journeyId).toBe("child-9");
    // the only expected warning is the pre-existing exit-as-opless-action note
    expect(warnings.filter((w) => !w.includes("no journey op marker"))).toEqual([]);
  });

  function happyGraphShape(): JourneyGraph {
    return graph(
      [
        trigger,
        { id: "p", type: "parallel" },
        { id: "a", type: "score", data: { value: 1 } },
        { id: "b", type: "score", data: { value: 2 } },
        { id: "j", type: "join", data: {} },
        { id: "x", type: "exit", data: {} },
      ],
      [
        { source: "t", target: "p" },
        { source: "p", target: "a" },
        { source: "p", target: "b" },
        { source: "a", target: "j" },
        { source: "b", target: "j" },
        { source: "j", target: "x" },
      ],
    );
  }
});

describe("presets: standard welcome sequence", () => {
  it("validates and compiles cleanly", () => {
    const g = standardWelcomeSequenceGraph();
    expect(validateGraph(g).valid).toBe(true);
    const { warnings } = compile(g, { workflowId: "wf", name: "welcome" });
    expect(warnings).toEqual([]);
  });

  it("is a linear sequence ending in a goal", () => {
    const g = standardWelcomeSequenceGraph();
    const lastEdges = g.edges.filter((e) => e.target === "exit");
    expect(lastEdges).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === "goal_activated")?.type).toBe("goal");
    // sanity: the 3-day delay really is 3 days
    expect(delayDataToMs({ mode: "duration", ms: 3 * 86_400_000, value: 3, unit: "days" })).toBe(
      3 * 86_400_000,
    );
  });
});
