/**
 * The guarded generation loop — shared by every AI→artifact pipeline.
 *
 * Contract (identical for journey graphs and email content): the model is
 * forced onto one tool; its input must survive the caller's `guard`; a failed
 * guard is fed back for one repair round with the concrete issue list. There
 * is no way to get a raw model payload out of this module: refusal to use the
 * tool, or a guard that never passes, throws `AiGraphError`.
 *
 * The loop is provider-agnostic: Anthropic goes through the SDK, openai-
 * compatible gateways through the fetch backend (`openaiBackend.ts`). Tests
 * inject a pre-built client and always take the SDK path.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { AiGraphError } from "./graphGuard";
import {
  aiConfigFromEnv,
  createAiClient,
  DEFAULT_AI_MAX_TOKENS,
  DEFAULT_AI_MODEL,
  type AiConfig,
} from "./client";
import { callOpenAiForTurn } from "./openaiBackend";

export type ContentBlock = Anthropic.Messages.ContentBlock;
export type MessageParam = Anthropic.Messages.MessageParam;

export interface GenerateOptions {
  /** Pre-built client (tests inject a stub here). */
  client?: Anthropic;
  /** Config used to build a client when `client` is not provided. */
  config?: AiConfig;
  /** Override the config default model. */
  model?: string;
  /** Max guard rounds. Default 2 (initial + one repair). */
  maxAttempts?: number;
}

export interface GenerationSpec<T> {
  system: string;
  userPrompt: string;
  toolName: string;
  toolDescription: string;
  /** JSON schema for the tool's input — the guard is the authority, this is a hint. */
  toolParameters: Record<string, unknown>;
  /** The mandatory safety boundary for the model's tool input. */
  guard: (input: unknown) => T;
  /** Appended to the repair-round tool result. */
  repairPrompt: string;
}

export interface Generated<T> {
  result: T;
  model: string;
  /** Guard rounds consumed (1 = first try, 2 = after repair). */
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
}

export function extractToolInput(
  content: ContentBlock[],
  toolName: string,
): { input: unknown } | undefined {
  for (const block of content) {
    if (block.type === "tool_use" && block.name === toolName) {
      return { input: block.input };
    }
  }
  return undefined;
}

export async function runGuardedGeneration<T>(
  options: GenerateOptions,
  spec: GenerationSpec<T>,
): Promise<Generated<T>> {
  const config: AiConfig =
    options.config ??
    (options.client
      ? // Injected client (tests / caller-managed auth): no env needed.
        {
          provider: "anthropic",
          apiKey: "",
          model: options.model ?? DEFAULT_AI_MODEL,
          maxTokens: DEFAULT_AI_MAX_TOKENS,
        }
      : aiConfigFromEnv());
  const model = options.model ?? config.model;
  const maxAttempts = options.maxAttempts ?? 2;

  // Provider-neutral turn. Injected clients (tests) always take the SDK path.
  const callTurn: (ms: MessageParam[]) => Promise<{
    content: ContentBlock[];
    stopReason: string;
    usage: { inputTokens: number; outputTokens: number };
  }> =
    options.client || config.provider === "anthropic"
      ? async (ms) => {
          const client = options.client ?? createAiClient(config);
          const response = await client.messages.create({
            model,
            max_tokens: config.maxTokens,
            system: spec.system,
            messages: ms,
            tools: [
              {
                name: spec.toolName,
                description: spec.toolDescription,
                input_schema: spec.toolParameters as Anthropic.Messages.Tool.InputSchema,
              },
            ],
            // Force the tool: a prose answer is useless and would only open
            // a path where unguarded text gets parsed downstream.
            tool_choice: { type: "tool", name: spec.toolName },
          });
          return {
            content: response.content,
            stopReason: response.stop_reason ?? "unknown",
            usage: {
              inputTokens: response.usage?.input_tokens ?? 0,
              outputTokens: response.usage?.output_tokens ?? 0,
            },
          };
        }
      : (ms) =>
          callOpenAiForTurn({
            config,
            model,
            system: spec.system,
            messages: ms,
            toolName: spec.toolName,
            toolDescription: spec.toolDescription,
            toolParameters: spec.toolParameters,
          });

  const messages: MessageParam[] = [{ role: "user", content: spec.userPrompt }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const turn = await callTurn(messages);

    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;

    const toolCall = extractToolInput(turn.content, spec.toolName);
    if (!toolCall) {
      lastError = new AiGraphError(
        `model did not call the ${spec.toolName} tool (stop_reason: ${turn.stopReason})`,
      );
      break; // nothing useful to repair from — rethrow below
    }

    try {
      const result = spec.guard(toolCall.input);
      return { result, model, attempts: attempt, usage };
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      // Repair round: replay the assistant turn and return the guard
      // failures as the tool result.
      messages.push({ role: "assistant", content: turn.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: turn.content.find(
              (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
            )!.id,
            is_error: true,
            content: `${err instanceof Error ? err.message : String(err)}\n\n${spec.repairPrompt}`,
          },
        ],
      });
    }
  }

  if (lastError instanceof AiGraphError) throw lastError;
  throw new AiGraphError("generation failed", [
    lastError instanceof Error ? lastError.message : String(lastError),
  ]);
}
