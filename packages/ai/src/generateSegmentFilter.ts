/**
 * Entry point: natural language → guarded SegmentFilter audience draft.
 * Thin shell over the shared guarded-generation loop — identical semantics
 * to journey / email / optimization generation. The artifact is a suggested
 * name, a human summary, and the AST that @loopkit/core will compile.
 */
import type { GenerateOptions, Generated } from "./pipeline";
import { runGuardedGeneration } from "./pipeline";
import {
  buildSegmentRepairPrompt,
  buildSegmentSystemPrompt,
  buildSegmentUserPrompt,
  guardSegmentAudience,
  SEGMENT_TOOL_NAME,
  segmentToolParameters,
  type GeneratedSegmentAudience,
  type SegmentGenerationInput,
} from "./segmentFilter";

export function generateSegmentAudience(
  input: SegmentGenerationInput,
  options: GenerateOptions = {},
): Promise<Generated<GeneratedSegmentAudience>> {
  return runGuardedGeneration(options, {
    system: buildSegmentSystemPrompt(),
    userPrompt: buildSegmentUserPrompt(input),
    toolName: SEGMENT_TOOL_NAME,
    toolDescription:
      "Submit the suggested audience name, one-line summary, and complete SegmentFilter AST.",
    toolParameters: segmentToolParameters(),
    guard: guardSegmentAudience,
    repairPrompt: buildSegmentRepairPrompt(),
  });
}
