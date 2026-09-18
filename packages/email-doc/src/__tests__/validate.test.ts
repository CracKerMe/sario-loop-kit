import { describe, expect, it } from "vitest";

import { EMAIL_DOC_PRESETS } from "../presets";
import type { EmailDocJson } from "../types";
import { assertValidEmailDoc, EmailDocValidationError, validateEmailDoc } from "../validate";

/** A valid single-section document builder used as a base for mutations. */
function baseDoc(): EmailDocJson {
  return {
    type: "doc",
    content: [
      {
        type: "emailSection",
        attrs: { paddingY: "md", backgroundColor: null },
        content: [
          {
            type: "emailHeading",
            attrs: { level: 1, align: "left" },
            content: [{ type: "text", text: "Title" }],
          },
          {
            type: "emailParagraph",
            attrs: { align: "left" },
            content: [{ type: "text", text: "Body copy" }],
          },
        ],
      },
    ],
  };
}

function expectInvalid(doc: unknown): void {
  const result = validateEmailDoc(doc);
  expect(result.valid, JSON.stringify(result.issues)).toBe(false);
  expect(result.issues.length).toBeGreaterThan(0);
}

function expectValid(doc: unknown): void {
  const result = validateEmailDoc(doc);
  expect(result.valid, JSON.stringify(result.issues)).toBe(true);
}

describe("validateEmailDoc — structural (ProseMirror gate)", () => {
  it("rejects an unknown node type", () => {
    expectInvalid({
      type: "doc",
      content: [
        {
          type: "emailSection",
          content: [{ type: "blockquote", content: [{ type: "text", text: "x" }] }],
        },
      ],
    });
  });

  it("rejects every StarterKit node the email format deliberately excludes", () => {
    for (const type of [
      "blockquote",
      "codeBlock",
      "code",
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
      "horizontalRule",
      "paragraph",
    ]) {
      expectInvalid({ type: "doc", content: [{ type: "emailSection", content: [{ type }] }] });
    }
  });

  it("rejects an unknown mark", () => {
    expectInvalid({
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
    });
  });

  it("rejects text directly inside the document", () => {
    expectInvalid({ type: "doc", content: [{ type: "text", text: "bare" }] });
  });

  it("requires at least one section (empty doc)", () => {
    expectInvalid({ type: "doc", content: [] });
  });

  it("does not let a section nest inside another section", () => {
    expectInvalid({
      type: "doc",
      content: [{ type: "emailSection", content: [{ type: "emailSection", content: [] }] }],
    });
  });

  it("rejects an empty text node", () => {
    expectInvalid({
      type: "doc",
      content: [
        {
          type: "emailSection",
          content: [{ type: "emailParagraph", content: [{ type: "text", text: "" }] }],
        },
      ],
    });
  });
});

describe("validateEmailDoc — value layer", () => {
  it("rejects over-long text", () => {
    const doc = baseDoc();
    (doc.content![0]!.content![1] as { content: unknown[] }).content = [
      { type: "text", text: "x".repeat(5001) },
    ];
    expectInvalid(doc);
  });

  it("rejects a relative href on a button", () => {
    const doc = baseDoc();
    (doc.content![0]!.content as unknown[]).push({
      type: "emailButton",
      attrs: { href: "/foo", variant: "primary", align: "left" },
      content: [{ type: "text", text: "Go" }],
    });
    expectInvalid(doc);
  });

  it("rejects javascript:/data:/vbscript: (including case variants) on a link mark", () => {
    for (const scheme of ["javascript:", "JavaScript:", "DATA:", "vbscript:", "DATA"]) {
      const doc = baseDoc();
      (doc.content![0]!.content![1] as { content: unknown[] }).content = [
        {
          type: "text",
          text: "x",
          marks: [{ type: "link", attrs: { href: `${scheme}:alert(1)` } }],
        },
      ];
      expectInvalid(doc);
    }
  });

  it("rejects javascript:/data: inside an image href", () => {
    const doc = baseDoc();
    (doc.content![0]!.content as unknown[]).push({
      type: "emailImage",
      attrs: {
        src: "https://example.com/a.png",
        alt: "A",
        width: 600,
        height: null,
        href: "javascript:alert(1)",
        align: "center",
      },
    });
    expectInvalid(doc);
  });

  it("accepts a merge-tag-only href", () => {
    const doc = baseDoc();
    (doc.content![0]!.content as unknown[]).push({
      type: "emailButton",
      attrs: { href: "{{contact.unsubscribeUrl}}", variant: "primary", align: "left" },
      content: [{ type: "text", text: "Unsubscribe" }],
    });
    expectValid(doc);
  });

  it("accepts an absolute http(s)/mailto/tel href and a mixed merge-tag href", () => {
    for (const href of [
      "https://example.com",
      "http://example.com",
      "mailto:hi@example.com",
      "tel:+15551234567",
      "https://{{contact.host}}/path",
    ]) {
      const doc = baseDoc();
      (doc.content![0]!.content as unknown[]).push({
        type: "emailButton",
        attrs: { href, variant: "primary", align: "left" },
        content: [{ type: "text", text: "Go" }],
      });
      expectValid(doc);
    }
  });

  it("rejects an invalid color (section backgroundColor)", () => {
    const doc = baseDoc();
    (doc.content![0] as { attrs: Record<string, unknown> }).attrs.backgroundColor = "red";
    expectInvalid(doc);
  });

  it("rejects an invalid inline text colour", () => {
    const doc = baseDoc();
    const text = doc.content?.[0]?.content?.[0]?.content?.[0];
    if (text?.type === "text") text.marks = [{ type: "textStyle", attrs: { color: "red" } }];
    expectInvalid(doc);
  });

  it("rejects an invalid color (divider color)", () => {
    const doc = baseDoc();
    (doc.content![0]!.content as unknown[]).push({
      type: "emailDivider",
      attrs: { variant: "solid", color: "#zzz" },
    });
    expectInvalid(doc);
  });

  it("accepts valid colors (#rgb and #rrggbb)", () => {
    const doc = baseDoc();
    (doc.content![0] as { attrs: Record<string, unknown> }).attrs.backgroundColor = "#f4f4f5";
    (doc.content![0]!.content as unknown[]).push({
      type: "emailDivider",
      attrs: { variant: "dashed", color: "#e4e4e7" },
    });
    expectValid(doc);
  });

  it("rejects an invalid enum (paddingY)", () => {
    const doc = baseDoc();
    (doc.content![0] as { attrs: Record<string, unknown> }).attrs.paddingY = "huge";
    expectInvalid(doc);
  });

  it("rejects an invalid enum (align, button variant, heading level, divider variant)", () => {
    const aligns: EmailDocJson[] = [];
    const d1 = baseDoc();
    (d1.content![0]!.content![1] as { attrs: Record<string, unknown> }).attrs.align = "justify";
    aligns.push(d1);

    const d2 = baseDoc();
    (d2.content![0]!.content as unknown[]).push({
      type: "emailButton",
      attrs: { href: "https://example.com", variant: "tertiary", align: "left" },
      content: [{ type: "text", text: "Go" }],
    });
    aligns.push(d2);

    const d3 = baseDoc();
    (d3.content![0]!.content![0] as { attrs: Record<string, unknown> }).attrs.level = 4;
    aligns.push(d3);

    const d4 = baseDoc();
    (d4.content![0]!.content as unknown[]).push({
      type: "emailDivider",
      attrs: { variant: "dotted", color: null },
    });
    aligns.push(d4);

    for (const doc of aligns) expectInvalid(doc);
  });

  it("rejects a non-integer / out-of-range image width and height", () => {
    const d1 = baseDoc();
    (d1.content![0]!.content as unknown[]).push({
      type: "emailImage",
      attrs: {
        src: "https://example.com/a.png",
        alt: "A",
        width: "600",
        height: null,
        align: "center",
      },
    });
    expectInvalid(d1);

    const d2 = baseDoc();
    (d2.content![0]!.content as unknown[]).push({
      type: "emailImage",
      attrs: {
        src: "https://example.com/a.png",
        alt: "A",
        width: 2000,
        height: null,
        align: "center",
      },
    });
    expectInvalid(d2);

    const d3 = baseDoc();
    (d3.content![0]!.content as unknown[]).push({
      type: "emailImage",
      attrs: {
        src: "https://example.com/a.png",
        alt: "A",
        width: 600,
        height: 5000,
        align: "center",
      },
    });
    expectInvalid(d3);
  });

  it("rejects an image with a missing/empty src or alt", () => {
    const noSrc = baseDoc();
    (noSrc.content![0]!.content as unknown[]).push({
      type: "emailImage",
      attrs: { src: "", alt: "A", width: 600, height: null, align: "center" },
    });
    expectInvalid(noSrc);

    const noAlt = baseDoc();
    (noAlt.content![0]!.content as unknown[]).push({
      type: "emailImage",
      attrs: {
        src: "https://example.com/a.png",
        alt: "",
        width: 600,
        height: null,
        align: "center",
      },
    });
    expectInvalid(noAlt);
  });

  it("rejects an invalid merge-tag path", () => {
    const doc = baseDoc();
    (doc.content![0]!.content![1] as { content: unknown[] }).content = [
      { type: "text", text: "Hi " },
      { type: "emailMergeTag", attrs: { path: "1bad.path" } },
    ];
    expectInvalid(doc);
  });

  it("rejects a button with an empty label", () => {
    const doc = baseDoc();
    (doc.content![0]!.content as unknown[]).push({
      type: "emailButton",
      attrs: { href: "https://example.com", variant: "primary", align: "left" },
      content: [],
    });
    expectInvalid(doc);
  });
});

describe("validateEmailDoc — structural limits", () => {
  it("rejects a document exceeding maxNodes", () => {
    const paragraphs = [];
    for (let i = 0; i < 600; i += 1) {
      paragraphs.push({
        type: "emailParagraph",
        attrs: { align: "left" },
        content: [{ type: "text", text: `p${i}` }],
      });
    }
    const doc: EmailDocJson = {
      type: "doc",
      content: [
        {
          type: "emailSection",
          attrs: { paddingY: "md", backgroundColor: null },
          content: paragraphs,
        },
      ],
    };
    expectInvalid(doc);
  });

  it("rejects a document exceeding maxDocBytes", () => {
    const huge = "x".repeat(300 * 1024);
    const doc: EmailDocJson = {
      type: "doc",
      content: [
        {
          type: "emailSection",
          attrs: { paddingY: "md", backgroundColor: null },
          content: [
            {
              type: "emailParagraph",
              attrs: { align: "left" },
              content: [{ type: "text", text: huge }],
            },
          ],
        },
      ],
    };
    expectInvalid(doc);
  });
});

describe("validateEmailDoc — collecting every issue", () => {
  it("returns all value errors at once, not just the first", () => {
    const doc = baseDoc();
    // Mutate the heading (level), paragraph (align) and add a bad button + bad image.
    (doc.content![0]!.content![0] as { attrs: Record<string, unknown> }).attrs.level = 9;
    (doc.content![0]!.content![1] as { attrs: Record<string, unknown> }).attrs.align = "justify";
    (doc.content![0]!.content as unknown[]).push(
      {
        type: "emailButton",
        attrs: { href: "javascript:evil()", variant: "primary", align: "left" },
        content: [{ type: "text", text: "Go" }],
      },
      {
        type: "emailImage",
        attrs: { src: "not-a-url", alt: "", width: 99999, height: null, align: "center" },
      },
    );
    const result = validateEmailDoc(doc);
    expect(result.valid).toBe(false);
    // At least: bad level, bad align, bad button href, bad image src, bad alt, bad width.
    expect(result.issues.length).toBeGreaterThanOrEqual(5);
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain("content.0.content.0.attrs.level");
    expect(paths).toContain("content.0.content.1.attrs.align");
    expect(paths).toContain("content.0.content.2.attrs.href");
    expect(paths).toContain("content.0.content.3.attrs.src");
  });
});

describe("validateEmailDoc — golden path", () => {
  it("accepts every shipped preset", () => {
    for (const preset of EMAIL_DOC_PRESETS) {
      expectValid(preset.doc);
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
              attrs: { href: "https://example.com", variant: "secondary" },
              content: [{ type: "text", text: "Go" }],
            },
            {
              type: "emailImage",
              attrs: {
                src: "https://example.com/a.png",
                alt: "A",
                width: 600,
                height: 200,
                href: "https://example.com",
                align: "center",
              },
            },
            { type: "emailDivider", attrs: { variant: "dashed" } },
          ],
        },
      ],
    };
    expectValid(doc);
  });

  it("never throws, even on garbage input", () => {
    expect(() => validateEmailDoc(null)).not.toThrow();
    expect(() => validateEmailDoc("not a doc")).not.toThrow();
    expect(() => validateEmailDoc({ type: "doc", content: [{ type: "nope" }] })).not.toThrow();
    expect(validateEmailDoc(null).valid).toBe(false);
  });
});

describe("assertValidEmailDoc", () => {
  it("returns the document when valid", () => {
    expect(assertValidEmailDoc(EMAIL_DOC_PRESETS[0]!.doc)).toBeDefined();
  });

  it("throws EmailDocValidationError when invalid", () => {
    expect(() => assertValidEmailDoc({ type: "doc", content: [] })).toThrow(
      EmailDocValidationError,
    );
  });
});
