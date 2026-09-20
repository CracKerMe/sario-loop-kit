import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AiGraphError } from "../graphGuard";
import { generateSegmentAudience } from "../generateSegmentFilter";
import { SEGMENT_TOOL_NAME, buildSegmentUserPrompt, guardSegmentAudience } from "../segmentFilter";

type CreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;

const VALID = {
  name: "上月活跃未付费",
  summary: "最近 30 天有过打开邮件，但从未完成下单的联系人。",
  filter: {
    op: "and",
    children: [
      { kind: "event", name: "email.opened", occurred: true, withinDays: 30 },
      { kind: "event", name: "order.placed", occurred: false },
    ],
  },
};

function toolResponse(input: unknown, toolUseId = "toolu_seg"): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "tool_use", id: toolUseId, name: SEGMENT_TOOL_NAME, input }],
    stop_reason: "tool_use",
    sequence: null,
    usage: { input_tokens: 40, output_tokens: 20 },
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
  request: "上月活跃但未付费的用户",
  propertyKeys: ["plan", "company"],
  events: ["email.opened", "order.placed"],
  today: "2026-02-18",
  language: "简体中文",
};

describe("guardSegmentAudience", () => {
  it("accepts a valid and-group of event conditions", () => {
    const result = guardSegmentAudience(VALID);
    expect(result.name).toBe("上月活跃未付费");
    expect(result.filter).toMatchObject({ op: "and" });
  });

  it("strips unknown keys on condition leaves", () => {
    const result = guardSegmentAudience({
      name: "Pro plan",
      summary: "plan is pro",
      filter: {
        kind: "condition",
        field: "property.plan",
        operator: "eq",
        value: "pro",
        evil: "process.exit(1)",
      },
    });
    expect(result.filter).toEqual({
      kind: "condition",
      field: "property.plan",
      operator: "eq",
      value: "pro",
    });
    expect("evil" in result.filter).toBe(false);
  });

  it("rejects unknown contact fields", () => {
    expect(() =>
      guardSegmentAudience({
        name: "x",
        summary: "y",
        filter: { kind: "condition", field: "ssn", operator: "eq", value: "1" },
      }),
    ).toThrow(AiGraphError);
  });

  it("rejects ordering operators on boolean subscribed", () => {
    expect(() =>
      guardSegmentAudience({
        name: "x",
        summary: "y",
        filter: { kind: "condition", field: "subscribed", operator: "gt", value: 1 },
      }),
    ).toThrow(AiGraphError);
  });

  it("rejects valued operators without a value", () => {
    expect(() =>
      guardSegmentAudience({
        name: "x",
        summary: "y",
        filter: { kind: "condition", field: "email", operator: "contains" },
      }),
    ).toThrow(AiGraphError);
  });

  it("rejects non-array values for in/not_in", () => {
    expect(() =>
      guardSegmentAudience({
        name: "x",
        summary: "y",
        filter: { kind: "condition", field: "property.plan", operator: "in", value: "pro" },
      }),
    ).toThrow(AiGraphError);
  });

  it("rejects empty and/or groups", () => {
    expect(() =>
      guardSegmentAudience({
        name: "x",
        summary: "y",
        filter: { op: "and", children: [] },
      }),
    ).toThrow(AiGraphError);
  });

  it("rejects nesting deeper than MAX_SEGMENT_DEPTH", () => {
    let node: unknown = { kind: "event", name: "e", occurred: true };
    for (let i = 0; i < 12; i++) node = { op: "and", children: [node] };
    expect(() => guardSegmentAudience({ name: "x", summary: "y", filter: node })).toThrow(
      AiGraphError,
    );
  });

  it("accepts a nested not over an event (advanced filter)", () => {
    const result = guardSegmentAudience({
      name: "未下单",
      summary: "从未下单",
      filter: {
        op: "not",
        child: { kind: "event", name: "order.placed", occurred: true },
      },
    });
    expect(result.filter).toEqual({
      op: "not",
      child: { kind: "event", name: "order.placed", occurred: true },
    });
  });

  it("rejects a payload that is not an object", () => {
    expect(() => guardSegmentAudience(null)).toThrow(AiGraphError);
    expect(() => guardSegmentAudience(42)).toThrow(AiGraphError);
  });
});

describe("generateSegmentAudience", () => {
  it("returns a guarded audience on the first attempt", async () => {
    const { client, calls } = mockClient([toolResponse(VALID)]);
    const result = await generateSegmentAudience(CTX, { client });
    expect(result.attempts).toBe(1);
    expect(result.result.name).toBe("上月活跃未付费");
    expect(result.result.filter).toMatchObject({ op: "and" });
    expect(calls[0]!.tool_choice).toEqual({ type: "tool", name: SEGMENT_TOOL_NAME });
  });

  it("feeds property keys, events and today into the user prompt", async () => {
    const { client, calls } = mockClient([toolResponse(VALID)]);
    await generateSegmentAudience(CTX, { client });
    const user = calls[0]!.messages[0]!;
    const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    expect(text).toContain("上月活跃但未付费的用户");
    expect(text).toContain("2026-02-18");
    expect(text).toContain("plan");
    expect(text).toContain("order.placed");
    expect(text).toContain("简体中文");
  });

  it("repairs once when the first payload fails the guard", async () => {
    const bad = {
      name: "x",
      summary: "y",
      filter: { kind: "condition", field: "ssn", operator: "eq", value: "1" },
    };
    const { client, calls } = mockClient([toolResponse(bad), toolResponse(VALID)]);
    const result = await generateSegmentAudience(CTX, { client });
    expect(result.attempts).toBe(2);
    expect(result.result.name).toBe("上月活跃未付费");
    expect(calls).toHaveLength(2);
  });

  it("throws when the model refuses the tool", async () => {
    const { client } = mockClient([
      {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "I cannot help with that." }],
        stop_reason: "end_turn",
        sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      } as unknown as Anthropic.Messages.Message,
    ]);
    await expect(generateSegmentAudience(CTX, { client })).rejects.toThrow(AiGraphError);
  });
});

describe("buildSegmentUserPrompt", () => {
  it("notes when no property keys or events were observed", () => {
    const text = buildSegmentUserPrompt({ request: "所有联系人" });
    expect(text).toContain("No property keys were observed");
    expect(text).toContain("No event names were observed");
  });
});
