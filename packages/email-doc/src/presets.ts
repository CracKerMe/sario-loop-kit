import type { EmailDocJson } from "./types";

/**
 * Starting documents for the editor.
 *
 * Same reasoning as the journey builder's presets: a blank canvas makes the
 * first useful thing harder to reach than it should be, and every preset here
 * is already valid — it renders, it survives the validator, and it uses the
 * blocks in the way they are meant to be used (a section per background band,
 * one button, images with dimensions).
 */
export interface EmailDocPreset {
  id: string;
  label: string;
  description: string;
  doc: EmailDocJson;
}

function section(
  content: EmailDocJson["content"],
  attrs: Record<string, unknown> = {},
): NonNullable<EmailDocJson["content"]>[number] {
  return { type: "emailSection", attrs: { paddingY: "md", ...attrs }, content: content ?? [] };
}

export const EMAIL_DOC_PRESETS: readonly EmailDocPreset[] = [
  {
    id: "announcement",
    label: "Announcement",
    description: "Heading, a couple of paragraphs and a call to action.",
    doc: {
      type: "doc",
      content: [
        section([
          {
            type: "emailHeading",
            attrs: { level: 1, align: "left" },
            content: [{ type: "text", text: "Something new just shipped" }],
          },
          {
            type: "emailParagraph",
            attrs: { align: "left" },
            content: [
              { type: "text", text: "Hi " },
              { type: "emailMergeTag", attrs: { path: "contact.firstName" } },
              { type: "text", text: ", here is what changed this week." },
            ],
          },
          {
            type: "emailParagraph",
            attrs: { align: "left" },
            content: [
              {
                type: "text",
                text: "A short second paragraph, so the email does not read as a single wall of text.",
              },
            ],
          },
          {
            type: "emailButton",
            attrs: { href: "https://example.com", variant: "primary", align: "left" },
            content: [{ type: "text", text: "See what's new" }],
          },
        ]),
      ],
    },
  },
  {
    id: "plain",
    label: "Plain note",
    description: "Heading and one paragraph. No button, no image — the least likely to be clipped.",
    doc: {
      type: "doc",
      content: [
        section([
          {
            type: "emailHeading",
            attrs: { level: 2, align: "left" },
            content: [{ type: "text", text: "A quick note" }],
          },
          {
            type: "emailParagraph",
            attrs: { align: "left" },
            content: [{ type: "text", text: "Write your message here." }],
          },
        ]),
      ],
    },
  },
  {
    id: "blank",
    label: "Blank",
    description: "One empty section to build from.",
    doc: {
      type: "doc",
      content: [
        section([
          {
            type: "emailParagraph",
            attrs: { align: "left" },
            // `content: []`, not `[{type:"text", text:""}]`: ProseMirror
            // rejects empty text nodes outright ("Empty text nodes are not
            // allowed"), so an empty paragraph is expressed by having no
            // children at all.
            content: [],
          },
        ]),
      ],
    },
  },
] as const;

/** The document a new template starts from when no preset is chosen. */
export function emptyEmailDoc(): EmailDocJson {
  return structuredClone(EMAIL_DOC_PRESETS[2]!.doc) as EmailDocJson;
}

export function findEmailDocPreset(id: string): EmailDocPreset | undefined {
  return EMAIL_DOC_PRESETS.find((preset) => preset.id === id);
}
