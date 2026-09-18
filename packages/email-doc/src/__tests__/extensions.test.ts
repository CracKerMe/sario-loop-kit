import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { emailExtensions, emailSchema } from "../extensions";
import { EMAIL_DOC_PRESETS } from "../presets";
import type { EmailDocJson } from "../types";

/**
 * Smoke coverage for the frozen schema contract.
 *
 * The point of this file is to fail loudly if the schema ever stops being the
 * hard gate everything downstream assumes it is: the server rejects a document
 * by letting `Node.fromJSON` throw, so "does it actually throw?" is the single
 * most load-bearing question about this package.
 */
/**
 * The full validation recipe, and the reason it is two calls rather than one:
 * `Node.fromJSON` resolves node and mark *types* (throwing on an unknown one)
 * and checks attribute types — but it does **not** validate content
 * expressions. `{type:"doc", content: []}` and a section nested inside a
 * section both deserialize happily and only blow up later, in the renderer.
 * `node.check()` is the call that walks the tree and enforces content
 * expressions. Verified against prosemirror-model 1.25.11.
 */
function fromJson(doc: unknown) {
  const node = ProseMirrorNode.fromJSON(emailSchema(), doc);
  node.check();
  return node;
}

describe("email document schema", () => {
  it("builds", () => {
    const schema = emailSchema();
    expect(schema.topNodeType.name).toBe("doc");
    // The marks have to be in the schema or a bold document would be
    // unrenderable *and* unsaveable.
    expect(Object.keys(schema.marks).sort()).toEqual(["bold", "italic", "link", "underline"]);
  });

  it("accepts every shipped preset", () => {
    for (const preset of EMAIL_DOC_PRESETS) {
      expect(() => fromJson(preset.doc), `preset ${preset.id}`).not.toThrow();
    }
  });

  it("accepts a full document exercising every block and mark", () => {
    const doc: EmailDocJson = {
      type: "doc",
      content: [
        {
          type: "emailSection",
          attrs: { paddingY: "lg", backgroundColor: "#f4f4f5" },
          content: [
            {
              type: "emailHeading",
              attrs: { level: 2, align: "center" },
              content: [{ type: "text", text: "Heading", marks: [{ type: "bold" }] }],
            },
            {
              type: "emailParagraph",
              attrs: { align: "left" },
              content: [
                { type: "text", text: "Hi " },
                { type: "emailMergeTag", attrs: { path: "contact.firstName" } },
                { type: "text", text: ", ", marks: [{ type: "italic" }] },
                {
                  type: "text",
                  text: "read more",
                  marks: [
                    { type: "link", attrs: { href: "https://example.com" } },
                    { type: "underline" },
                  ],
                },
              ],
            },
            {
              type: "emailButton",
              attrs: { href: "https://example.com", variant: "primary" },
              content: [{ type: "text", text: "Go" }],
            },
            {
              type: "emailImage",
              attrs: { src: "https://example.com/a.png", alt: "A", width: 600, height: 200 },
            },
            { type: "emailDivider", attrs: { variant: "dashed" } },
          ],
        },
      ],
    };
    expect(() => fromJson(doc)).not.toThrow();
  });

  it("rejects an unknown node type instead of silently dropping it", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "emailSection",
          content: [{ type: "blockquote", content: [{ type: "text", text: "nope" }] }],
        },
      ],
    };
    expect(() => fromJson(doc)).toThrow(/Unknown node type/i);
  });

  it("rejects every StarterKit node the email format deliberately excludes", () => {
    // Each of these is a way to produce a template that looks right in the
    // editor and collapses in a mail client.
    for (const type of [
      "blockquote",
      "codeBlock",
      "code",
      "heading",
      "bulletList",
      "horizontalRule",
      "paragraph",
    ]) {
      const doc = { type: "doc", content: [{ type: "emailSection", content: [{ type }] }] };
      expect(() => fromJson(doc), type).toThrow(/Unknown node type/i);
    }
  });

  it("rejects text directly inside the document", () => {
    expect(() => fromJson({ type: "doc", content: [{ type: "text", text: "bare" }] })).toThrow();
  });

  it("requires at least one section", () => {
    expect(() => fromJson({ type: "doc", content: [] })).toThrow();
  });

  it("does not let a section nest inside another section", () => {
    const doc = {
      type: "doc",
      content: [{ type: "emailSection", content: [{ type: "emailSection", content: [] }] }],
    };
    expect(() => fromJson(doc)).toThrow();
  });

  it("rejects an unknown mark", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "emailSection",
          content: [
            {
              type: "emailParagraph",
              content: [{ type: "text", text: "x", marks: [{ type: "strike" }] }],
            },
          ],
        },
      ],
    };
    expect(() => fromJson(doc)).toThrow();
  });

  it("hands each caller its own extension instances", () => {
    // Sharing one list between a live editor and the server's schema is the
    // aliasing bug this factory exists to avoid.
    expect(emailExtensions()).not.toBe(emailExtensions());
  });
});
