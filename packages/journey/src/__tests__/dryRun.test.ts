import { describe, expect, it } from "vitest";

import { dryRunJourney } from "../dryRun";
import type { JourneyGraph } from "../types";

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  position = { x: 0, y: 0 },
): JourneyGraph["nodes"][number] {
  return { id, type, data, position } as JourneyGraph["nodes"][number];
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string,
): JourneyGraph["edges"][number] {
  return { id: `${source}-${sourceHandle ?? "n"}-${target}`, source, target, sourceHandle };
}

function baseContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: "ws-1",
    journeyId: "j-1",
    contactId: "c-1",
    contact: { id: "c-1", email: "sam@example.com", plan: "pro" },
    ...overrides,
  };
}

const linearGraph: JourneyGraph = {
  nodes: [
    node("t", "trigger", { trigger: { kind: "manual" } }),
    node("e1", "email", { templateId: "tpl-1", subject: "Hello" }),
    node("x", "exit", { reason: "done" }),
  ],
  edges: [edge("t", "e1"), edge("e1", "x")],
};

describe("dryRunJourney", () => {
  it("walks a linear graph, collects emails in order, and stops at exit", () => {
    const result = dryRunJourney(linearGraph, baseContext());

    expect(result.errors).toEqual([]);
    expect(result.startNode).toBe("e1");
    expect(result.executionPath).toEqual(["e1", "x"]);
    expect(result.exited).toBe(true);
    expect(result.exitReason).toBe("done");
    expect(result.steps.find((s) => s.type === "exit")?.detail.reason).toBe("done");
    expect(result.emails).toEqual([
      {
        nodeId: "e1",
        templateId: "tpl-1",
        subject: "Hello",
        preheader: undefined,
        fromName: undefined,
        replyTo: undefined,
      },
    ]);
  });

  it("evaluates a branch against the real context (same evaluator as runtime)", () => {
    const graph: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("b", "branch", { expression: 'contact.plan == "pro"' }),
        node("yes", "email", { templateId: "tpl-pro" }),
        node("no", "email", { templateId: "tpl-free" }),
        node("x", "exit", {}),
      ],
      edges: [
        edge("t", "b"),
        edge("b", "yes", "true"),
        edge("b", "no", "false"),
        edge("yes", "x"),
        edge("no", "x"),
      ],
    };

    const pro = dryRunJourney(graph, baseContext());
    expect(pro.executionPath).toEqual(["b", "yes", "x"]);
    expect(pro.emails.map((e) => e.templateId)).toEqual(["tpl-pro"]);

    const free = dryRunJourney(
      graph,
      baseContext({ contact: { id: "c-1", email: "s@e.com", plan: "free" } }),
    );
    expect(free.executionPath).toEqual(["b", "no", "x"]);
    expect(free.emails.map((e) => e.templateId)).toEqual(["tpl-free"]);
  });

  it("picks the first matching split route and falls back to default", () => {
    const graph: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("s", "split", {
          routes: [
            { name: "vip", expression: 'contact.plan == "pro"' },
            { name: "other", expression: "true" },
          ],
        }),
        node("vip", "email", { templateId: "tpl-vip" }),
        node("other", "email", { templateId: "tpl-other" }),
        node("fallback", "email", { templateId: "tpl-fb" }),
      ],
      edges: [
        edge("t", "s"),
        edge("s", "vip", "vip"),
        edge("s", "other", "other"),
        edge("s", "fallback", "default"),
      ],
    };

    expect(dryRunJourney(graph, baseContext()).executionPath).toEqual(["s", "vip"]);
    expect(
      dryRunJourney(graph, baseContext({ contact: { id: "c-1", email: "s@e.com" } })).executionPath,
    ).toEqual(["s", "other"]);
  });

  it("deterministically resolves the abSplit variant from contact identity", () => {
    const graph: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("ab", "abSplit", {
          variants: [
            { name: "A", weight: 1 },
            { name: "B", weight: 1 },
          ],
        }),
        node("a", "email", { templateId: "tpl-a" }),
        node("b", "email", { templateId: "tpl-b" }),
      ],
      edges: [edge("t", "ab"), edge("ab", "a", "A"), edge("ab", "b", "B")],
    };

    const first = dryRunJourney(graph, baseContext());
    const second = dryRunJourney(graph, baseContext());
    expect(first.executionPath).toEqual(second.executionPath);
    expect(["a", "b"]).toContain(first.executionPath[1]);
    const variantStep = first.steps.find((s) => s.nodeId === "ab")!;
    expect(variantStep.detail.variant).toBe(first.executionPath[1] === "a" ? "A" : "B");
    expect(typeof variantStep.detail.bucket).toBe("number");
  });

  it("resolves timeWindow against the provided reference time", () => {
    // 2026-09-16 is a Wednesday (day 3). Window: Wed 9-17.
    const graph: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("w", "timeWindow", { days: [3], startHour: 9, endHour: 17 }),
        node("in", "email", { templateId: "tpl-in" }),
        node("out", "email", { templateId: "tpl-out" }),
      ],
      edges: [edge("t", "w"), edge("w", "in", "true"), edge("w", "out", "false")],
    };

    const wedNoon = new Date("2026-09-16T12:00:00");
    const wedNight = new Date("2026-09-16T23:00:00");
    expect(dryRunJourney(graph, baseContext(), { now: wedNoon }).executionPath).toEqual([
      "w",
      "in",
    ]);
    expect(dryRunJourney(graph, baseContext(), { now: wedNight }).executionPath).toEqual([
      "w",
      "out",
    ]);
  });

  it("resolves exact {{path}} placeholders in updateContact like the runtime handler", () => {
    const graph: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("u", "updateContact", {
          // Exact placeholder resolves; composed strings stay literal —
          // identical to core's resolveContextValue.
          set: { plan: "{{ contact.plan }}", stage: "onboard-{{ contact.plan }}" },
          addTags: ["beta"],
        }),
        node("x", "exit", {}),
      ],
      edges: [edge("t", "u"), edge("u", "x")],
    };

    const result = dryRunJourney(graph, baseContext());
    const step = result.steps.find((s) => s.nodeId === "u")!;
    expect(step.detail.set).toEqual({ plan: "pro", stage: "onboard-{{ contact.plan }}" });
  });

  it("warns on waitEvent (follows the success path) and describes the wait", () => {
    const graph: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("w", "waitEvent", { eventName: "purchase", timeoutMs: 86_400_000 }),
        node("after", "email", { templateId: "tpl-after" }),
      ],
      edges: [edge("t", "w"), edge("w", "after", "event")],
    };

    const result = dryRunJourney(graph, baseContext());
    expect(result.executionPath).toEqual(["w", "after"]);
    expect(result.warnings.some((w) => w.includes('"purchase"'))).toBe(true);
    expect(result.steps[0]?.description).toContain("purchase");
  });

  it("never makes network calls for webhook/notify — describes only", () => {
    const graph: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("h", "webhook", { url: "https://example.com/hook", method: "POST" }),
        node("n", "notify", { url: "https://hooks.slack.com/x", message: "hi" }),
      ],
      edges: [edge("t", "h"), edge("h", "n")],
    };

    const result = dryRunJourney(graph, baseContext());
    expect(result.executionPath).toEqual(["h", "n"]);
    expect(result.warnings.filter((w) => w.includes("no HTTP request")).length).toBeGreaterThan(0);
  });

  it("respects stopAfterNode and reports cycles instead of looping forever", () => {
    const stopped = dryRunJourney(linearGraph, baseContext(), { stopAfterNode: "e1" });
    expect(stopped.executionPath).toEqual(["e1"]);
    expect(stopped.warnings.some((w) => w.includes("stopped at node"))).toBe(true);

    const loop: JourneyGraph = {
      nodes: [
        node("t", "trigger", { trigger: { kind: "manual" } }),
        node("a", "email", { templateId: "tpl" }),
        node("b", "email", { templateId: "tpl" }),
      ],
      edges: [edge("t", "a"), edge("a", "b"), edge("b", "a")],
    };
    // Same semantic as the engine's DryRunExecutor: a cycle is a modeling
    // error, surfaced loudly rather than walked.
    const cyclic = dryRunJourney(loop, baseContext());
    expect(cyclic.errors.some((e) => e.error.includes("circular dependency"))).toBe(true);
    expect(cyclic.truncated).toBe(false);
  });

  it("reports unknown targets and trigger-less graphs as errors, not throws", () => {
    const badEdge: JourneyGraph = {
      nodes: [node("t", "trigger", { trigger: { kind: "manual" } }), node("a", "exit", {})],
      edges: [edge("t", "ghost")],
    };
    expect(dryRunJourney(badEdge, baseContext()).errors[0]?.error).toContain("unknown node ghost");

    const noTrigger: JourneyGraph = { nodes: [node("a", "exit", {})], edges: [] };
    expect(dryRunJourney(noTrigger, baseContext()).errors[0]?.error).toContain("no trigger");
  });
});
