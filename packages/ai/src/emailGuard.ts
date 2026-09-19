/**
 * The mandatory safety boundary for model-produced email content.
 *
 * The authority is @loopkit/email-doc's `validateEmailDoc` — the same
 * validator the save path and the renderer trust. Its block set is closed,
 * its attributes are enums, its hrefs/srcs go through an allow-list, so a
 * model payload that survives it is exactly as trustworthy as a hand-built
 * one. The envelope (`{subject, doc}`) is rebuilt explicitly, so unknown or
 * injected top-level keys never reach the caller.
 */
import { validateEmailDoc, type EmailDocJson } from "@loopkit/email-doc";
import { AiGraphError, extractJsonObject } from "./graphGuard";

export interface GeneratedEmailContent {
  subject: string;
  doc: EmailDocJson;
}

/** The template route's own ceiling for a subject line. */
const SUBJECT_MAX = 500;

export function guardEmailContent(input: unknown): GeneratedEmailContent {
  let candidate = input;
  // Tool inputs normally arrive pre-parsed; a string payload is tolerated
  // for parity with the journey guard (some gateways stringify arguments).
  if (typeof candidate === "string") {
    candidate = extractJsonObject(candidate);
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new AiGraphError("expected an object with `subject` and `doc`");
  }

  const raw = candidate as Record<string, unknown>;

  const subject = typeof raw.subject === "string" ? raw.subject.trim() : "";
  if (subject.length === 0) {
    throw new AiGraphError("`subject` must be a non-empty string");
  }
  if (subject.length > SUBJECT_MAX) {
    throw new AiGraphError(`\`subject\` exceeds ${SUBJECT_MAX} characters`);
  }
  if (raw.doc === undefined || raw.doc === null) {
    throw new AiGraphError("`doc` is required");
  }

  const result = validateEmailDoc(raw.doc);
  if (!result.valid) {
    throw new AiGraphError(
      "email document failed validation",
      result.issues.map((i) => `${i.path}: ${i.message}`),
    );
  }

  // Envelope rebuilt explicitly: whatever else the model put next to
  // `subject`/`doc` is dropped here.
  return { subject, doc: raw.doc as EmailDocJson };
}
