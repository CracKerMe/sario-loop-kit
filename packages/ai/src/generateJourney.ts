/**
 * generateJourneyGraph — the only AI → JourneyGraph pipeline.
 *
 * Contract: the returned graph has already passed guardAiGraph() (zod
 * structure + assertWhitelistedGraph + validateGraph). There is no way to
 * get a raw model payload out of this module: if the model refuses to use
 * the forced tool, or the graph fails the guard after the repair round,
 * the call throws.
 *
 * One repair round is built in: a failed guard is fed back to the model
 * as a tool_result with the concrete issue list, which fixes the usual
 * long tail (a missing branch edge, a hallucinated templateId) without a
 * second top-level call site.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { JourneyGraph } from "@loopkit/journey";
import { AiGraphError, guardAiGraph } from "./graphGuard";
import {
  GRAPH_TOOL_NAME,
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  journeyToolSchema,
  type JourneyGenerationContext,
} from "./prompt";
import {
  aiConfigFromEnv,
  createAiClient,
  DEFAULT_AI_MAX_TOKENS,
  DEFAULT_AI_MODEL,
  type AiConfig,
} from "./client";

export interface GeneratedJourney {
  graph: JourneyGraph;
  model: string;
  /** Guard rounds consumed (1 = first try, 2 = after repair). */
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface GenerateJourneyOptions {
  /** Pre-built client (tests inject a stub here). */
  client?: Anthropic;
  /** Config used to build a client when `client` is not provided. */
  config?: AiConfig;
  /** Override the config default model. */
  model?: string;
  /** Max guard rounds. Default 2 (initial + one repair). */
  maxAttempts?: number;
}

type ContentBlock = Anthropic.Messages.ContentBlock;
type MessageParam = Anthropic.Messages.MessageParam;

function extractToolInput(content: ContentBlock[]): { input: unknown } | undefined {
  for (const block of content) {
    if (block.type === "tool_use" && block.name === GRAPH_TOOL_NAME) {
      return { input: block.input };
    }
  }
  return undefined;
}

export async function generateJourneyGraph(
  ctx: JourneyGenerationContext,
  options: GenerateJourneyOptions = {},
): Promise<GeneratedJourney> {
  const config: AiConfig =
    options.config ??
    (options.client
      ? // Injected client (tests / caller-managed auth): no env needed.
        { apiKey: "", model: options.model ?? DEFAULT_AI_MODEL, maxTokens: DEFAULT_AI_MAX_TOKENS }
      : aiConfigFromEnv());
  const client = options.client ?? createAiClient(config);
  const model = options.model ?? config.model;
  const maxAttempts = options.maxAttempts ?? 2;

  const system = buildSystemPrompt();
  const tools: Anthropic.Messages.Tool[] = [
    {
      name: GRAPH_TOOL_NAME,
      description: "Submit the complete journey graph for the user's request.",
      input_schema: journeyToolSchema() as Anthropic.Messages.Tool.InputSchema,
    },
  ];

  const messages: MessageParam[] = [{ role: "user", content: buildUserPrompt(ctx) }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await client.messages.create({
      model,
      max_tokens: config.maxTokens,
      system,
      messages,
      tools,
      // Force the graph tool: a prose answer is useless and would only
      // open a path where unguarded text gets parsed downstream.
      tool_choice: { type: "tool", name: GRAPH_TOOL_NAME },
    });

    usage.inputTokens += response.usage?.input_tokens ?? 0;
    usage.outputTokens += response.usage?.output_tokens ?? 0;

    const toolCall = extractToolInput(response.content);
    if (!toolCall) {
      lastError = new AiGraphError(
        `model did not call the ${GRAPH_TOOL_NAME} tool (stop_reason: ${response.stop_reason})`,
      );
      break; // nothing useful to repair from — rethrow below
    }

    try {
      const graph = guardAiGraph(toolCall.input);
      return { graph, model, attempts: attempt, usage };
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      // Repair round: replay the assistant turn and return the guard
      // failures as the tool result.
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: response.content.find(
              (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
            )!.id,
            is_error: true,
            content: `${err instanceof Error ? err.message : String(err)}\n\n${buildRepairPrompt("")}`,
          },
        ],
      });
    }
  }

  if (lastError instanceof AiGraphError) throw lastError;
  throw new AiGraphError("journey generation failed", [
    lastError instanceof Error ? lastError.message : String(lastError),
  ]);
}
