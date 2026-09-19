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
 * second top-level call site. The loop itself lives in `pipeline.ts` and
 * is shared with the email-content generator.
 */
import type { JourneyGraph } from "@loopkit/journey";
import { guardAiGraph } from "./graphGuard";
import {
  GRAPH_TOOL_NAME,
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  journeyToolSchema,
  type JourneyGenerationContext,
} from "./prompt";
import { runGuardedGeneration, type GenerateOptions } from "./pipeline";

export interface GeneratedJourney {
  graph: JourneyGraph;
  model: string;
  /** Guard rounds consumed (1 = first try, 2 = after repair). */
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
}

export type GenerateJourneyOptions = GenerateOptions;

export async function generateJourneyGraph(
  ctx: JourneyGenerationContext,
  options: GenerateJourneyOptions = {},
): Promise<GeneratedJourney> {
  const generated = await runGuardedGeneration(options, {
    system: buildSystemPrompt(),
    userPrompt: buildUserPrompt(ctx),
    toolName: GRAPH_TOOL_NAME,
    toolDescription: "Submit the complete journey graph for the user's request.",
    toolParameters: journeyToolSchema(),
    guard: guardAiGraph,
    repairPrompt: buildRepairPrompt(""),
  });

  const { result, model, attempts, usage } = generated;
  return { graph: result, model, attempts, usage };
}
