import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import {
  SETTINGS_AGENT_TOOL_NAME,
  guardSettingsAgentTurn,
  runSettingsAgentTurn,
  SettingsAgentError,
} from "../settingsAgent";

type CreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;

function toolResponse(input: unknown, toolUseId = "toolu_1"): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "tool_use", id: toolUseId, name: SETTINGS_AGENT_TOOL_NAME, input }],
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

const SNAPSHOT = {
  domains: [
    { id: "d1", domain: "mail.acme.com", status: "verified", fromEmail: "hello@mail.acme.com" },
  ],
  topics: [
    {
      id: "t1",
      key: "product-updates",
      name: "产品更新",
      category: "product",
      active: true,
      sortOrder: 0,
    },
  ],
  rules: [
    {
      id: "r1",
      name: "Pro plan fit",
      kind: "property",
      propertyKey: "plan",
      operator: "eq",
      propertyValue: "pro",
      points: 10,
      active: true,
    },
  ],
  channels: [{ channel: "email", provider: "console", status: "enabled", name: "email" }],
};

const CTX = {
  workspaceName: "Acme",
  brief: "把发信域名配好，再加几条评分规则",
  requirements: [],
  userMessage: "加一条：访问过定价页加 15 分",
  configSnapshot: SNAPSHOT,
  history: [
    { role: "user" as const, content: "把发信域名配好" },
    { role: "agent" as const, content: "好的，域名已经可以提案。" },
  ],
};

const PROPOSE = {
  action: "propose",
  message: "已生成配置变更提案。",
  changes: [
    {
      ref: "page-pricing",
      kind: "upsert_rule",
      name: "定价页访问",
      ruleKind: "page",
      pathContains: "/pricing",
      points: 15,
      active: true,
    },
  ],
  changeSummary: "新增一条页面意图评分规则",
  risks: [],
  requirementUpdates: [
    { id: "req-1", text: "访问定价页加 15 分", status: "covered", changeRefs: ["page-pricing"] },
  ],
};

describe("runSettingsAgentTurn", () => {
  it("prepends history and forces the agent tool", async () => {
    const input = {
      action: "clarify",
      message: "评分里要包含打开邮件吗？",
      question: { text: "是否统计邮件行为", options: ["要", "不用"] },
    };
    const { client, calls } = mockClient([toolResponse(input)]);
    const result = await runSettingsAgentTurn(CTX, { client });

    expect(result.turn.action).toBe("clarify");
    expect(result.turn.requirements).toEqual([]);
    expect(result.turn.changes).toEqual([]);
    expect(calls).toHaveLength(1);
    // history (2 turns) + the fresh user message
    expect(calls[0]!.messages).toHaveLength(3);
    expect(calls[0]!.messages.at(-1)).toMatchObject({ role: "user" });
    expect(calls[0]!.tool_choice).toEqual({ type: "tool", name: SETTINGS_AGENT_TOOL_NAME });
    expect(JSON.stringify(calls[0]!.system)).toContain("大白话");
    // the guard state is derived from the snapshot
    const system = String(calls[0]!.system);
    expect(system).toContain("add_domain");
  });

  it("guards a propose turn and normalizes requirement ids", async () => {
    const input = {
      ...PROPOSE,
      requirementUpdates: [
        { text: "访问定价页加 15 分", status: "covered", changeRefs: ["page-pricing"] },
      ],
    };
    const { client } = mockClient([toolResponse(input)]);
    const result = await runSettingsAgentTurn(CTX, { client });

    expect(result.turn.action).toBe("propose");
    expect(result.turn.changes).toHaveLength(1);
    expect(result.turn.requirements[0]!.id).toBe("req-1");
  });

  it("repairs once when the proposal fails the guard, then succeeds", async () => {
    const bad = {
      ...PROPOSE,
      changes: [
        {
          ref: "page-pricing",
          kind: "upsert_rule",
          name: "定价页访问",
          ruleKind: "page",
          points: 15,
        },
      ],
    };
    const { client, calls } = mockClient([
      toolResponse(bad, "toolu_1"),
      toolResponse(PROPOSE, "toolu_2"),
    ]);
    const result = await runSettingsAgentTurn(CTX, { client });

    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    const repairUser = calls[1]!.messages.at(-1)!;
    const blocks = Array.isArray(repairUser.content) ? repairUser.content : [];
    const toolResult = blocks.find(
      (b): b is Anthropic.Messages.ToolResultBlockParam => b.type === "tool_result",
    );
    expect(toolResult?.is_error).toBe(true);
    expect(String(toolResult?.content)).toMatch(/page rules require pathContains/);
  });

  it("repairs when delete_rule references an unknown rule id", async () => {
    const bad = {
      action: "propose",
      message: "m",
      changes: [{ ref: "drop-old", kind: "delete_rule", ruleId: "ghost", reason: "不再需要" }],
      changeSummary: "s",
      risks: [],
      requirementUpdates: [{ text: "删掉旧规则", status: "covered", changeRefs: ["drop-old"] }],
    };
    const fixed = { ...bad, changes: [{ ...bad.changes[0]!, ruleId: "r1" }] };
    const { client, calls } = mockClient([
      toolResponse(bad, "toolu_1"),
      toolResponse(fixed, "toolu_2"),
    ]);
    const result = await runSettingsAgentTurn(CTX, { client });
    expect(result.attempts).toBe(2);
    expect((result.turn.changes[0] as { ruleId: string }).ruleId).toBe("r1");
    expect(calls).toHaveLength(2);
  });

  it("repairs when add_domain duplicates an existing domain", async () => {
    const bad = {
      action: "propose",
      message: "m",
      changes: [{ ref: "domain-mail", kind: "add_domain", domain: "mail.acme.com" }],
      changeSummary: "s",
      risks: [],
      requirementUpdates: [{ text: "x", status: "covered", changeRefs: ["domain-mail"] }],
    };
    const fixed = {
      ...bad,
      changes: [{ ref: "domain-mail", kind: "add_domain", domain: "notify.acme.com" }],
    };
    const { client } = mockClient([toolResponse(bad, "toolu_1"), toolResponse(fixed, "toolu_2")]);
    const result = await runSettingsAgentTurn(CTX, { client });
    expect(result.attempts).toBe(2);
    expect((result.turn.changes[0] as { domain: string }).domain).toBe("notify.acme.com");
  });

  it("throws when the model answers in prose instead of using the tool", async () => {
    const { client } = mockClient([proseResponse("可以这样配置……")]);
    await expect(runSettingsAgentTurn(CTX, { client })).rejects.toThrow(/did not call/);
  });
});

describe("guardSettingsAgentTurn", () => {
  it("rejects clarify turns that reference change refs", () => {
    const input = {
      action: "clarify",
      message: "好的",
      requirementUpdates: [{ text: "x", status: "covered", changeRefs: ["nope"] }],
    };
    expect(() => guardSettingsAgentTurn(input)).toThrow(/cannot reference proposal changes/);
  });

  it("rejects requirement changeRefs missing from the proposal", () => {
    const input = {
      ...PROPOSE,
      requirementUpdates: [{ text: "x", status: "covered", changeRefs: ["ghost-ref"] }],
    };
    expect(() => guardSettingsAgentTurn(input)).toThrow(/missing from the proposal/);
  });

  it("rejects duplicate change refs", () => {
    const input = {
      ...PROPOSE,
      changes: [PROPOSE.changes[0], { ...PROPOSE.changes[0]! }],
    };
    expect(() => guardSettingsAgentTurn(input)).toThrow(/duplicate change ref/);
  });

  it("rejects property rules missing the operator", () => {
    const input = {
      action: "propose",
      message: "m",
      changes: [
        {
          ref: "pro-fit",
          kind: "upsert_rule",
          name: "Pro fit",
          ruleKind: "property",
          propertyKey: "plan",
          points: 10,
        },
      ],
      changeSummary: "s",
      risks: [],
      requirementUpdates: [{ text: "x", status: "covered", changeRefs: ["pro-fit"] }],
    };
    expect(() => guardSettingsAgentTurn(input)).toThrow(/require operator/);
  });

  it("rejects property rules with a comparison operator but no value", () => {
    const input = {
      action: "propose",
      message: "m",
      changes: [
        {
          ref: "pro-fit",
          kind: "upsert_rule",
          name: "Pro fit",
          ruleKind: "property",
          propertyKey: "plan",
          operator: "eq",
          points: 10,
        },
      ],
      changeSummary: "s",
      risks: [],
      requirementUpdates: [{ text: "x", status: "covered", changeRefs: ["pro-fit"] }],
    };
    expect(() => guardSettingsAgentTurn(input)).toThrow(/requires propertyValue/);
  });

  it("allows exists/missing operators without a value", () => {
    const input = {
      action: "propose",
      message: "m",
      changes: [
        {
          ref: "has-phone",
          kind: "upsert_rule",
          name: "有手机号",
          ruleKind: "property",
          propertyKey: "phone",
          operator: "exists",
          points: 5,
        },
      ],
      changeSummary: "s",
      risks: [],
      requirementUpdates: [{ text: "x", status: "covered", changeRefs: ["has-phone"] }],
    };
    const turn = guardSettingsAgentTurn(input);
    expect(turn.changes).toHaveLength(1);
  });

  it("rejects out-of-range points and malformed domains and topic keys", () => {
    const base = {
      action: "propose" as const,
      message: "m",
      changeSummary: "s",
      risks: [] as string[],
      requirementUpdates: [{ text: "x", status: "covered" as const, changeRefs: ["a"] }],
    };
    expect(() =>
      guardSettingsAgentTurn({
        ...base,
        changes: [
          {
            ref: "a",
            kind: "upsert_rule",
            name: "n",
            ruleKind: "page",
            pathContains: "/p",
            points: 500,
          },
        ],
      }),
    ).toThrow(SettingsAgentError);
    expect(() =>
      guardSettingsAgentTurn({
        ...base,
        changes: [{ ref: "a", kind: "add_domain", domain: "not a domain" }],
      }),
    ).toThrow(SettingsAgentError);
    expect(() =>
      guardSettingsAgentTurn({
        ...base,
        changes: [
          { ref: "a", kind: "upsert_topic", key: "Bad Key!", name: "n", category: "marketing" },
        ],
      }),
    ).toThrow(SettingsAgentError);
  });

  it("normalizes requirement ids and passes a valid proposal through", () => {
    const turn = guardSettingsAgentTurn({
      ...PROPOSE,
      requirementUpdates: [
        { text: "访问定价页加 15 分", status: "covered", changeRefs: ["page-pricing"] },
      ],
    });
    expect(turn.requirements[0]!.id).toBe("req-1");
    expect(turn.requirements[0]!.changeRefs).toEqual(["page-pricing"]);
  });
});
