import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { EMAIL_DOC_PRESETS } from "@loopkit/email-doc";
import { generateEmailContent } from "../generateEmail";
import { AiGraphError } from "../graphGuard";
import { EMAIL_TOOL_NAME } from "../emailPrompt";
import { DEFAULT_AI_MODEL } from "../client";

type CreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;

const VALID_DOC = structuredClone(EMAIL_DOC_PRESETS[0]!.doc);

function toolResponse(input: unknown, toolUseId = "toolu_1"): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "tool_use", id: toolUseId, name: EMAIL_TOOL_NAME, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 80, output_tokens: 200 },
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
  request: "Announce the v2 launch to existing customers",
  mergeTagPaths: ["contact.firstName", "contact.plan"],
};

describe("generateEmailContent", () => {
  it("returns guarded content on the first attempt and forces the tool", async () => {
    const { client, calls } = mockClient([toolResponse({ subject: "v2 is here", doc: VALID_DOC })]);
    const result = await generateEmailContent(CTX, { client });

    expect(result.attempts).toBe(1);
    expect(result.model).toBe(DEFAULT_AI_MODEL);
    expect(result.subject).toBe("v2 is here");
    expect(result.doc).toEqual(VALID_DOC);
    expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 200 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool_choice).toEqual({ type: "tool", name: EMAIL_TOOL_NAME });
    expect(calls[0]!.tools?.[0]).toMatchObject({ name: EMAIL_TOOL_NAME });
  });

  it("includes the request and the merge-tag allow-list in the prompt", async () => {
    const { client, calls } = mockClient([toolResponse({ subject: "v2 is here", doc: VALID_DOC })]);
    await generateEmailContent({ ...CTX, tone: "excited", audience: "power users" }, { client });

    const user = calls[0]!.messages[0]!;
    const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    expect(text).toContain("v2 launch");
    expect(text).toContain("contact.firstName");
    expect(text).toContain("excited");
    expect(calls[0]!.system).toContain("emailSection");
    expect(calls[0]!.system).toContain(EMAIL_TOOL_NAME);
  });

  it("feeds guard issues back for a repair round and recovers", async () => {
    const dirty = structuredClone(VALID_DOC);
    (dirty.content![0] as { content?: unknown[] }).content!.push({
      type: "evil_block",
    });
    const { client, calls } = mockClient([
      toolResponse({ subject: "v2", doc: dirty }, "toolu_1"),
      toolResponse({ subject: "v2 is here", doc: VALID_DOC }, "toolu_2"),
    ]);
    const result = await generateEmailContent(CTX, { client });

    expect(result.attempts).toBe(2);
    expect(result.subject).toBe("v2 is here");
    // The repair round carries the issue list as an errored tool_result.
    const repair = calls[1]!.messages.at(-1)!;
    const repairText = JSON.stringify(repair.content);
    expect(repairText).toContain("tool_result");
    expect(repairText).toMatch(/failed validation|evil_block/i);
    expect(calls[1]!.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("throws AiGraphError after exhausting the repair round", async () => {
    const { client } = mockClient([toolResponse({ subject: "", doc: VALID_DOC })]);
    await expect(generateEmailContent(CTX, { client })).rejects.toBeInstanceOf(AiGraphError);
  });

  it("throws AiGraphError when the model answers in prose", async () => {
    const client = {
      messages: {
        create: async () =>
          ({
            id: "msg",
            type: "message",
            role: "assistant",
            model: "m",
            content: [{ type: "text", text: "Here is your email!" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }) as unknown as Anthropic.Messages.Message,
      },
    } as unknown as Anthropic;
    await expect(generateEmailContent(CTX, { client })).rejects.toThrow(/did not call/);
  });
});
