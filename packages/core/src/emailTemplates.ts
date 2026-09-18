import {
  assertValidEmailDoc,
  emailDocToPlainText,
  extractMergeTagPaths,
  renderEmailDoc,
  EmailDocValidationError,
  type EmailDocJson,
} from "@loopkit/email-doc";
import type { Db } from "@loopkit/db";
import { emailTemplate } from "@loopkit/db/schema";
import { and, desc, eq } from "drizzle-orm";

export { EmailDocValidationError };

export type EmailTemplateSource = "html" | "react-email" | "mjml" | "tiptap";

export interface EmailTemplateRow {
  id: string;
  workspaceId: string;
  name: string;
  subject: string;
  html: string;
  textBody: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  source: EmailTemplateSource;
  /** ProseMirror JSON when `source` is `"tiptap"`; null for hand-written HTML. */
  doc: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderedEmailDoc {
  html: string;
  /** Derived plain-text alternative, for `multipart/alternative`. */
  textBody: string;
  /** Merge-tag paths the document depends on, for the editor's variable list. */
  mergeTags: string[];
}

const PREVIEW_MERGE_TAG_VALUES: Record<string, string> = {
  "contact.email": "alex.morgan@example.com",
  "contact.firstName": "Alex",
  "contact.lastName": "Morgan",
  "contact.plan": "Pro",
  "contact.id": "contact_demo_123",
  contactId: "contact_demo_123",
  workspaceId: "workspace_demo",
};

/**
 * A readable, deterministic stand-in for one merge tag in the editor. This is
 * intentionally only used by `previewEmailDoc`: saved HTML must retain the
 * token for the recipient-specific render performed at send time.
 */
function previewMergeTagValue(path: string): string {
  const known = PREVIEW_MERGE_TAG_VALUES[path];
  if (known) return known;

  const field = path.split(".").at(-1) || "value";
  if (/email$/i.test(field)) return "alex.morgan@example.com";
  if (/(url|uri)$/i.test(field)) return "https://example.com/demo";
  if (/name$/i.test(field)) return "Example name";
  return `Example ${field.replace(/([A-Z])/g, " $1").toLowerCase()}`;
}

function applyPreviewMergeTagValues(template: string, paths: readonly string[]): string {
  if (paths.length === 0) return template;
  const values = new Map(paths.map((path) => [path, previewMergeTagValue(path)]));

  return template.replace(/\{\{\{?\s*([\w.]+)\s*\}\}\}?/g, (match, path: string) => {
    return values.get(path) ?? match;
  });
}

/**
 * The one place a document becomes HTML.
 *
 * Validation is not optional and not the caller's job: `assertValidEmailDoc`
 * runs first and throws `EmailDocValidationError`, because a renderer given
 * invalid input produces *partial* output rather than an error — a section
 * that silently disappears is far worse than a failed save.
 *
 * Rendering happens on the server, never in the browser. A client-supplied
 * `html` alongside a `doc` is therefore ignored outright (see
 * `resolveTemplateContent`), or the renderer's whole layout guarantee would be
 * bypassable by posting whatever HTML you like to the API.
 */
export function renderTemplateDoc(doc: unknown): RenderedEmailDoc {
  assertValidEmailDoc(doc);
  return {
    html: renderEmailDoc(doc),
    textBody: emailDocToPlainText(doc),
    mergeTags: extractMergeTagPaths(doc),
  };
}

/**
 * Live preview for the editor. It shares the save renderer, then replaces the
 * resulting merge tokens with mock values so personalisation is visible before
 * a real recipient exists.
 */
export function previewEmailDoc(doc: unknown): RenderedEmailDoc {
  const rendered = renderTemplateDoc(doc);
  return {
    ...rendered,
    html: applyPreviewMergeTagValues(rendered.html, rendered.mergeTags),
    textBody: applyPreviewMergeTagValues(rendered.textBody, rendered.mergeTags),
  };
}

interface TemplateContent {
  html: string;
  textBody: string | null;
  source: EmailTemplateSource;
  doc: EmailDocJson | null;
}

/**
 * Decides what actually gets stored from a create/update payload.
 *
 * `doc` wins over `html` rather than being merged with it: the two describe the
 * same content, and honouring a client's `html` when a `doc` is present would
 * let a caller persist a hand-crafted body while the UI reports the template as
 * editor-managed — so the visual editor would show one thing and recipients
 * receive another.
 */
function resolveTemplateContent(input: {
  html?: string;
  doc?: unknown;
  textBody?: string | null;
}): TemplateContent {
  if (input.doc !== undefined && input.doc !== null) {
    const rendered = renderTemplateDoc(input.doc);
    return {
      html: rendered.html,
      // An explicit text body still wins — an operator may want edited copy.
      textBody: input.textBody ?? rendered.textBody,
      source: "tiptap",
      doc: input.doc as EmailDocJson,
    };
  }

  if (!input.html || input.html.trim().length === 0) {
    throw new Error("createEmailTemplate: either `doc` or a non-empty `html` is required");
  }

  return {
    html: input.html,
    textBody: input.textBody ?? null,
    source: "html",
    doc: null,
  };
}

export async function listEmailTemplates(db: Db, workspaceId: string): Promise<EmailTemplateRow[]> {
  return db
    .select()
    .from(emailTemplate)
    .where(eq(emailTemplate.workspaceId, workspaceId))
    .orderBy(desc(emailTemplate.updatedAt));
}

export async function getEmailTemplate(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<EmailTemplateRow | null> {
  const [row] = await db
    .select()
    .from(emailTemplate)
    .where(and(eq(emailTemplate.id, id), eq(emailTemplate.workspaceId, workspaceId)))
    .limit(1);
  return (row as EmailTemplateRow | undefined) ?? null;
}

export async function createEmailTemplate(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    subject: string;
    /** Hand-written HTML. Ignored when `doc` is present. */
    html?: string;
    /** Visual-editor document. Validated and rendered here, then stored. */
    doc?: unknown;
    textBody?: string;
    fromName?: string;
    fromEmail?: string;
    replyTo?: string;
  },
): Promise<EmailTemplateRow> {
  const content = resolveTemplateContent(input);

  const [row] = await db
    .insert(emailTemplate)
    .values({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      subject: input.subject,
      html: content.html,
      textBody: content.textBody,
      source: content.source,
      doc: content.doc,
      fromName: input.fromName ?? null,
      fromEmail: input.fromEmail ?? null,
      replyTo: input.replyTo ?? null,
    })
    .returning();
  if (!row) throw new Error("createEmailTemplate: insert returned no row");
  return row as EmailTemplateRow;
}

export async function updateEmailTemplate(
  db: Db,
  workspaceId: string,
  id: string,
  patch: Partial<{
    name: string;
    subject: string;
    html: string;
    doc: unknown;
    textBody: string | null;
    fromName: string | null;
    fromEmail: string | null;
    replyTo: string | null;
  }>,
): Promise<EmailTemplateRow | null> {
  const values: Record<string, unknown> = { ...patch };

  // Re-render only when the document actually changed. A patch that touches
  // just the subject must not pay for a render, and must not silently rewrite
  // a template that was authored as raw HTML.
  if (patch.doc !== undefined) {
    const existing = await getEmailTemplate(db, workspaceId, id);
    if (!existing) return null;

    if (patch.doc === null) {
      // Explicitly detaching the document leaves the last rendered HTML in
      // place — the template keeps sending what it last sent.
      values.doc = null;
      values.source = "html";
    } else {
      const content = resolveTemplateContent({
        doc: patch.doc,
        html: patch.html,
        textBody: patch.textBody,
      });
      values.html = content.html;
      values.source = content.source;
      values.doc = content.doc;
      // Only overwrite the text body if the caller did not set one explicitly.
      if (patch.textBody === undefined) values.textBody = content.textBody;
    }
  } else if (patch.html !== undefined && patch.html.trim().length === 0) {
    throw new Error("updateEmailTemplate: `html` cannot be empty");
  }

  const [row] = await db
    .update(emailTemplate)
    .set(values)
    .where(and(eq(emailTemplate.id, id), eq(emailTemplate.workspaceId, workspaceId)))
    .returning();
  return (row as EmailTemplateRow | undefined) ?? null;
}
