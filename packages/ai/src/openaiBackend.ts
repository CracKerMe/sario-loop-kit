/**
 * OpenAI-compatible chat/completions backend for journey generation.
 *
 * Speaks the OpenAI chat protocol with plain fetch (no SDK dependency) and
 * translates to/from the Anthropic message shape the generation loop uses
 * internally. Translation is stateless: the full message list is converted
 * on every call, so the repair-round replay (assistant tool_use followed by
 * a user tool_result) round-trips without the loop knowing the provider.
 *
 * `max_tokens` is intentionally omitted: newer OpenAI models reject
 * `max_tokens` in favor of `max_completion_tokens`, and older gateways
 * reject the latter — the least surprising thing is to not cap output.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { GRAPH_TOOL_NAME } from "./prompt";
import type { AiConfig } from "./client";

type ContentBlock = Anthropic.Messages.ContentBlock;
type MessageParam = Anthropic.Messages.MessageParam;

/**
 * Blocks the generation loop actually produces/consumes. The SDK's
 * ContentBlock union excludes tool_result (it lives on the user-message
 * variant), so the loop-side union is declared structurally here.
 */
type LoopBlock =
  | ContentBlock
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: string; text?: string }> | null;
    };

export interface OpenAiTurnOptions {
  config: AiConfig;
  model: string;
  system: string;
  messages: MessageParam[];
  /** The forced tool description / JSON schema. */
  toolDescription: string;
  toolParameters: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

export interface OpenAiTurnResult {
  content: ContentBlock[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Convert internal Anthropic-shaped messages to OpenAI chat messages. */
export function toChatMessages(
  system: string,
  messages: MessageParam[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    const texts: string[] = [];
    const toolCalls: ChatToolCall[] = [];
    const toolResults: Record<string, unknown>[] = [];
    for (const block of message.content as unknown as LoopBlock[]) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else if (block.type === "tool_result") {
        const text =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
              : "";
        toolResults.push({ role: "tool", tool_call_id: block.tool_use_id, content: text });
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }
    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: texts.length > 0 ? texts.join("\n") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      if (texts.length > 0) out.push({ role: "user", content: texts.join("\n") });
      out.push(...toolResults);
    }
  }
  return out;
}

/** Map an OpenAI chat completion message back to Anthropic content blocks. */
function toContentBlocks(message: {
  content?: string | null;
  tool_calls?: ChatToolCall[];
}): ContentBlock[] {
  if (message.tool_calls && message.tool_calls.length > 0) {
    return message.tool_calls.map((call, i): ContentBlock => {
      if (call.type !== "function" || call.function?.name !== GRAPH_TOOL_NAME) {
        // A wrong-tool call will simply not match extractToolInput and the
        // loop treats the turn as "did not call the tool".
        return {
          type: "text",
          text: `ignored tool call: ${call.function?.name ?? call.type ?? "?"}`,
        } as unknown as ContentBlock;
      }
      let input: unknown = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        // Unparseable arguments -> empty input -> the guard produces a
        // concrete issue list, which feeds the standard repair round.
        input = {};
      }
      return {
        type: "tool_use",
        id: call.id ?? `call_${i}`,
        name: GRAPH_TOOL_NAME,
        input,
      } as unknown as ContentBlock;
    });
  }
  return [{ type: "text", text: message.content ?? "" } as unknown as ContentBlock];
}

export async function callOpenAiForTurn(options: OpenAiTurnOptions): Promise<OpenAiTurnResult> {
  const { config, model, system, messages, toolDescription, toolParameters } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_OPENAI_BASE_URL_PLACEHOLDER).replace(/\/+$/, "");

  const body = {
    model,
    messages: toChatMessages(system, messages),
    tools: [
      {
        type: "function",
        function: {
          name: GRAPH_TOOL_NAME,
          description: toolDescription,
          parameters: toolParameters,
        },
      },
    ],
    // Force the graph tool: a prose answer is useless and would only open a
    // path where unguarded text gets parsed downstream.
    tool_choice: { type: "function", function: { name: GRAPH_TOOL_NAME } },
  };

  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `openai backend returned ${response.status}: ${text.slice(0, 500) || response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: ChatToolCall[] };
      finish_reason?: string;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new Error("openai backend returned no choices");
  }

  return {
    content: toContentBlocks(choice.message),
    stopReason: choice.finish_reason ?? "unknown",
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

const DEFAULT_OPENAI_BASE_URL_PLACEHOLDER = "https://api.openai.com/v1";
