/**
 * AI provider configuration for @loopkit/ai.
 *
 * Configuration is process-env based (mirroring sendLimitsFromEnv in
 * @loopkit/email). Two providers are supported, selected by which key is
 * present (OPENAI_API_KEY wins — it is the actively used gateway path):
 *
 * - openai:    OPENAI_API_KEY + OPENAI_BASEURL (default api.openai.com/v1)
 *              + OPENAI_MODEL (required). Speaks the OpenAI chat/completions
 *              protocol via the fetch backend in openaiBackend.ts — works
 *              with any OpenAI-compatible gateway/proxy.
 * - anthropic: ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL so a
 *              gateway can be swapped in with a config-level change).
 */
import Anthropic from "@anthropic-ai/sdk";

export type AiProvider = "anthropic" | "openai";

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  /** Protocol base override — gateway/proxy swap without code touch. */
  baseUrl?: string;
  /** Default model for all AI calls in this process. */
  model: string;
  /** Max output tokens per call (anthropic path; openai path omits the cap). */
  maxTokens: number;
}

export const DEFAULT_AI_MODEL = "claude-sonnet-4-5";
export const DEFAULT_AI_MAX_TOKENS = 8192;
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Thrown when AI features are used without a usable configuration. */
export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

export function aiConfigFromEnv(source: NodeJS.ProcessEnv = process.env): AiConfig {
  const openaiKey = source.OPENAI_API_KEY;
  if (openaiKey) {
    const model = source.OPENAI_MODEL;
    if (!model) {
      throw new AiConfigError(
        "OPENAI_MODEL is required when OPENAI_API_KEY is set — there is no safe default model across gateways",
      );
    }
    const baseUrl = source.OPENAI_BASEURL || source.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL;
    return {
      provider: "openai",
      apiKey: openaiKey,
      baseUrl,
      model,
      maxTokens: Number(source.AI_MAX_TOKENS ?? "") || DEFAULT_AI_MAX_TOKENS,
    };
  }

  const apiKey = source.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiConfigError(
      "No AI provider configured — set OPENAI_API_KEY (+ OPENAI_MODEL) or ANTHROPIC_API_KEY",
    );
  }
  const baseUrl = source.ANTHROPIC_BASE_URL || undefined;
  const maxTokens = Number(source.AI_MAX_TOKENS ?? "") || DEFAULT_AI_MAX_TOKENS;
  return {
    provider: "anthropic",
    apiKey,
    baseUrl,
    model: source.AI_MODEL || DEFAULT_AI_MODEL,
    maxTokens,
  };
}

/** Build the Anthropic SDK client. Only valid for the anthropic provider. */
export function createAiClient(config: AiConfig): Anthropic {
  if (config.provider !== "anthropic") {
    throw new AiConfigError(
      "createAiClient is only for the anthropic provider — openai uses the fetch backend",
    );
  }
  return new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });
}
