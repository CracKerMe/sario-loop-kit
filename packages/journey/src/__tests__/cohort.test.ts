/**
 * Cohort aggregation — pure layer tests. Builds small graphs, walks them
 * with dryRunJourney for synthetic contacts, and verifies the aggregate:
 * branch distributions, node reach, drop-off attribution, exit reasons,
 * and the compact graph reference the AI interpreter receives.
 */
import { describe, expect, it } from "vitest";

import { aggregateDryRuns, describeGraphForSimulation } from "../cohort";
import { dryRunJourney } from "../dryRun";
import type { JourneyGraph } from "../types";

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  position = { x: 0, y: 0 },
): JourneyGraph["nodes"][number] {
  return { id, type: type as never, data: data as never, position } as never;
}

function edge(id: string, source: string, target: string, sourceHandle?: string) {
  return sourceHandle ? { id, source, target, sourceHandle } : { id, source, target };
}

const branchGraph: JourneyGraph = {
  nodes: [
    node("t", "trigger", { trigger: { kind: "manual" } }),
    node("b", "branch", { expression: 'contact.plan == "pro"' }),
    node("vip", "email", { templateId: "tpl-vip" }, { x: 100, y: 0 }),
    node("free", "email", { templateId: "tpl-free" }, { x: 100, y: 100 }),
    node("x", "exit", { reason: "done" }, { x: 200, y: 50 }),
  ],
  edges: [
    edge("e1", "t", "b"),
    edge("e2", "b", "vip", "true"),
    edge("e3", "b", "free", "false"),
    edge("e4", "vip", "x"),
    edge("e5", "free", "x"),
  ],
};

function runFor(contactId: string, plan: string) {
  return {
    contactId,
    result: dryRunJourney(branchGraph, {
      workspaceId: "ws-1",
      journeyId: "j-1",
      contactId,
      contact: { id: contactId, email: `${contactId}@x.io`, plan },
      trigger: { kind: "manual" },
      journeyRunId: "dry-run",
    }),
  };
}

describe("aggregateDryRuns", () => {
  it("aggregates branch outcomes and node reach across contacts", () => {
    const runs = [
      runFor("c1", "pro"),
      runFor("c2", "pro"),
      runFor("c3", "free"),
      runFor("c4", "team"), // expression false → free path
    ];
    const sim = aggregateDryRuns(runs);

    expect(sim.samples).toBe(4);
    expect(sim.exitedCount).toBe(4);
    expect(sim.endedEarlyCount).toBe(0);

    const branch = sim.branches.find((b) => b.nodeId === "b");
    expect(branch).toBeDefined();
    // Equal counts → insertion order; compare as a multiset.
    expect(branch!.outcomes).toEqual(
      expect.arrayContaining([
        { value: "false", count: 2 },
        { value: "true", count: 2 },
      ]),
    );
    expect(branch!.outcomes).toHaveLength(2);

    const reach = Object.fromEntries(sim.nodeReach.map((r) => [r.nodeId, r.count]));
    expect(reach["b"]).toBe(4);
    expect(reach["vip"]).toBe(2);
    expect(reach["free"]).toBe(2);
    expect(reach["x"]).toBe(4);
    expect(reach["t"]).toBeUndefined(); // trigger is not a walk target
  });

  it("attributes drop-offs to the last node of dead-end walks", () => {
    const dangling: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("f", "filter", { expression: 'contact.plan == "pro"' }),
        node("e", "email", { templateId: "tpl-1" }),
      ],
      edges: [edge("e1", "t", "f"), edge("e2", "f", "e", "true")],
    };
    const run = {
      contactId: "c1",
      result: dryRunJourney(dangling, {
        workspaceId: "ws-1",
        journeyId: "j-1",
        contactId: "c1",
        contact: { id: "c1", email: "c1@x.io", plan: "pro" },
        trigger: { kind: "manual" },
        journeyRunId: "dry-run",
      }),
    };
    const sim = aggregateDryRuns([run]);
    expect(sim.exitedCount).toBe(0);
    expect(sim.endedEarlyCount).toBe(1);
    expect(sim.dropOffs).toEqual([{ nodeId: "e", count: 1 }]);
  });

  it("counts exit reasons and dedupes warnings with occurrence counts", () => {
    const runs = [runFor("c1", "pro"), runFor("c2", "pro")];
    const sim = aggregateDryRuns(runs);
    expect(sim.exitReasons).toEqual([{ reason: "done", count: 2 }]);
  });

  it("handles an empty cohort", () => {
    const sim = aggregateDryRuns([]);
    expect(sim.samples).toBe(0);
    expect(sim.branches).toEqual([]);
    expect(sim.nodeReach).toEqual([]);
    expect(sim.dropOffs).toEqual([]);
  });
});

describe("describeGraphForSimulation", () => {
  it("produces compact node refs with labeled outcomes and handles", () => {
    const refs = describeGraphForSimulation(branchGraph);
    const b = refs.find((r) => r.id === "b")!;
    expect(b.type).toBe("branch");
    expect(b.label).toBe('contact.plan == "pro"');
    expect(b.next).toEqual(["vip(true)", "free(false)"]);

    const abGraph: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("ab", "abSplit", {
          variants: [
            { name: "A", weight: 50 },
            { name: "B", weight: 50 },
          ],
        }),
      ],
      edges: [edge("e1", "t", "ab"), edge("e2", "ab", "x", "A")],
    };
    const ab = describeGraphForSimulation(abGraph).find((r) => r.id === "ab")!;
    expect(ab.label).toBe("A:50 | B:50");
  });
});
