/**
 * Prompts for the email content generator.
 *
 * The block reference is **generated from `EMAIL_BLOCKS`** — the same closed
 * catalogue the editor palette and the server renderer are driven by — so the
 * prompt cannot drift from what the validator actually accepts. The guard
 * (`emailGuard.ts`, on top of @loopkit/email-doc's validator) remains the
 * authority; the prompt only steers.
 */
import { EMAIL_BLOCKS } from "@loopkit/email-doc";

export const EMAIL_TOOL_NAME = "emit_email_content";

export interface EmailGenerationContext {
  /** What the email is for, in the user's own words. */
  request: string;
  /**
   * Merge-tag paths the model may use in `emailMergeTag` chips and in the
   * subject. Gathered server-side from observed contact properties — the
   * model must not invent paths (they render literally if unknown).
   */
  mergeTagPaths: string[];
  /** Optional voice hint. */
  tone?: string;
  /** Optional audience hint. */
  audience?: string;
}

function blockReference(): string {
  const lines = EMAIL_BLOCKS.map((b) => {
    const attrs = Object.entries(b.attrs)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    const kind =
      b.kind === "container"
        ? "container (holds other blocks)"
        : b.kind === "inline"
          ? "inline (lives inside paragraph/button text)"
          : "leaf";
    return `- ${b.type} (${kind}, attrs: ${attrs}) — ${b.description}`;
  });
  return lines.join("\n");
}

export function buildEmailSystemPrompt(): string {
  return `You are an email marketing copywriter that outputs structured documents for a campaign platform.

You MUST call the ${EMAIL_TOOL_NAME} tool with the complete email content. Never answer in prose.

## Document format

The \`doc\` field is a ProseMirror JSON document. Root: {"type":"doc","content":[...]}.
Only these block types exist — anything else is rejected:

${blockReference()}

Text runs inside emailParagraph/emailButton carry optional marks: bold, italic, underline, and link (mark attrs: {href: "https://..."}). A textColour mark (textStyle) accepts {color: "#rrggbb"} or null.
A personalisation chip is an inline node: {"type":"emailMergeTag","attrs":{"path":"contact.firstName"}}.

## Hard rules

1. Wrap the visible content in one or more \`emailSection\` containers.
2. Use ONLY the merge-tag paths listed in the request context, verbatim. A path that was not provided renders as literal text in real emails.
3. Do NOT use \`emailImage\` unless the user explicitly supplied an absolute http(s) URL for it (the validator requires one).
4. \`emailButton\` needs a non-empty text label and an absolute href (https://...). Never invent tracking links — use a placeholder the user will replace, and say so in the request summary if you do.
5. Keep the subject under 60 characters. It may contain {{path}} merge tags (plain text form).
6. Write real, finished copy — never lorem ipsum or "your text here".
7. The document is a 600px-wide single column email: short paragraphs, clear hierarchy, one primary call to action.`;
}

export function buildEmailUserPrompt(ctx: EmailGenerationContext): string {
  const parts = [`Request: ${ctx.request}`];
  if (ctx.tone) parts.push(`Tone: ${ctx.tone}`);
  if (ctx.audience) parts.push(`Audience: ${ctx.audience}`);
  parts.push(
    `Merge-tag paths you may use (verbatim, nothing else): ${
      ctx.mergeTagPaths.length > 0
        ? ctx.mergeTagPaths.join(", ")
        : "(none — write without personalisation)"
    }`,
  );
  return parts.join("\n");
}

export function buildEmailRepairPrompt(): string {
  return `Fix every listed issue and call ${EMAIL_TOOL_NAME} again with the COMPLETE corrected content. Output the whole document, not a diff.`;
}
