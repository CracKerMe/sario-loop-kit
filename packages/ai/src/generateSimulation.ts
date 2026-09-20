/**
 * Entry point: generate a guarded AI interpretation of a cohort simulation.
 * Thin shell over the shared guarded-generation loop — identical semantics
 * to journey/email generation (forced tool, one repair round, AiGraphError
 * on refusal), only the artifact and its guard differ.
 */
import type { GenerateOptions, Generated } from "./pipeline";
import { runGuardedGeneration } from "./pipeline";
import {
  buildSimulationSystemPrompt,
  buildSimulationUserPrompt,
  guardSimulationInsight,
  SIMULATION_INSIGHT_TOOL_NAME,
  simulationInsightToolParameters,
  type SimulationInsight,
  type SimulationInsightInput,
} from "./simulationInsight";

const REPAIR_PROMPT =
  "Your tool call did not pass validation. Fix every listed issue and call emit_simulation_insight again with the complete corrected insight.";

export function generateSimulationInsight(
  input: SimulationInsightInput,
  options: GenerateOptions = {},
): Promise<Generated<SimulationInsight>> {
  return runGuardedGeneration(options, {
    system: buildSimulationSystemPrompt(),
    userPrompt: buildSimulationUserPrompt(input),
    toolName: SIMULATION_INSIGHT_TOOL_NAME,
    toolDescription: "Submit the structured interpretation of the cohort simulation.",
    toolParameters: simulationInsightToolParameters(),
    guard: guardSimulationInsight,
    repairPrompt: REPAIR_PROMPT,
  });
}
