import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AiGraphError } from "../graphGuard";
import { generateJourneyOptimization } from "../generateOptimization";
import {
  JOURNEY_OPTIMIZATION_TOOL_NAME,
  buildJourneyOptimizationUserPrompt,
  guardJourneyOptimization,
} from "../journeyOptimization";
import { validGraph } from "./graphGuard.test";

type CreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;

function proposalInput(graph: unknown = validGraph()) {
  return {
    analysis: {
      summary: "第 3 步 delay 过长导致流失。",
      diagnosis: [
        {
          nodeId: "n2",
          nodeType: "delay",
          issue: "等待 24h 后大量掉出",
          severity: "critical" as const,
        },
      ],
      changes: [{ nodeId: "n2", action: "modify" as const, description: "缩短为 4 小时" }],
      expectedImpact: [
        { metric: "completionRate", direction: "increase" as const, note: "减少中途放弃" },
      ],
      canaryPercent: 10,
      nodeMapping: { n2: "n2" },
    },
    graph,
  };
}

function toolResponse(input: unknown, toolUseId = "toolu_opt"): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "tool_use", id: toolUseId, name: JOURNEY_OPTIMIZATION_TOOL_NAME, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 80, output_tokens: 40 },
  } as unknown as Anthropic.Messages.Message;
}

function mockClient(responses: Anthropic.Messages.Message[]) {
  const calls: CreateParams[] = [];
  const client = {
    messages: {
      create: async (params: CreateParams) => {
        const index = calls.length;
        calls.push(params);
        return responses[Math.min(index, responses.length - 1)]!;
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const CTX = {
  journeyName: "Welcome series",
  baselineVersion: 3,
  graph: [
    { id: "t1", type: "trigger", label: "", next: ["n1"] },
    { id: "n1", type: "email", label: "", next: ["n2"] },
    { id: "n2", type: "delay", label: "", next: ["n3"] },
    { id: "n3", type: "exit", label: "", next: [] },
  ],
  signals: {
    runCounts: { completed: 40, failed: 10, running: 5 },
    nodes: [
      { nodeId: "n1", nodeType: "notification", status: "completed", count: 50 },
      { nodeId: "n2", nodeType: "wait", status: "running", count: 20 },
    ],
    email: {
      sent: 50,
      delivered: 45,
      bounced: 2,
      complained: 0,
      failed: 3,
      opened: 20,
      clicked: 8,
      openRate: 20 / 45,
      clickRate: 8 / 45,
    },
    inFlightByVersion: [{ version: 3, runs: 5 }],
  },
  templates: [{ id: "tpl-1", name: "Welcome" }],
  events: ["signed_up"],
};

describe("guardJourneyOptimization", () => {
  it("accepts a valid proposal and keeps analysis fields", () => {
    const result = guardJourneyOptimization(proposalInput());
    expect(result.analysis.canaryPercent).toBe(10);
    expect(result.graph.nodes.map((n) => n.id)).toEqual(["t1", "n1", "n2", "n3"]);
  });

  it("clamps canaryPercent into 1–50", () => {
    const input = proposalInput();
    (input.analysis as { canaryPercent: number }).canaryPercent = 90;
    const result = guardJourneyOptimization(input);
    expect(result.analysis.canaryPercent).toBe(50);
  });

  it("rejects a disallowed node type in the proposed graph", () => {
    const evil = validGraph();
    (evil.nodes as { type: string }[]).push({
      id: "x",
      type: "action",
      position: { x: 0, y: 0 },
      data: { action: "process.exit(1)" },
    } as never);
    expect(() => guardJourneyOptimization(proposalInput(evil))).toThrow(AiGraphError);
  });

  it("rejects nodeMapping that points outside the proposed graph", () => {
    const input = proposalInput();
    (input.analysis as { nodeMapping: Record<string, string> }).nodeMapping = { n2: "missing" };
    expect(() => guardJourneyOptimization(input)).toThrow(AiGraphError);
  });
});

describe("generateJourneyOptimization", () => {
  it("returns a guarded proposal on the first attempt", async () => {
    const { client, calls } = mockClient([toolResponse(proposalInput())]);
    const result = await generateJourneyOptimization(CTX, { client });
    expect(result.attempts).toBe(1);
    expect(result.result.analysis.summary).toContain("delay");
    expect(result.result.graph.nodes).toHaveLength(4);
    expect(calls[0]!.tool_choice).toEqual({
      type: "tool",
      name: JOURNEY_OPTIMIZATION_TOOL_NAME,
    });
  });

  it("feeds funnel numbers and templates into the user prompt", async () => {
    const { client, calls } = mockClient([toolResponse(proposalInput())]);
    await generateJourneyOptimization(CTX, { client });
    const user = calls[0]!.messages[0]!;
    const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    expect(text).toContain("Welcome series");
    expect(text).toContain("tpl-1");
    expect(text).toContain("bounced=2");
    expect(text).toContain("signed_up");
  });

  it("throws when the model refuses the tool", async () => {
    const { client } = mockClient([
      {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "no thanks" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as unknown as Anthropic.Messages.Message,
    ]);
    await expect(generateJourneyOptimization(CTX, { client })).rejects.toThrow(AiGraphError);
  });
});

describe("buildJourneyOptimizationUserPrompt", () => {
  it("includes operator constraints when provided", () => {
    const text = buildJourneyOptimizationUserPrompt({
      ...CTX,
      request: "keep the same email templates",
    });
    expect(text).toContain("keep the same email templates");
  });
});
