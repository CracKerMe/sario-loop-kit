import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { isAllowedUri } from "@tiptap/extension-link";
import { z } from "zod";

import { emailSchema } from "./extensions";
import {
  ALIGN_TOKENS,
  BUTTON_VARIANTS,
  DIVIDER_VARIANTS,
  EMAIL_DOC_LIMITS,
  PADDING_Y_TOKENS,
} from "./types";
import type { EmailDocJson } from "./types";

/**
 * Structural validation for a client-submitted email document.
 *
 * Two layers, because neither is sufficient alone:
 *
 *  1. **ProseMirror schema** (`getSchema(extensions)` + `Node.fromJSON`) —
 *     rejects unknown node types and illegal content structure. This is the
 *     analog of @loopkit/journey's `assertWhitelistedGraph()`: the hard gate
 *     that runs before anything else touches the document.
 *  2. **zod** — ProseMirror validates that an attribute *exists*, not that its
 *     *value* is safe. `href: "javascript:alert(1)"` is a perfectly legal
 *     attribute as far as the schema is concerned. The zod pass is what
 *     constrains values: URL schemes, enum membership, integer ranges, text
 *     lengths.
 *
 * Stored documents were valid when they were written, but a document read back
 * from the database is still untrusted input for the renderer — a validator
 * bug that let something through would otherwise be permanently exploitable.
 * So validation runs on write *and* on render.
 */

export interface EmailDocIssue {
  /** Dotted path into the document, e.g. `content.0.content.2.attrs.href`. */
  path: string;
  message: string;
}

export interface EmailDocValidationResult {
  valid: boolean;
  issues: EmailDocIssue[];
}

export class EmailDocValidationError extends Error {
  readonly issues: EmailDocIssue[];

  constructor(issues: EmailDocIssue[]) {
    super(`invalid email document: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "EmailDocValidationError";
    this.issues = issues;
  }
}

// --- value-level schemas (the zod layer) -------------------------------------

const MERGE_TAG_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DANGEROUS_SCHEME_RE = /^\s*(javascript|data|vbscript|file):/i;
const MERGE_TAG_RE = /\{\{([^}]*)\}\}/g;

const paddingYSchema = z.enum(PADDING_Y_TOKENS as unknown as [string, ...string[]]);
const alignSchema = z.enum(ALIGN_TOKENS as unknown as [string, ...string[]]);
const buttonVariantSchema = z.enum(BUTTON_VARIANTS as unknown as [string, ...string[]]);
const dividerVariantSchema = z.enum(DIVIDER_VARIANTS as unknown as [string, ...string[]]);
const headingLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const colorSchema = z.string().regex(COLOR_RE);
const optionalColorSchema = z.union([z.null(), colorSchema]);
const imageWidthSchema = z.number().int().min(1).max(EMAIL_DOC_LIMITS.maxImageWidth);
const imageHeightSchema = z.union([
  z.null(),
  z.number().int().min(1).max(EMAIL_DOC_LIMITS.maxImageHeight),
]);

function checkValue(
  value: unknown,
  schema: z.ZodType,
  path: string,
  issues: EmailDocIssue[],
  message: string,
): void {
  if (!schema.safeParse(value).success) {
    issues.push({ path, message });
  }
}

function forEachMergeTagPath(value: string, fn: (inner: string) => void): void {
  // Reset lastIndex defensively; the regex is global so reuse keeps state.
  MERGE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MERGE_TAG_RE.exec(value)) !== null) {
    const inner = match[1] ?? "";
    fn(inner);
  }
}

/**
 * An href lives on a button, on a `link` mark, or on an image. It may carry a
 * `{{merge.tag}}` (the URL is personalised per recipient), in which case the
 * literal remainder must be empty or an absolute, allow-listed scheme; a bare
 * relative path has no meaning in an email (there is no page base URL) and is
 * rejected unless the whole value is a merge tag.
 */
function validateHref(value: unknown, path: string, issues: EmailDocIssue[]): void {
  if (typeof value !== "string") {
    issues.push({ path, message: "href must be a string" });
    return;
  }
  if (value === "") {
    issues.push({ path, message: "href must not be empty" });
    return;
  }
  const stripped = value.replace(MERGE_TAG_RE, "");
  if (DANGEROUS_SCHEME_RE.test(stripped)) {
    issues.push({ path, message: "href uses a disallowed URL scheme" });
    return;
  }
  if (stripped !== "") {
    const absolute =
      /^https?:\/\//i.test(stripped) || /^mailto:/i.test(stripped) || /^tel:/i.test(stripped);
    if (!absolute) {
      issues.push({
        path,
        message: "href must be an absolute http(s)/mailto/tel URL or a merge tag",
      });
      return;
    }
    if (!isAllowedUri(value)) {
      issues.push({ path, message: "href is not an allowed URI" });
      return;
    }
  }
  forEachMergeTagPath(value, (inner) => {
    if (!MERGE_TAG_PATH_RE.test(inner)) {
      issues.push({ path, message: `invalid merge tag path: ${inner}` });
    }
  });
}

function validateImageSrc(value: unknown, path: string, issues: EmailDocIssue[]): void {
  if (typeof value !== "string") {
    issues.push({ path, message: "src must be a string" });
    return;
  }
  if (value === "") {
    issues.push({ path, message: "image src is required" });
    return;
  }
  const stripped = value.replace(MERGE_TAG_RE, "");
  if (stripped === "") return; // the whole URL is a merge tag
  if (!/^https?:\/\//i.test(stripped)) {
    issues.push({
      path,
      message: "image src must be an http(s) URL or a merge tag",
    });
    return;
  }
  if (!isAllowedUri(value)) {
    issues.push({ path, message: "image src is not an allowed URI" });
  }
  forEachMergeTagPath(value, (inner) => {
    if (!MERGE_TAG_PATH_RE.test(inner)) {
      issues.push({ path, message: `invalid merge tag path: ${inner}` });
    }
  });
}

function validateAlt(value: unknown, path: string, issues: EmailDocIssue[]): void {
  if (typeof value !== "string" || value === "") {
    issues.push({ path, message: "image alt is required and must be non-empty" });
  }
}

function validateMergeTagPath(value: unknown, path: string, issues: EmailDocIssue[]): void {
  if (typeof value !== "string" || !MERGE_TAG_PATH_RE.test(value)) {
    issues.push({ path, message: "invalid merge tag path" });
  }
}

function validateButtonLabel(node: ProseMirrorNode, path: string, issues: EmailDocIssue[]): void {
  let label = "";
  node.forEach((child) => {
    if (child.isText) label += child.text ?? "";
    else if (child.type.name === "emailMergeTag") label += `{{${String(child.attrs?.path ?? "")}}}`;
  });
  if (label.length === 0) {
    issues.push({ path, message: "button label must not be empty" });
  }
}

// --- tree walk (collects every value-level issue) ----------------------------

interface WalkCtx {
  issues: EmailDocIssue[];
  nodeCount: number;
  maxDepth: number;
}

function walkNode(node: ProseMirrorNode, path: string, depth: number, ctx: WalkCtx): void {
  ctx.nodeCount += 1;
  if (depth > ctx.maxDepth) ctx.maxDepth = depth;

  // Marks: only `link` carries a value worth checking (href). This must run
  // before the `isText` early return below, because a `link` mark lives on a
  // text node — checking marks only after that return would never see it.
  const marks = node.marks ?? [];
  for (let mi = 0; mi < marks.length; mi += 1) {
    const mark = marks[mi]!;
    if (mark.type.name === "link") {
      validateHref(mark.attrs?.href, `${path}.marks.${mi}.attrs.href`, ctx.issues);
    } else if (mark.type.name === "textStyle") {
      checkValue(
        mark.attrs?.color,
        optionalColorSchema,
        `${path}.marks.${mi}.attrs.color`,
        ctx.issues,
        "text color must be null or #rgb/#rrggbb",
      );
      checkValue(
        mark.attrs?.backgroundColor,
        optionalColorSchema,
        `${path}.marks.${mi}.attrs.backgroundColor`,
        ctx.issues,
        "text backgroundColor must be null or #rgb/#rrggbb",
      );
    }
  }

  if (node.isText) {
    const text = node.text ?? "";
    if (typeof text !== "string" || text.length === 0) {
      ctx.issues.push({ path, message: "text node must be a non-empty string" });
    } else if (text.length > EMAIL_DOC_LIMITS.maxTextLength) {
      ctx.issues.push({
        path,
        message: `text exceeds ${EMAIL_DOC_LIMITS.maxTextLength} characters`,
      });
    }
    return;
  }

  const type = node.type.name;
  const attrs = node.attrs as Record<string, unknown> | undefined;

  switch (type) {
    case "doc":
      break;
    case "emailSection":
      checkValue(
        attrs?.backgroundColor,
        optionalColorSchema,
        `${path}.attrs.backgroundColor`,
        ctx.issues,
        "backgroundColor must be null or #rgb/#rrggbb",
      );
      checkValue(
        attrs?.paddingY,
        paddingYSchema,
        `${path}.attrs.paddingY`,
        ctx.issues,
        "paddingY must be none|sm|md|lg",
      );
      break;
    case "emailHeading":
      checkValue(
        attrs?.level,
        headingLevelSchema,
        `${path}.attrs.level`,
        ctx.issues,
        "level must be 1|2|3",
      );
      checkValue(
        attrs?.align,
        alignSchema,
        `${path}.attrs.align`,
        ctx.issues,
        "align must be left|center|right",
      );
      break;
    case "emailParagraph":
      checkValue(
        attrs?.align,
        alignSchema,
        `${path}.attrs.align`,
        ctx.issues,
        "align must be left|center|right",
      );
      break;
    case "emailButton":
      validateHref(attrs?.href, `${path}.attrs.href`, ctx.issues);
      checkValue(
        attrs?.variant,
        buttonVariantSchema,
        `${path}.attrs.variant`,
        ctx.issues,
        "variant must be primary|secondary",
      );
      checkValue(
        attrs?.align,
        alignSchema,
        `${path}.attrs.align`,
        ctx.issues,
        "align must be left|center|right",
      );
      validateButtonLabel(node, path, ctx.issues);
      break;
    case "emailImage":
      validateImageSrc(attrs?.src, `${path}.attrs.src`, ctx.issues);
      validateAlt(attrs?.alt, `${path}.attrs.alt`, ctx.issues);
      checkValue(
        attrs?.width,
        imageWidthSchema,
        `${path}.attrs.width`,
        ctx.issues,
        "width must be an integer 1..1200",
      );
      checkValue(
        attrs?.height,
        imageHeightSchema,
        `${path}.attrs.height`,
        ctx.issues,
        "height must be null or an integer 1..2000",
      );
      if (attrs?.href !== null && attrs?.href !== undefined) {
        validateHref(attrs?.href, `${path}.attrs.href`, ctx.issues);
      }
      checkValue(
        attrs?.align,
        alignSchema,
        `${path}.attrs.align`,
        ctx.issues,
        "align must be left|center|right",
      );
      break;
    case "emailDivider":
      checkValue(
        attrs?.variant,
        dividerVariantSchema,
        `${path}.attrs.variant`,
        ctx.issues,
        "variant must be solid|dashed",
      );
      checkValue(
        attrs?.color,
        optionalColorSchema,
        `${path}.attrs.color`,
        ctx.issues,
        "color must be null or #rgb/#rrggbb",
      );
      break;
    case "emailMergeTag":
      validateMergeTagPath(attrs?.path, `${path}.attrs.path`, ctx.issues);
      break;
    default:
      // Unreachable if the PM pass succeeded, but defensive.
      ctx.issues.push({ path, message: `unknown node type: ${type}` });
  }

  node.forEach((child, _offset, i) => {
    const childPath = path === "" ? `content.${i}` : `${path}.content.${i}`;
    walkNode(child, childPath, depth + 1, ctx);
  });
}

/**
 * Never throws. Returns every problem found, not just the first, so the editor
 * can highlight all of them at once — a form that reveals one error per save
 * round trip is a form people give up on.
 */
export function validateEmailDoc(doc: unknown): EmailDocValidationResult {
  const issues: EmailDocIssue[] = [];

  // Serialized size of the document as submitted.
  try {
    const serialized = JSON.stringify(doc);
    if (typeof serialized !== "string") throw new Error("document did not serialize to JSON");
    // `email-doc` runs in both Node (the API) and the browser (the editor).
    // Buffer is Node-only; using it here made every browser-side document look
    // non-serializable and paused the live preview before it could render.
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > EMAIL_DOC_LIMITS.maxDocBytes) {
      issues.push({
        path: "",
        message: `document exceeds ${EMAIL_DOC_LIMITS.maxDocBytes} bytes`,
      });
    }
  } catch {
    issues.push({ path: "", message: "document is not serializable" });
  }

  // Structural gate: unknown node/mark types and content-expression
  // violations. `fromJSON` resolves types and attribute shapes; `node.check()`
  // is the second call that enforces content expressions (section nesting,
  // text directly under doc, etc.).
  let node: ProseMirrorNode | null = null;
  try {
    node = ProseMirrorNode.fromJSON(emailSchema(), doc);
    node.check();
  } catch (err) {
    issues.push({
      path: "",
      message: err instanceof Error ? err.message : "invalid document structure",
    });
  }

  if (node) {
    const ctx: WalkCtx = { issues, nodeCount: 0, maxDepth: 0 };
    walkNode(node, "", 1, ctx);
    if (ctx.nodeCount > EMAIL_DOC_LIMITS.maxNodes) {
      issues.push({ path: "", message: `document exceeds ${EMAIL_DOC_LIMITS.maxNodes} nodes` });
    }
    if (ctx.maxDepth > EMAIL_DOC_LIMITS.maxDepth) {
      issues.push({ path: "", message: `document exceeds depth ${EMAIL_DOC_LIMITS.maxDepth}` });
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Throws `EmailDocValidationError` unless the document is fully valid. */
export function assertValidEmailDoc(doc: unknown): EmailDocJson {
  const result = validateEmailDoc(doc);
  if (!result.valid) throw new EmailDocValidationError(result.issues);
  return doc as EmailDocJson;
}
