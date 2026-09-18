import { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { emailSchema } from "./extensions";
import { assertValidEmailDoc } from "./validate";

/**
 * ProseMirror JSON → email HTML.
 *
 * Deliberately hand-written. The two off-the-shelf options were both rejected
 * on evidence:
 *
 *  - `@tiptap/html`'s `generateHTML` cannot run without a DOM (its server entry
 *    requires `happy-dom`), and what it emits is semantic web HTML: no layout
 *    table, no `role="presentation"`, no inline layout styles, images with no
 *    width/height. Outlook's Word engine ignores CSS `margin`, so the output
 *    does not merely look different there — the vertical rhythm collapses.
 *  - MJML can produce correct output, but it is a ~1.25 MB minified black box
 *    with a single breakpoint, whose output we cannot assert byte-for-byte.
 *    The block set here is closed and small, so the table structure is
 *    enumerable — determinism beats convenience.
 *
 * The contract for the returned string is an allow-list, and a test suite
 * asserts it (`src/__tests__/render.test.ts`):
 *
 *  - a complete HTML document, so a preview iframe and a real send render
 *    identically;
 *  - fixed 600px single column, `max-width` plus a `width` attribute fallback;
 *  - every `<table>` is `role="presentation"` with `cellpadding="0"
 *    cellspacing="0" border="0"` and `border-collapse:collapse`;
 *  - styles are inline only — no `<style>` block, no classes;
 *  - no `flex`, `grid`, `float`, `position` or `z-index` anywhere;
 *  - text never sits directly inside `<table>`/`<tbody>`/`<tr>`;
 *  - every image has `width`, `height` and `alt`, plus `display:block`;
 *  - `<a>` never carries padding (Outlook ignores it) — the button's padding
 *    lives on its `<td>`;
 *  - under 100KB, because Gmail clips beyond ~102KB;
 *  - no `${`, so the downstream `{{var}}` interpolator can never be confused
 *    for a template expression.
 *
 * Renders a merge tag as its literal `{{path}}` text: the HTML is interpolated
 * by @loopkit/email's `renderTemplate` *after* this runs, which is why the
 * order is fixed here and covered by a test.
 */

export interface RenderEmailDocOptions {
  /** Content width in px. 600 is the email-safe default. */
  contentWidth?: number;
  /** Page background, behind the content column. */
  backgroundColor?: string;
  /** Default section background. */
  contentBackgroundColor?: string;
  fontFamily?: string;
  textColor?: string;
  mutedColor?: string;
  /** Brand colour for `variant: "primary"` buttons. */
  accentColor?: string;
}

interface RenderOptions {
  contentWidth: number;
  pageBackgroundColor: string;
  contentBackgroundColor: string;
  fontFamily: string;
  textColor: string;
  mutedColor: string;
  accentColor: string;
  linkColor: string;
}

const DEFAULT_OPTIONS: RenderOptions = {
  contentWidth: 600,
  pageBackgroundColor: "#f4f4f5",
  contentBackgroundColor: "#ffffff",
  fontFamily: "'Helvetica Neue', Arial, sans-serif",
  textColor: "#18181b",
  mutedColor: "#71717a",
  accentColor: "#111827",
  linkColor: "#2563eb",
};

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MERGE_TAG_RE = /\{\{([^}]*)\}\}/g;

const PADDING_Y_PX: Record<string, number> = { none: 0, sm: 12, md: 24, lg: 40 };
const HEADING_SIZE: Record<number, number> = { 1: 24, 2: 20, 3: 16 };

/**
 * Escapes text and attribute values for HTML, and replaces `$` so the output
 * can never contain the two-character sequence `${` (the downstream
 * interpolator deliberately avoids the engine's `${}` sandbox). `$` → `&#36;`
 * renders identically but can no longer combine with a following `{`.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\$/g, "&#36;");
}

function alignValue(value: unknown): string {
  return value === "center" || value === "right" ? (value as string) : "left";
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_RE.test(value);
}

function resolveColor(value: unknown, fallback: string): string {
  return isColor(value) ? value : fallback;
}

function safeFromJson(doc: unknown): ProseMirrorNode | null {
  try {
    const node = ProseMirrorNode.fromJSON(emailSchema(), doc);
    node.check();
    return node;
  } catch {
    return null;
  }
}

// --- inline content (text + marks + merge tags) -----------------------------

function renderInline(node: ProseMirrorNode, opts: RenderOptions): string {
  let html = "";
  node.forEach((child) => {
    if (child.isText) {
      html += renderText(child, opts);
    } else if (child.type.name === "emailMergeTag") {
      html += escapeHtml(`{{${String(child.attrs?.path ?? "")}}}`);
    }
  });
  return html;
}

function renderText(node: ProseMirrorNode, opts: RenderOptions): string {
  const escaped = escapeHtml(node.text ?? "");
  const marks = node.marks ?? [];
  let open = "";
  let close = "";
  for (const mark of marks) {
    if (mark.type.name === "bold") {
      open += "<strong>";
      close = "</strong>" + close;
    } else if (mark.type.name === "italic") {
      open += "<em>";
      close = "</em>" + close;
    } else if (mark.type.name === "underline") {
      open += "<u>";
      close = "</u>" + close;
    } else if (mark.type.name === "link") {
      const href = escapeHtml(String(mark.attrs?.href ?? ""));
      open += `<a href="${href}" style="color:${opts.linkColor};text-decoration:underline;">`;
      close = "</a>" + close;
    } else if (mark.type.name === "textStyle") {
      const color = isColor(mark.attrs?.color) ? `color:${mark.attrs.color};` : "";
      const background = isColor(mark.attrs?.backgroundColor)
        ? `background-color:${mark.attrs.backgroundColor};`
        : "";
      if (color || background) {
        open += `<span style="${color}${background}">`;
        close = "</span>" + close;
      }
    }
  }
  return open + escaped + close;
}

// --- blocks ------------------------------------------------------------------

function renderHeading(node: ProseMirrorNode, opts: RenderOptions): string {
  const level = (node.attrs?.level as number) ?? 1;
  const size = HEADING_SIZE[level] ?? 24;
  const align = alignValue(node.attrs?.align);
  return `<div style="font-size:${size}px;font-weight:600;line-height:1.3;color:${opts.textColor};text-align:${align};margin:0;">${renderInline(node, opts)}</div>`;
}

function renderParagraph(node: ProseMirrorNode, opts: RenderOptions): string {
  const align = alignValue(node.attrs?.align);
  return `<div style="font-size:16px;line-height:1.6;color:${opts.textColor};text-align:${align};margin:0;">${renderInline(node, opts)}</div>`;
}

function renderButton(node: ProseMirrorNode, opts: RenderOptions): string {
  const secondary = node.attrs?.variant === "secondary";
  const bg = secondary ? "transparent" : opts.accentColor;
  const fg = secondary ? opts.textColor : "#ffffff";
  const border = secondary ? "border:1px solid #d4d4d8;" : "";
  const align = alignValue(node.attrs?.align);
  const href = escapeHtml(String(node.attrs?.href ?? ""));
  const label = renderInline(node, opts);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="border-collapse:collapse;">
<tr>
<td style="padding:12px 20px;background:${bg};${border}border-radius:6px;mso-padding-alt:12px 20px;text-align:center;"><a href="${href}" style="color:${fg};text-decoration:none;font-weight:600;font-size:16px;display:inline-block;">${label}</a></td>
</tr>
</table>`;
}

function renderImage(node: ProseMirrorNode): string {
  const src = escapeHtml(String(node.attrs?.src ?? ""));
  const alt = escapeHtml(String(node.attrs?.alt ?? ""));
  const width = typeof node.attrs?.width === "number" ? node.attrs.width : 600;
  const height = typeof node.attrs?.height === "number" ? node.attrs.height : null;
  const align = alignValue(node.attrs?.align);
  const hrefRaw = node.attrs?.href;
  const href = typeof hrefRaw === "string" && hrefRaw !== "" ? escapeHtml(hrefRaw) : null;
  const heightAttr = height !== null ? ` height="${height}"` : "";
  const imgTag = `<img src="${src}" width="${width}"${heightAttr} alt="${alt}" border="0" style="display:block;border:0;max-width:100%;height:auto;">`;
  const inner = href !== null ? `<a href="${href}">${imgTag}</a>` : imgTag;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;">
<tr>
<td align="${align}" style="padding:0;">${inner}</td>
</tr>
</table>`;
}

function renderDivider(node: ProseMirrorNode): string {
  const dashed = node.attrs?.variant === "dashed";
  const variant = dashed ? "dashed" : "solid";
  const color = resolveColor(node.attrs?.color, "#e4e4e7");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;">
<tr>
<td style="border-top:1px ${variant} ${color};font-size:0;line-height:0;">&nbsp;</td>
</tr>
</table>`;
}

function renderBlock(node: ProseMirrorNode, opts: RenderOptions): string {
  switch (node.type.name) {
    case "emailHeading":
      return renderHeading(node, opts);
    case "emailParagraph":
      return renderParagraph(node, opts);
    case "emailButton":
      return renderButton(node, opts);
    case "emailImage":
      return renderImage(node);
    case "emailDivider":
      return renderDivider(node);
    default:
      return "";
  }
}

function renderSection(node: ProseMirrorNode, opts: RenderOptions): string {
  const bg = resolveColor(node.attrs?.backgroundColor, opts.contentBackgroundColor);
  const padToken = (node.attrs?.paddingY as string) ?? "md";
  const padY = PADDING_Y_PX[padToken] ?? 24;
  const blocks: string[] = [];
  node.forEach((block) => {
    blocks.push(renderBlock(block, opts));
  });
  const inner = blocks.join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;">
<tr>
<td style="background-color:${bg};padding:${padY}px 24px;">${inner}</td>
</tr>
</table>`;
}

function buildDocument(inner: string, opts: RenderOptions): string {
  const width = opts.contentWidth;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:${opts.pageBackgroundColor};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;background-color:${opts.pageBackgroundColor};">
<tr>
<td align="center" style="padding:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${width}" style="border-collapse:collapse;width:${width}px;max-width:${width}px;background-color:${opts.contentBackgroundColor};">
<tr>
<td style="padding:0;">${inner}</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

/**
 * Renders an email document to a complete, self-contained HTML string.
 *
 * Fail-closed: an invalid document is rejected with `EmailDocValidationError`
 * *before* any HTML is produced, so a half-rendered template can never be
 * stored. The document is untrusted input even when read back from the
 * database.
 */
export function renderEmailDoc(doc: unknown, options?: RenderEmailDocOptions): string {
  assertValidEmailDoc(doc);
  const opts: RenderOptions = { ...DEFAULT_OPTIONS, ...options };
  const pmDoc = ProseMirrorNode.fromJSON(emailSchema(), doc);
  const sections: string[] = [];
  pmDoc.forEach((section) => {
    sections.push(renderSection(section, opts));
  });
  return buildDocument(sections.join(""), opts);
}

// --- plain-text alternative --------------------------------------------------

function inlineToText(node: ProseMirrorNode): string {
  let text = "";
  node.forEach((child) => {
    if (child.isText) text += child.text ?? "";
    else if (child.type.name === "emailMergeTag") text += `{{${String(child.attrs?.path ?? "")}}}`;
  });
  return text;
}

function blockToPlainText(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case "emailHeading":
    case "emailParagraph":
      return inlineToText(node);
    case "emailButton":
      return `${inlineToText(node)} (${String(node.attrs?.href ?? "")})`;
    case "emailImage":
      return `[image: ${String(node.attrs?.alt ?? "")}]`;
    case "emailDivider":
      return "---";
    default:
      return "";
  }
}

/**
 * Plain-text alternative, built from the same document.
 *
 * Not a nicety: a `multipart/alternative` with a real text part measurably
 * improves deliverability, and the blocks carry enough structure (headings,
 * paragraphs, a button's label and URL) to produce something a person can
 * read.
 */
export function emailDocToPlainText(doc: unknown): string {
  const pmDoc = safeFromJson(doc);
  if (!pmDoc) return "";
  const lines: string[] = [];
  pmDoc.forEach((section) => {
    section.forEach((block) => {
      lines.push(blockToPlainText(block));
    });
  });
  return lines.join("\n\n");
}

/**
 * Every merge-tag path used in the document, in first-seen order.
 *
 * Lets the editor show which variables a template depends on, and lets the
 * save path warn about a path that can never resolve — a typo'd merge tag
 * otherwise renders as a literal `{{firstname}}` in a real inbox, which is
 * the kind of mistake that only ever gets noticed by a recipient.
 */
/**
 * Collects every `{{path}}` found inside a string value (a URL or href that is
 * partly personalised per recipient), de-duplicated against `seen` and appended
 * to `out` in first-seen order.
 */
function collectMergeTagPathsFrom(value: unknown, seen: Set<string>, out: string[]): void {
  if (typeof value !== "string") return;
  MERGE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MERGE_TAG_RE.exec(value)) !== null) {
    const path = match[1] ?? "";
    if (path !== "" && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
}

export function extractMergeTagPaths(doc: unknown): string[] {
  const pmDoc = safeFromJson(doc);
  if (!pmDoc) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (node: ProseMirrorNode): void => {
    if (node.isText) {
      // A `link` mark lives on a text node; its href may carry a merge tag.
      const marks = node.marks ?? [];
      for (const mark of marks) {
        if (mark.type.name === "link") {
          collectMergeTagPathsFrom(mark.attrs?.href, seen, out);
        }
      }
      return;
    }
    if (node.type.name === "emailMergeTag") {
      const path = String(node.attrs?.path ?? "");
      if (path !== "" && !seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    } else if (node.type.name === "emailButton") {
      // The button target is a per-recipient URL.
      collectMergeTagPathsFrom(node.attrs?.href, seen, out);
    } else if (node.type.name === "emailImage") {
      // Image source (and optional link wrapper) are per-recipient URLs.
      collectMergeTagPathsFrom(node.attrs?.src, seen, out);
      collectMergeTagPathsFrom(node.attrs?.href, seen, out);
    }
    // `backgroundColor` / `color` are colours, not merge tags — intentionally
    // not scanned here.
    node.forEach((child) => visit(child));
  };
  visit(pmDoc);
  return out;
}
