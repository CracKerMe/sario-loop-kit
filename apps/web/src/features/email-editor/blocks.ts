import {
  ALIGN_TOKENS,
  BUTTON_VARIANTS,
  DIVIDER_VARIANTS,
  EMAIL_BLOCKS,
  HEADING_LEVELS,
  PADDING_Y_TOKENS,
  type EmailBlockType,
  type EmailNodeJson,
} from "@loopkit/email-doc";
import type { Editor } from "@tiptap/react";

export type AttrKind = "enum" | "text" | "number" | "color";

export interface AttrControl {
  name: string;
  label: string;
  kind: AttrKind;
  /** Allowed token values for `enum` controls. */
  options?: readonly (string | number)[];
}

const ATTR_META: Record<string, { kind: AttrKind; label: string }> = {
  backgroundColor: { kind: "color", label: "Background" },
  paddingY: { kind: "enum", label: "Vertical padding" },
  level: { kind: "enum", label: "Heading level" },
  align: { kind: "enum", label: "Alignment" },
  href: { kind: "text", label: "Link URL" },
  variant: { kind: "enum", label: "Variant" },
  src: { kind: "text", label: "Image URL" },
  alt: { kind: "text", label: "Alt text" },
  width: { kind: "number", label: "Width (px)" },
  height: { kind: "number", label: "Height (px)" },
  color: { kind: "color", label: "Color" },
  path: { kind: "text", label: "Merge path" },
};

/** Build the property controls for a block from its catalogue entry. */
export function getAttrControls(type: EmailBlockType): AttrControl[] {
  const def = EMAIL_BLOCKS.find((b) => b.type === type);
  if (!def) return [];
  return Object.keys(def.attrs).map((name) => {
    const meta = ATTR_META[name] ?? { kind: "text" as AttrKind, label: name };
    const control: AttrControl = { name, label: meta.label, kind: meta.kind };
    if (meta.kind === "enum") {
      control.options =
        name === "align"
          ? ALIGN_TOKENS
          : name === "paddingY"
            ? PADDING_Y_TOKENS
            : name === "level"
              ? HEADING_LEVELS
              : name === "variant"
                ? type === "emailDivider"
                  ? DIVIDER_VARIANTS
                  : BUTTON_VARIANTS
                : [];
    }
    return control;
  });
}

/** A sensible starter node (with defaults) for inserting a block. */
export function defaultNodeFor(type: EmailBlockType): EmailNodeJson {
  switch (type) {
    case "emailSection":
      return {
        type,
        attrs: { backgroundColor: null, paddingY: "md" },
        content: [{ type: "emailParagraph", attrs: { align: "left" }, content: [] }],
      };
    case "emailHeading":
      return {
        type,
        attrs: { level: 1, align: "left" },
        content: [{ type: "text", text: "Heading" }],
      };
    case "emailParagraph":
      return {
        type,
        attrs: { align: "left" },
        content: [{ type: "text", text: "Write your message" }],
      };
    case "emailButton":
      return {
        type,
        attrs: { href: "https://example.com", variant: "primary", align: "left" },
        content: [{ type: "text", text: "Button" }],
      };
    case "emailImage":
      return {
        type,
        attrs: { src: "", alt: "", width: 600, height: null, href: null, align: "center" },
      };
    case "emailDivider":
      return { type, attrs: { variant: "solid", color: null } };
    case "emailMergeTag":
      return { type, attrs: { path: "contact.firstName" } };
  }
}

/** Insert a block. Sections append to the document; others insert at the caret. */
export function insertEmailBlock(editor: Editor, type: EmailBlockType): void {
  if (type === "emailSection") {
    editor
      .chain()
      .focus()
      .insertContentAt(editor.state.doc.content.size, defaultNodeFor("emailSection"))
      .run();
    return;
  }
  editor.chain().focus().insertContent(defaultNodeFor(type)).run();
}

/** Insert a merge-tag chip inline at the caret. */
export function insertMergeTag(editor: Editor, path: string): void {
  const clean = path.trim();
  if (!clean) return;
  editor
    .chain()
    .focus()
    .insertContent({ type: "emailMergeTag", attrs: { path: clean } })
    .run();
}

/** The email block nearest the current selection (section, block, or inline). */
export function activeEmailNode(
  editor: Editor,
): { type: EmailBlockType; attrs: Record<string, unknown> } | null {
  const selection = editor.state.selection;
  for (let depth = selection.$from.depth; depth >= 1; depth--) {
    const node = selection.$from.node(depth);
    if (node && EMAIL_BLOCKS.some((b) => b.type === node.type.name)) {
      return { type: node.type.name as EmailBlockType, attrs: { ...node.attrs } };
    }
  }
  return null;
}

/** The enclosing section (band) of the current selection, with its position. */
export function enclosingSection(
  editor: Editor,
): { pos: number; attrs: Record<string, unknown> } | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    if (node && node.type.name === "emailSection") {
      return { pos: $from.before(depth), attrs: { ...node.attrs } };
    }
  }
  return null;
}

/** Update the attributes of the enclosing section regardless of caret position. */
export function updateSectionAttrs(editor: Editor, partial: Record<string, unknown>): void {
  const section = enclosingSection(editor);
  if (!section) return;
  editor.commands.command(({ tr }) => {
    tr.setNodeMarkup(section.pos, undefined, { ...section.attrs, ...partial });
    return true;
  });
}
