import type { GenerateOptions, Generated } from "./pipeline";
import { runGuardedGeneration } from "./pipeline";
import {
  buildJourneyExplanationSystemPrompt,
  buildJourneyExplanationUserPrompt,
  guardJourneyExplanation,
  journeyExplanationToolParameters,
  type JourneyExplanation,
  type JourneyExplanationInput,
} from "./journeyExplanation";

const TOOL_NAME = "emit_journey_explanation";
const REPAIR_PROMPT =
  "Your explanation did not pass validation. Fix every listed issue and call emit_journey_explanation again with the complete corrected explanation.";

export function generateJourneyExplanation(
  input: JourneyExplanationInput,
  options: GenerateOptions = {},
): Promise<Generated<JourneyExplanation>> {
  return runGuardedGeneration(options, {
    system: buildJourneyExplanationSystemPrompt(),
    userPrompt: buildJourneyExplanationUserPrompt(input),
    toolName: TOOL_NAME,
    toolDescription: "Submit a complete plain-language explanation of the configured journey.",
    toolParameters: journeyExplanationToolParameters(),
    guard: guardJourneyExplanation,
    repairPrompt: REPAIR_PROMPT,
  });
}

export { TOOL_NAME as JOURNEY_EXPLANATION_TOOL_NAME };
