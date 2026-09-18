import { Mark, Node, getSchema, type Extensions } from "@tiptap/core";
import { Bold } from "@tiptap/extension-bold";
import { Document } from "@tiptap/extension-document";
import { Italic } from "@tiptap/extension-italic";
import { Link } from "@tiptap/extension-link";
import { Text } from "@tiptap/extension-text";
import { Underline } from "@tiptap/extension-underline";
import type { Schema } from "@tiptap/pm/model";

import { ALIGN_TOKENS, HEADING_LEVELS, PADDING_Y_TOKENS } from "./types";

/**
 * The single source of truth for the email document schema.
 *
 * The editor and the server both build their schema from this list, which is
 * what makes "the editor cannot produce what the server cannot render" a
 * structural fact rather than a promise. The marks matter as much as the
 * nodes here: if the server's schema omitted `bold`, `getSchema()` would not
 * recognise the mark and every document containing bold text would fail
 * validation on save.
 *
 * `renderHTML` below describes the **editing** DOM only. The email HTML is
 * produced by render.ts, because the two have incompatible requirements: the
 * editor wants something a browser can lay out and a caret can live in, while
 * a mail client needs nested tables with inline styles. Sharing one renderer
 * between them is exactly the mistake that makes `@tiptap/html`'s output
 * unusable in email.
 *
 * Nothing here is imported by `@loopkit/core` at runtime except through
 * validate.ts / render.ts — the types in types.ts are plain data.
 */

/**
 * The only two shapes `parseHTML` / `renderHTML` are allowed to depend on,
 * declared structurally.
 *
 * `lib` for this package is `["ESNext"]` with no `DOM`, and that is
 * deliberate: the validator and the renderer must stay runnable in plain Node,
 * so a type annotation naming `HTMLElement` would be both a compile error and a
 * contradiction of the package's contract. A real `HTMLElement` satisfies
 * `HtmlElementLike`, so these are assignable to Tiptap's own signatures.
 */
interface HtmlElementLike {
  getAttribute(name: string): string | null;
}

type HtmlAttributesLike = Record<string, unknown>;

/** Groups, so content expressions can stay readable in one place. */
const BLOCK_GROUP = "emailBlock";

const alignAttribute = {
  align: {
    default: "left",
    parseHTML: (element: HtmlElementLike) => element.getAttribute("data-align") ?? "left",
    renderHTML: (attributes: HtmlAttributesLike) => ({
      "data-align": String(attributes.align ?? "left"),
    }),
  },
};

function alignStyle(attributes: HtmlAttributesLike): string {
  const align = String(attributes.align ?? "left");
  return `text-align:${align}`;
}

/**
 * The root, narrowed from Tiptap's default `block+` to `emailSection+`: a
 * document is one or more bands, and nothing else can be a top-level child.
 */
const EmailDocument = Document.extend({ content: "emailSection+" });

/**
 * A full-width band. Sections do not nest (`group: "emailSection"` keeps it
 * out of its own content expression), because nested backgrounds are the
 * single most reliable way to produce an email that renders differently in
 * every client.
 */
const EmailSection = Node.create({
  name: "emailSection",
  group: "emailSection",
  content: `${BLOCK_GROUP}+`,
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      backgroundColor: {
        default: null,
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-background-color"),
        renderHTML: (attributes: HtmlAttributesLike) =>
          attributes.backgroundColor
            ? { "data-background-color": String(attributes.backgroundColor) }
            : {},
      },
      paddingY: {
        default: "md",
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-padding-y") ?? "md",
        renderHTML: (attributes: HtmlAttributesLike) => ({
          "data-padding-y": String(attributes.paddingY ?? "md"),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-email-section]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const padding = String(HTMLAttributes["data-padding-y"] ?? "md");
    const spacing = padding === "none" ? 0 : padding === "sm" ? 12 : padding === "lg" ? 40 : 24;
    return [
      "div",
      {
        ...HTMLAttributes,
        "data-email-section": "",
        style: `padding:${spacing}px 24px`,
      },
      0,
    ];
  },
});

/**
 * `content: "inline*"` rather than `"text*"` — a deliberate distinction that is
 * easy to get wrong: `text*` permits *only* text nodes, so any paragraph, heading
 * or button containing a merge-tag chip would be rejected as invalid content.
 * `inline*` accepts every inline node, which includes both `text` and the
 * `emailMergeTag` atom.
 */
const EmailHeading = Node.create({
  name: "emailHeading",
  group: BLOCK_GROUP,
  content: "inline*",

  addAttributes() {
    return {
      level: {
        default: 1,
        parseHTML: (element: HtmlElementLike) => Number(element.getAttribute("data-level") ?? 1),
        renderHTML: (attributes: HtmlAttributesLike) => ({
          "data-level": String(attributes.level ?? 1),
        }),
      },
      ...alignAttribute,
    };
  },

  parseHTML() {
    return [{ tag: "div[data-email-heading]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const level = Number(HTMLAttributes["data-level"] ?? 1);
    const size = level === 1 ? 24 : level === 2 ? 20 : 16;
    return [
      "div",
      {
        ...HTMLAttributes,
        "data-email-heading": "",
        style: `font-size:${size}px;font-weight:600;line-height:1.3;${alignStyle(HTMLAttributes)}`,
      },
      0,
    ];
  },
});

const EmailParagraph = Node.create({
  name: "emailParagraph",
  group: BLOCK_GROUP,
  content: "inline*",

  addAttributes() {
    return { ...alignAttribute };
  },

  parseHTML() {
    return [{ tag: "div[data-email-paragraph]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      {
        ...HTMLAttributes,
        "data-email-paragraph": "",
        style: `font-size:16px;line-height:1.6;${alignStyle(HTMLAttributes)}`,
      },
      0,
    ];
  },
});

const EmailButton = Node.create({
  name: "emailButton",
  group: BLOCK_GROUP,
  content: "inline*",

  addAttributes() {
    return {
      href: {
        default: "",
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-href") ?? "",
        renderHTML: (attributes: HtmlAttributesLike) => ({
          "data-href": String(attributes.href ?? ""),
        }),
      },
      variant: {
        default: "primary",
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-variant") ?? "primary",
        renderHTML: (attributes: HtmlAttributesLike) => ({
          "data-variant": String(attributes.variant ?? "primary"),
        }),
      },
      ...alignAttribute,
    };
  },

  parseHTML() {
    return [{ tag: "div[data-email-button]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const variant = String(HTMLAttributes["data-variant"] ?? "primary");
    // The editor shows the label inside a padded box so the author sees the
    // button's shape; the *email* HTML gets its padding on a <td>, because
    // Outlook's Word engine ignores padding on an <a>.
    const shell =
      variant === "primary"
        ? "background:#111827;color:#ffffff;"
        : "background:transparent;color:#111827;border:1px solid #d4d4d8;";
    return [
      "div",
      {
        ...HTMLAttributes,
        "data-email-button": "",
        style: `${alignStyle(HTMLAttributes)}`,
      },
      [
        "span",
        {
          style: `display:inline-block;padding:12px 20px;border-radius:6px;font-weight:600;${shell}`,
        },
        0,
      ],
    ];
  },
});

const EmailImage = Node.create({
  name: "emailImage",
  group: BLOCK_GROUP,
  atom: true,

  addAttributes() {
    return {
      src: {
        default: "",
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-src") ?? "",
        renderHTML: (attributes: HtmlAttributesLike) => ({
          "data-src": String(attributes.src ?? ""),
        }),
      },
      alt: {
        default: "",
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-alt") ?? "",
        renderHTML: (attributes: HtmlAttributesLike) => ({
          "data-alt": String(attributes.alt ?? ""),
        }),
      },
      width: {
        default: 600,
        parseHTML: (element: HtmlElementLike) => Number(element.getAttribute("data-width") ?? 600),
        renderHTML: (attributes: HtmlAttributesLike) => ({
          "data-width": String(attributes.width ?? 600),
        }),
      },
      height: {
        default: null,
        parseHTML: (element: HtmlElementLike) => {
          const raw = element.getAttribute("data-height");
          return raw === null ? null : Number(raw);
        },
        renderHTML: (attributes: HtmlAttributesLike) =>
          attributes.height === null || attributes.height === undefined
            ? {}
            : { "data-height": String(attributes.height) },
      },
      href: {
        default: null,
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-href"),
        renderHTML: (attributes: HtmlAttributesLike) =>
          attributes.href ? { "data-href": String(attributes.href) } : {},
      },
      ...alignAttribute,
    };
  },

  parseHTML() {
    return [{ tag: "div[data-email-image]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const width = Number(HTMLAttributes["data-width"] ?? 600);
    const src = String(HTMLAttributes["data-src"] ?? "");
    return [
      "div",
      { ...HTMLAttributes, "data-email-image": "", style: alignStyle(HTMLAttributes) },
      src
        ? [
            "img",
            {
              src,
              alt: String(HTMLAttributes["data-alt"] ?? ""),
              style: `max-width:${width}px;height:auto;`,
            },
          ]
        : [
            "span",
            {
              style:
                "display:inline-block;padding:2px 6px;border:1px dashed #d4d4d8;color:#71717a;font-size:12px",
            },
            "Image — set a URL",
          ],
    ];
  },
});

const EmailDivider = Node.create({
  name: "emailDivider",
  group: BLOCK_GROUP,
  atom: true,

  addAttributes() {
    return {
      variant: {
        default: "solid",
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-variant") ?? "solid",
        renderHTML: (attributes: HtmlAttributesLike) => ({
          "data-variant": String(attributes.variant ?? "solid"),
        }),
      },
      color: {
        default: null,
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-color"),
        renderHTML: (attributes: HtmlAttributesLike) =>
          attributes.color ? { "data-color": String(attributes.color) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-email-divider]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const style =
      String(HTMLAttributes["data-variant"] ?? "solid") === "dashed" ? "dashed" : "solid";
    const color = String(HTMLAttributes["data-color"] ?? "#e4e4e7");
    return [
      "div",
      { ...HTMLAttributes, "data-email-divider": "", style: "padding:8px 0" },
      ["div", { style: `border-top:1px ${style} ${color}` }],
    ];
  },
});

/**
 * An inline atom representing `{{path}}`.
 *
 * A chip rather than free text on purpose: a hand-typed `{{firstname}}` that
 * does not resolve renders *literally* in a recipient's inbox, and the
 * mistake is invisible to whoever wrote it. The renderer emits the literal
 * `{{path}}` text, which is what the downstream interpolator consumes.
 *
 * Known limitation, deliberately accepted: pasting already-rendered email HTML
 * back into the editor will not reconstruct merge tags, because the rendered
 * form is indistinguishable from ordinary text. Reconstructing them would
 * require treating every `{{...}}` in pasted content as a merge tag, which
 * would rewrite a legitimate literal — a worse failure than losing the chip.
 */
const EmailMergeTag = Node.create({
  name: "emailMergeTag",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: {
        default: "",
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-path") ?? "",
        renderHTML: (attributes: HtmlAttributesLike) => ({
          "data-path": String(attributes.path ?? ""),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-email-merge-tag]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      {
        ...HTMLAttributes,
        "data-email-merge-tag": "",
        style:
          "display:inline-block;padding:0 4px;border-radius:4px;background:#eef2ff;color:#3730a3;font-family:ui-monospace,monospace;font-size:0.9em",
      },
      `{{${String(HTMLAttributes["data-path"] ?? "")}}}`,
    ];
  },
});

/**
 * Link, configured for email rather than for a web page:
 * `openOnClick: false` (a click in the editor should place the caret, not
 * navigate away from unsaved work) and `autolink: false` (marketing copy
 * containing something that looks like a domain should not silently become a
 * link).
 *
 * Its default URI policy already rejects `javascript:`, `data:` and
 * `vbscript:` — verified against the installed version — but that is a
 * convenience for the author, not a security boundary: the server repeats the
 * check, because anything the client enforces can be bypassed by posting JSON
 * directly.
 */
const EmailLink = Link.configure({
  openOnClick: false,
  autolink: false,
  linkOnPaste: true,
  defaultProtocol: "https",
});

/**
 * Inline presentation that remains safe in email clients.  Keeping colour and
 * highlight in one mark means a selected run can carry both values at once,
 * without introducing browser-only CSS or arbitrary HTML into the document.
 */
const EmailTextStyle = Mark.create({
  name: "textStyle",
  inclusive: true,

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-text-color"),
        renderHTML: (attributes: HtmlAttributesLike) =>
          attributes.color ? { "data-text-color": String(attributes.color) } : {},
      },
      backgroundColor: {
        default: null,
        parseHTML: (element: HtmlElementLike) => element.getAttribute("data-text-background"),
        renderHTML: (attributes: HtmlAttributesLike) =>
          attributes.backgroundColor
            ? { "data-text-background": String(attributes.backgroundColor) }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-text-color], span[data-text-background]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const color = HTMLAttributes["data-text-color"];
    const background = HTMLAttributes["data-text-background"];
    const style = [
      color ? `color:${String(color)}` : "",
      background ? `background-color:${String(background)}` : "",
    ]
      .filter(Boolean)
      .join(";");
    return ["span", { ...HTMLAttributes, ...(style ? { style } : {}) }, 0];
  },
});

/**
 * A fresh extension list. A factory rather than a shared array because a
 * Tiptap extension instance carries configuration state and an editor mutates
 * its own copy; handing the same instances to the server's `getSchema()` and
 * to a live editor is the kind of aliasing that produces bugs that only appear
 * when both exist at once.
 */
export function emailExtensions(): Extensions {
  return [
    EmailDocument,
    EmailSection,
    EmailHeading,
    EmailParagraph,
    EmailButton,
    EmailImage,
    EmailDivider,
    EmailMergeTag,
    Text,
    Bold,
    Italic,
    Underline,
    EmailLink,
    EmailTextStyle,
  ];
}

/** The ProseMirror schema, built from the same list the editor uses. */
export function emailSchema(): Schema {
  return getSchema(emailExtensions());
}

/** Marks the editor toolbar may toggle. Nothing else is in the schema. */
export const EMAIL_MARK_EXTENSIONS = [Bold, Italic, Underline, EmailLink, EmailTextStyle] as const;

export {
  EmailButton,
  EmailDivider,
  EmailDocument,
  EmailHeading,
  EmailImage,
  EmailLink,
  EmailMergeTag,
  EmailParagraph,
  EmailSection,
  EmailTextStyle,
  BLOCK_GROUP,
};

/** Re-exported so a UI can offer only valid choices without importing types.ts. */
export { ALIGN_TOKENS, HEADING_LEVELS, PADDING_Y_TOKENS };
