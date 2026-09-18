/**
 * The email document model: a **closed, restricted** set of blocks.
 *
 * This package exists to make one promise hold: *what the editor can produce
 * is exactly what the server can render.* Both sides import this same
 * definition, so the promise is structural rather than a convention that
 * drifts.
 *
 * ## Why a closed set instead of "Tiptap with StarterKit"
 *
 * A marketing email is not a web page. Every block here maps onto HTML that
 * survives the Word rendering engine inside Outlook, and nothing else is
 * offered — no `blockquote`, no `codeBlock`, no `code`, no nested headings,
 * no arbitrary `<div>`. Tiptap's StarterKit ships all of those, and every one
 * of them is a way to produce a template that looks fine in the editor and
 * falls apart in a recipient's mailbox.
 *
 * ## Why attributes are enums, not free-form CSS
 *
 * Blocks carry enums (`paddingY: "sm" | "md" | "lg"`, `align`, `variant`),
 * never a `style` string. Free-form style would let a saved template declare
 * `position: fixed` or `display: flex`, which two things depend on not
 * happening:
 *
 *  - the renderer's output is asserted against a layout allow-list in tests
 *    (no flex/grid/float/position, inline styles only, every table
 *    `role="presentation"`), and a user-supplied style string would route
 *    around exactly that guarantee;
 *  - the document is stored as JSON and re-rendered on every save, so an
 *    arbitrary style is a persisted, repeatable way to break every render.
 *
 * Style is the renderer's job. The document states intent; the renderer
 * decides the HTML.
 *
 * ## Deviations from the original plan, and why
 *
 * - `column` is **not** implemented. Multi-column email needs a ghost table
 *   (and VML for a background, in Outlook) to stay intact; the plan's own
 *   priority was "不散版" over fidelity, and a fixed 600px single column is
 *   the layout that cannot break. A `column` block can be added later
 *   without changing the document format.
 * - A `heading` and a `paragraph` block are added. The plan only listed
 *   section/column/button/image/divider; a text block is not optional.
 * - Node names are prefixed `email*` so they can never collide with a future
 *   generic node of the same name in a shared schema.
 */

/** Every node type the document format permits. Nothing else is renderable. */
export type EmailBlockType =
  | "emailSection"
  | "emailHeading"
  | "emailParagraph"
  | "emailButton"
  | "emailImage"
  | "emailDivider"
  | "emailMergeTag";

export type EmailMarkType = "bold" | "italic" | "underline" | "link" | "textStyle";

/** A ProseMirror mark, as it appears in the stored JSON. */
export interface EmailMarkJson {
  type: EmailMarkType;
  attrs?: Record<string, unknown>;
}

/**
 * A ProseMirror node, as it appears in the stored JSON. `text` only appears
 * on text leaves; `content` only on non-leaf nodes.
 */
export interface EmailNodeJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: EmailNodeJson[];
  marks?: EmailMarkJson[];
  text?: string;
}

/** The stored document. `doc` is the only legal root. */
export interface EmailDocJson {
  type: "doc";
  content?: EmailNodeJson[];
}

export interface EmailBlockDefinition {
  type: EmailBlockType;
  label: string;
  description: string;
  /**
   * `container` holds other blocks (the section), `block` is a top-level
   * leaf, `inline` is a text-level atom (the merge tag).
   */
  kind: "container" | "block" | "inline";
  /** Whether the editor palette offers it as a top-level insert. */
  insertable: boolean;
  /** JSON attrs with their defaults, for the editor's controls and the renderer. */
  attrs: Record<string, string | number | boolean | null>;
}

/**
 * The catalogue. Every consumer — the editor palette, the server validator,
 * the renderer's switch — is meant to be driven by this, so adding a block is
 * a one-place change.
 */
export const EMAIL_BLOCKS: readonly EmailBlockDefinition[] = [
  {
    type: "emailSection",
    label: "Section",
    description: "The content container. Backgrounds and vertical padding live here.",
    kind: "container",
    insertable: true,
    attrs: { backgroundColor: null, paddingY: "md" },
  },
  {
    type: "emailHeading",
    label: "Heading",
    description: "A short title. Three sizes only.",
    kind: "block",
    insertable: true,
    attrs: { level: 1, align: "left" },
  },
  {
    type: "emailParagraph",
    label: "Paragraph",
    description: "Body copy. Supports bold, italic, underline, links, text colour and highlights.",
    kind: "block",
    insertable: true,
    attrs: { align: "left" },
  },
  {
    type: "emailButton",
    label: "Button",
    description: "Call to action, rendered as a padded table cell so Outlook respects it.",
    kind: "block",
    insertable: true,
    attrs: { href: "", variant: "primary", align: "left" },
  },
  {
    type: "emailImage",
    label: "Image",
    description:
      "Rendered with explicit width, height and alt — three separate failure modes otherwise.",
    kind: "block",
    insertable: true,
    attrs: { src: "", alt: "", width: 600, height: null, href: null, align: "center" },
  },
  {
    type: "emailDivider",
    label: "Divider",
    description: "A horizontal rule drawn as a bordered table cell.",
    kind: "block",
    insertable: true,
    attrs: { variant: "solid", color: null },
  },
  {
    type: "emailMergeTag",
    label: "Merge tag",
    description: "A personalisation value inserted as a chip — never hand-typed.",
    kind: "inline",
    insertable: true,
    attrs: { path: "" },
  },
] as const;

export type EmailBlockTypeName = (typeof EMAIL_BLOCKS)[number]["type"];

/** `paddingY` tokens — the renderer maps these to px. No free-form values. */
export const PADDING_Y_TOKENS = ["none", "sm", "md", "lg"] as const;
export type PaddingYToken = (typeof PADDING_Y_TOKENS)[number];

export const ALIGN_TOKENS = ["left", "center", "right"] as const;
export type AlignToken = (typeof ALIGN_TOKENS)[number];

export const BUTTON_VARIANTS = ["primary", "secondary"] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

export const DIVIDER_VARIANTS = ["solid", "dashed"] as const;
export type DividerVariant = (typeof DIVIDER_VARIANTS)[number];

export const HEADING_LEVELS = [1, 2, 3] as const;

/**
 * Structural limits. The document is client-submitted JSON that becomes
 * recursive rendering work, so an unbounded tree is a free way to make the
 * server allocate without limit — the same reasoning as
 * `MAX_SEGMENT_DEPTH` in @loopkit/core's segments.
 */
export const EMAIL_DOC_LIMITS = {
  maxNodes: 500,
  maxDepth: 8,
  /** Per text node. */
  maxTextLength: 5_000,
  /** Serialized size of the document as submitted. */
  maxDocBytes: 256 * 1024,
  maxImageWidth: 1_200,
  maxImageHeight: 2_000,
  /** Rendered HTML ceiling — Gmail clips messages over ~102KB. */
  maxRenderedBytes: 100 * 1024,
} as const;

/**
 * Suggested merge-tag paths for the editor's chip picker.
 *
 * Not a whitelist: the email channel spreads a contact's own `properties` to
 * the top level of the render data, so any property key is a valid path and
 * cannot be enumerated without reading a real contact. The validator only
 * constrains the *shape* of a path, never the set.
 */
export const MERGE_TAG_SUGGESTIONS: readonly string[] = [
  "contact.email",
  "contact.firstName",
  "contact.lastName",
  "contact.plan",
  "contactId",
  "workspaceId",
] as const;
