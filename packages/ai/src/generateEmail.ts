/**
 * generateEmailContent — the only AI → email content pipeline.
 *
 * Contract: the returned `{subject, doc}` has already passed guardEmailContent
 * (subject checks + @loopkit/email-doc's closed-set validator). No raw model
 * payload escapes: refusal to call the tool or a guard that never passes
 * throws AiGraphError. The repair round, provider selection and usage
 * accounting live in the shared `pipeline.ts`.
 */
import {
  buildEmailRepairPrompt,
  buildEmailSystemPrompt,
  buildEmailUserPrompt,
  EMAIL_TOOL_NAME,
  type EmailGenerationContext,
} from "./emailPrompt";
import { guardEmailContent, type GeneratedEmailContent } from "./emailGuard";
import { runGuardedGeneration, type GenerateOptions } from "./pipeline";

export type { GeneratedEmailContent };

export interface GeneratedEmail {
  subject: string;
  doc: GeneratedEmailContent["doc"];
  model: string;
  /** Guard rounds consumed (1 = first try, 2 = after repair). */
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
}

export type GenerateEmailOptions = GenerateOptions;

export async function generateEmailContent(
  ctx: EmailGenerationContext,
  options: GenerateEmailOptions = {},
): Promise<GeneratedEmail> {
  const { result, model, attempts, usage } = await runGuardedGeneration(options, {
    system: buildEmailSystemPrompt(),
    userPrompt: buildEmailUserPrompt(ctx),
    toolName: EMAIL_TOOL_NAME,
    toolDescription: "Submit the complete email subject and document for the user's request.",
    toolParameters: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "doc"],
      properties: {
        subject: {
          type: "string",
          description:
            "The email subject line. Under 60 characters. May contain {{path}} merge tags.",
        },
        doc: {
          type: "object",
          description: "ProseMirror JSON document — closed block set, see the system prompt.",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["doc"] },
            content: { type: "array" },
          },
        },
      },
    },
    guard: guardEmailContent,
    repairPrompt: buildEmailRepairPrompt(),
  });

  return { subject: result.subject, doc: result.doc, model, attempts, usage };
}
