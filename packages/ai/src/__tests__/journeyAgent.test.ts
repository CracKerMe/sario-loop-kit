import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import { AGENT_TURN_TOOL_NAME, guardJourneyAgentTurn, runJourneyAgentTurn } from "../journeyAgent";
import { JourneyAgentError } from "../journeyAgent";
import { validGraph } from "./graphGuard.test";

type CreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;

function toolResponse(input: unknown, toolUseId = "toolu_1"): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "tool_use", id: toolUseId, name: AGENT_TURN_TOOL_NAME, input }],
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
  journeyName: "挽回流程",
  brief: "给注册 7 天没下单的用户发挽回邮件",
  requirements: [],
  currentGraph: validGraph(),
  userMessage: "加一条：打开过邮件的人不要再发",
  templates: [{ id: "tpl-1", name: "Welcome" }],
  events: ["signed_up"],
  history: [
    { role: "user" as const, content: "给注册 7 天没下单的用户发挽回邮件" },
    { role: "agent" as const, content: "好的，请确认优惠券来源。" },
  ],
};

describe("runJourneyAgentTurn", () => {
  it("prepends history and forces the agent tool", async () => {
    const input = {
      action: "clarify",
      message: "明白，我会把已打开邮件的人排除掉。",
      requirementUpdates: [
        { id: "req-1", text: "7 天未下单触发", status: "covered", nodeIds: ["t1"] },
      ],
    };
    const { client, calls } = mockClient([toolResponse(input)]);
    const result = await runJourneyAgentTurn(CTX, { client });

    expect(result.turn.action).toBe("clarify");
    expect(result.turn.requirements).toHaveLength(1);
    expect(calls).toHaveLength(1);
    // history (2 turns) + the fresh user message
    expect(calls[0]!.messages).toHaveLength(3);
    expect(calls[0]!.messages.at(-1)).toMatchObject({ role: "user" });
    expect(calls[0]!.tool_choice).toEqual({ type: "tool", name: AGENT_TURN_TOOL_NAME });
    expect(JSON.stringify(calls[0]!.system)).toContain("大白话");
  });

  it("guards a propose turn and normalizes requirement ids", async () => {
    const input = {
      action: "propose",
      message: "已生成 3 步计划，请查看覆盖表。",
      graph: validGraph(),
      changeSummary: "新增欢迎邮件序列",
      requirementUpdates: [
        { text: "新用户欢迎序列", status: "covered", nodeIds: ["t1", "n1", "n2", "n3"] },
      ],
    };
    const { client } = mockClient([toolResponse(input)]);
    const result = await runJourneyAgentTurn(CTX, { client });

    expect(result.turn.action).toBe("propose");
    expect(result.turn.graph?.nodes.map((n) => n.id)).toEqual(["t1", "n1", "n2", "n3"]);
    expect(result.turn.requirements[0]!.id).toBe("req-1");
  });

  it("repairs once when the proposed graph fails the graph guard", async () => {
    const bad = validGraph();
    bad.edges = bad.edges.filter((e) => e.source !== "n1");
    const good = {
      action: "propose",
      message: "修好了。",
      graph: validGraph(),
      changeSummary: "完整序列",
      requirementUpdates: [{ text: "欢迎序列", status: "covered", nodeIds: ["t1"] }],
    };
    const { client, calls } = mockClient([
      toolResponse({ ...good, graph: bad }, "toolu_1"),
      toolResponse(good, "toolu_2"),
    ]);
    const result = await runJourneyAgentTurn(CTX, { client });

    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    const repairUser = calls[1]!.messages.at(-1)!;
    const blocks = Array.isArray(repairUser.content) ? repairUser.content : [];
    const toolResult = blocks.find(
      (b): b is Anthropic.Messages.ToolResultBlockParam => b.type === "tool_result",
    );
    expect(toolResult?.is_error).toBe(true);
    expect(String(toolResult?.content)).toMatch(/no outgoing edge/);
  });

  it("repairs when requirement nodeIds are missing from the graph", async () => {
    const good = {
      action: "propose",
      message: "好的。",
      graph: validGraph(),
      changeSummary: "更新",
      requirementUpdates: [{ text: "x", status: "covered", nodeIds: ["ghost-node"] }],
    };
    const fixed = {
      ...good,
      requirementUpdates: [{ text: "x", status: "covered", nodeIds: ["n1"] }],
    };
    const { client, calls } = mockClient([
      toolResponse(good, "toolu_1"),
      toolResponse(fixed, "toolu_2"),
    ]);
    const result = await runJourneyAgentTurn(CTX, { client });

    expect(result.attempts).toBe(2);
    expect(result.turn.requirements[0]!.nodeIds).toEqual(["n1"]);
    expect(calls).toHaveLength(2);
  });

  it("throws when the model answers in prose instead of using the tool", async () => {
    const { client } = mockClient([proseResponse("我们可以这样设计……")]);
    await expect(runJourneyAgentTurn(CTX, { client })).rejects.toThrow(/did not call/);
  });
});

describe("guardJourneyAgentTurn", () => {
  it("rejects clarify node references that do not exist in the current graph", () => {
    const input = {
      action: "clarify",
      message: "好的",
      requirementUpdates: [{ text: "x", status: "covered", nodeIds: ["nope"] }],
    };
    expect(() => guardJourneyAgentTurn(input, validGraph())).toThrow(JourneyAgentError);
  });

  it("allows clarify without a reference graph", () => {
    const turn = guardJourneyAgentTurn({
      action: "clarify",
      message: "优惠券从哪来？",
      question: { text: "优惠券来源", options: ["联系人属性", "写进模板"] },
    });
    expect(turn.question?.options).toHaveLength(2);
    expect(turn.requirements).toEqual([]);
    expect(turn.templateDrafts).toEqual([]);
  });

  it("accepts templateDrafts whose keys are referenced by email nodes", () => {
    const graph = validGraph();
    (graph.nodes.find((n) => n.id === "n1")!.data as { templateId: string }).templateId =
      "draft-welcome";
    const turn = guardJourneyAgentTurn(
      {
        action: "propose",
        message: "已附上模板草稿",
        graph,
        changeSummary: "s",
        requirementUpdates: [{ text: "x", status: "covered", nodeIds: ["n1"] }],
        templateDrafts: [
          { key: "draft-welcome", name: "欢迎邮件", purpose: "新用户注册后的第一封欢迎邮件" },
        ],
      },
      null,
      ["tpl-other"],
    );
    expect(turn.templateDrafts).toHaveLength(1);
    expect(turn.templateDrafts[0]!.key).toBe("draft-welcome");
  });

  it("rejects email nodes referencing templateIds that are neither known nor drafted", () => {
    const graph = validGraph(); // n1 references "tpl-1"
    expect(() =>
      guardJourneyAgentTurn(
        {
          action: "propose",
          message: "m",
          graph,
          changeSummary: "s",
          requirementUpdates: [{ text: "x", status: "covered", nodeIds: ["n1"] }],
        },
        null,
        ["tpl-other"],
      ),
    ).toThrow(/unknown templateIds/);
  });

  it("rejects templateDrafts that no email node references", () => {
    const graph = validGraph();
    (graph.nodes.find((n) => n.id === "n1")!.data as { templateId: string }).templateId = "tpl-1";
    expect(() =>
      guardJourneyAgentTurn(
        {
          action: "propose",
          message: "m",
          graph,
          changeSummary: "s",
          requirementUpdates: [{ text: "x", status: "covered", nodeIds: ["n1"] }],
          templateDrafts: [
            { key: "draft-orphan", name: "孤儿草稿", purpose: "没有任何节点引用这个草稿模板" },
          ],
        },
        null,
        ["tpl-1"],
      ),
    ).toThrow(/unreferenced draft keys/);
  });
});
