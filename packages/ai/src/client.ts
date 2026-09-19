/**
 * Anthropic client + configuration for @loopkit/ai.
 *
 * Configuration is process-env based (mirroring sendLimitsFromEnv in
 * @loopkit/email): ANTHROPIC_API_KEY is required, ANTHROPIC_BASE_URL is
 * optional so a proxy/gateway (e.g. an agentrouter endpoint) can be
 * swapped in with a config-level change — no code touch.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface AiConfig {
  apiKey: string;
  /** Optional OpenAI-style override — e.g. a gateway/proxy base URL. */
  baseUrl?: string;
  /** Default model for all AI calls in this process. */
  model: string;
  /** Max output tokens per call. */
  maxTokens: number;
}

export const DEFAULT_AI_MODEL = "claude-sonnet-4-5";
export const DEFAULT_AI_MAX_TOKENS = 8192;

/** Thrown when AI features are used without a usable configuration. */
export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

export function aiConfigFromEnv(source: NodeJS.ProcessEnv = process.env): AiConfig {
  const apiKey = source.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiConfigError(
      "ANTHROPIC_API_KEY is not set — AI features are unavailable until it is configured",
    );
  }
  const baseUrl = source.ANTHROPIC_BASE_URL || undefined;
  const maxTokens = Number(source.AI_MAX_TOKENS ?? "") || DEFAULT_AI_MAX_TOKENS;
  return {
    apiKey,
    baseUrl,
    model: source.AI_MODEL || DEFAULT_AI_MODEL,
    maxTokens,
  };
}

export function createAiClient(config: AiConfig): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });
}
