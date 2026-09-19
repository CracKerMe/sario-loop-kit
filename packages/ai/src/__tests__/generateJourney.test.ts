import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { GRAPH_TOOL_NAME, buildSystemPrompt, buildUserPrompt } from "../prompt";
import { generateJourneyGraph, type GeneratedJourney } from "../generateJourney";
import { AiGraphError } from "../graphGuard";
import { DEFAULT_AI_MODEL } from "../client";
import { validGraph } from "./graphGuard.test";

type CreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;

function toolResponse(input: unknown, toolUseId = "toolu_1"): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "tool_use", id: toolUseId, name: GRAPH_TOOL_NAME, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  } as unknown as Anthropic.Messages.Message;
}

function proseResponse(text: string): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 },
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
  request: "Welcome series for new signups",
  templates: [{ id: "tpl-1", name: "Welcome" }],
  events: ["signed_up"],
};

describe("generateJourneyGraph", () => {
  it("returns a guarded graph on the first attempt and forces the tool", async () => {
    const { client, calls } = mockClient([toolResponse(validGraph())]);
    const result: GeneratedJourney = await generateJourneyGraph(CTX, { client });

    expect(result.attempts).toBe(1);
    expect(result.model).toBe(DEFAULT_AI_MODEL);
    expect(result.graph.nodes.map((n) => n.id)).toEqual(["t1", "n1", "n2", "n3"]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool_choice).toEqual({ type: "tool", name: GRAPH_TOOL_NAME });
    expect(calls[0]!.tools?.[0]).toMatchObject({ name: GRAPH_TOOL_NAME });
  });

  it("includes templates and events in the prompt", async () => {
    const { client, calls } = mockClient([toolResponse(validGraph())]);
    await generateJourneyGraph(CTX, { client });

    const user = calls[0]!.messages[0]!;
    const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    expect(text).toContain("tpl-1");
    expect(text).toContain("signed_up");
    expect(calls[0]!.system).toContain(GRAPH_TOOL_NAME);
  });

  it("repairs once when the first graph fails the guard", async () => {
    const bad = validGraph();
    bad.edges = bad.edges.filter((e) => e.source !== "n1"); // email dead-ends
    const { client, calls } = mockClient([
      toolResponse(bad),
      toolResponse(validGraph(), "toolu_2"),
    ]);

    const result = await generateJourneyGraph(CTX, { client });
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);

    // The repair round replays the assistant turn and returns an errored tool_result.
    const repairUser = calls[1]!.messages.at(-1)!;
    const blocks = Array.isArray(repairUser.content) ? repairUser.content : [];
    const toolResult = blocks.find(
      (b): b is Anthropic.Messages.ToolResultBlockParam => b.type === "tool_result",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.is_error).toBe(true);
    expect(String(toolResult!.content)).toMatch(/no outgoing edge/);
    expect(calls[1]!.tool_choice).toEqual({ type: "tool", name: GRAPH_TOOL_NAME });
  });

  it("throws AiGraphError with the issues when repair also fails", async () => {
    const bad = validGraph();
    bad.edges = [];
    const { client } = mockClient([toolResponse(bad)]);
    await expect(generateJourneyGraph(CTX, { client })).rejects.toBeInstanceOf(AiGraphError);
  });

  it("throws when the model answers in prose instead of using the tool", async () => {
    const { client } = mockClient([proseResponse("Here is a journey idea: ...")]);
    await expect(generateJourneyGraph(CTX, { client })).rejects.toThrow(/did not call/);
  });

  it("accumulates usage across attempts", async () => {
    const bad = validGraph();
    bad.edges = bad.edges.filter((e) => e.source !== "n1");
    const { client } = mockClient([toolResponse(bad), toolResponse(validGraph(), "toolu_2")]);
    const result = await generateJourneyGraph(CTX, { client });
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
  });

  it("respects an explicit model override", async () => {
    const { client, calls } = mockClient([toolResponse(validGraph())]);
    await generateJourneyGraph(CTX, { client, model: "claude-haiku-test" });
    expect(calls[0]!.model).toBe("claude-haiku-test");
  });
});

describe("prompts", () => {
  it("forbids email nodes when no templates are provided", () => {
    const text = buildUserPrompt({ request: "test" });
    expect(text).toMatch(/do NOT create email nodes/i);
  });

  it("documents every whitelisted node type", () => {
    const text = buildSystemPrompt();
    for (const type of [
      "trigger",
      "delay",
      "email",
      "branch",
      "split",
      "filter",
      "waitEvent",
      "exit",
      "abSplit",
      "timeWindow",
      "updateContact",
      "score",
      "goal",
      "notify",
      "parallel",
      "join",
      "subJourney",
    ]) {
      expect(text).toContain(`- ${type}:`);
    }
  });
});
