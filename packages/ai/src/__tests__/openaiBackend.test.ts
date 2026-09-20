import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { callOpenAiForTurn, toChatMessages } from "../openaiBackend";
import type { AiConfig } from "../client";

const config: AiConfig = {
  provider: "openai",
  apiKey: "sk-test",
  baseUrl: "https://gw.example/v1/",
  model: "test-model",
  maxTokens: 8192,
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("toChatMessages", () => {
  it("maps system + plain user text", () => {
    const out = toChatMessages("sys", [{ role: "user", content: "hello" }]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
  });

  it("round-trips the repair replay: assistant tool_use -> tool_calls, tool_result -> role tool", () => {
    const toolUse = {
      type: "tool_use",
      id: "call_1",
      name: "emit_journey_graph",
      input: { nodes: [], edges: [] },
    } as unknown as Anthropic.Messages.ToolUseBlock;
    const out = toChatMessages("sys", [
      { role: "user", content: "build" },
      { role: "assistant", content: [toolUse] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            is_error: true,
            content: "bad graph",
          },
        ],
      },
    ]);
    expect(out[1]).toEqual({ role: "user", content: "build" });
    expect(out[2]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "emit_journey_graph",
            arguments: '{"nodes":[],"edges":[]}',
          },
        },
      ],
    });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "bad graph" });
  });
});

describe("callOpenAiForTurn", () => {
  it("posts to <baseUrl>/chat/completions with forced tool_choice and maps the response back", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "emit_journey_graph",
                    arguments: '{"nodes":[{"id":"t","type":"trigger"}],"edges":[]}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 111, completion_tokens: 222 },
      });
    }) as unknown as typeof fetch;

    const result = await callOpenAiForTurn({
      config,
      model: "test-model",
      system: "sys",
      messages: [{ role: "user", content: "go" }],
      toolName: "emit_journey_graph",
      toolDescription: "submit graph",
      toolParameters: { type: "object" },
      fetchImpl,
    });

    expect(capturedUrl).toBe("https://gw.example/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "emit_journey_graph" },
    });
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });

    expect(result.stopReason).toBe("tool_calls");
    expect(result.usage).toEqual({ inputTokens: 111, outputTokens: 222 });
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "call_abc",
        name: "emit_journey_graph",
        input: { nodes: [{ id: "t", type: "trigger" }], edges: [] },
      },
    ]);
  });

  it("survives unparseable tool arguments (empty input -> guard handles it)", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "emit_journey_graph", arguments: "{broken" },
                },
              ],
            },
          },
        ],
      })) as unknown as typeof fetch;
    const result = await callOpenAiForTurn({
      config,
      model: "m",
      system: "s",
      messages: [],
      toolName: "emit_journey_graph",
      toolDescription: "d",
      toolParameters: {},
      fetchImpl,
    });
    expect(result.content[0]).toMatchObject({ type: "tool_use", id: "c1", input: {} });
  });

  it("throws a descriptive error on non-2xx", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 502 })) as unknown as typeof fetch;
    await expect(
      callOpenAiForTurn({
        config,
        model: "m",
        system: "s",
        messages: [],
        toolName: "emit_journey_graph",
        toolDescription: "d",
        toolParameters: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/openai backend returned 502/);
  });
});
