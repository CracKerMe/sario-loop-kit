/**
 * Entry point: generate a guarded AI journey optimization proposal.
 * Thin shell over the shared guarded-generation loop — identical semantics
 * to journey/email/simulation generation. The artifact is a full proposed
 * JourneyGraph plus analysis; both are rebuilt inside the guard.
 */
import type { GenerateOptions, Generated } from "./pipeline";
import { runGuardedGeneration } from "./pipeline";
import {
  buildJourneyOptimizationRepairPrompt,
  buildJourneyOptimizationSystemPrompt,
  buildJourneyOptimizationUserPrompt,
  guardJourneyOptimization,
  JOURNEY_OPTIMIZATION_TOOL_NAME,
  journeyOptimizationToolParameters,
  type JourneyOptimizationInput,
  type JourneyOptimizationProposal,
} from "./journeyOptimization";

export function generateJourneyOptimization(
  input: JourneyOptimizationInput,
  options: GenerateOptions = {},
): Promise<Generated<JourneyOptimizationProposal>> {
  return runGuardedGeneration(options, {
    system: buildJourneyOptimizationSystemPrompt(),
    userPrompt: buildJourneyOptimizationUserPrompt(input),
    toolName: JOURNEY_OPTIMIZATION_TOOL_NAME,
    toolDescription: "Submit the structured optimization analysis and complete proposed graph.",
    toolParameters: journeyOptimizationToolParameters(),
    guard: guardJourneyOptimization,
    repairPrompt: buildJourneyOptimizationRepairPrompt(),
  });
}
