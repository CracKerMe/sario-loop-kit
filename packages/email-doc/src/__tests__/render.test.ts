import { describe, expect, it } from "vitest";

import { EMAIL_DOC_PRESETS } from "../presets";
import type { EmailDocJson } from "../types";
import { EMAIL_DOC_LIMITS } from "../types";
import { emailDocToPlainText, extractMergeTagPaths, renderEmailDoc } from "../render";

/** Returns the raw text of every `<table ...>` opening tag in the HTML. */
function tableTags(html: string): string[] {
  const out: string[] = [];
  const re = /<table\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[0]!);
  return out;
}

/** Returns the raw text of every `<img ...>` tag. */
function imgTags(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[0]!);
  return out;
}

/** Returns the raw text of every `<a ...>` opening tag. */
function anchorTags(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[0]!);
  return out;
}

const FORBIDDEN_TOKENS = [
  "<style",
  "display:flex",
  "display: grid",
  "display:grid",
  "float:",
  "position:",
  "z-index",
  "${",
];

function assertAllowList(html: string): void {
  for (const token of FORBIDDEN_TOKENS) {
    expect(html.toLowerCase().includes(token.toLowerCase()), `must not contain ${token}`).toBe(
      false,
    );
  }
  for (const tag of tableTags(html)) {
    expect(tag).toContain('role="presentation"');
    expect(tag).toContain('cellpadding="0"');
    expect(tag).toContain('cellspacing="0"');
    expect(tag).toContain('border="0"');
    expect(tag.toLowerCase()).toContain("border-collapse:collapse");
  }
  for (const tag of imgTags(html)) {
    expect(tag).toContain("width=");
    expect(tag).toContain("alt=");
    expect(tag.toLowerCase()).toContain("display:block");
  }
  for (const tag of anchorTags(html)) {
    expect(tag.toLowerCase()).not.toContain("padding");
  }
  // Text must never sit directly under a table/tbody/tr.
  expect(html).not.toMatch(/<(table|tbody|tr)\b[^>]*>\s*[^\s<]/i);
}

const FULL_DOC: EmailDocJson = {
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
          type: "emailButton",
          attrs: { href: "https://example.com", variant: "secondary" },
          content: [{ type: "text", text: "Go" }],
        },
        {
          type: "emailImage",
          attrs: {
            src: "https://example.com/a.png",
            alt: "An image",
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

describe("renderEmailDoc — document shape", () => {
  for (const preset of EMAIL_DOC_PRESETS) {
    it(`produces a complete HTML document for preset "${preset.id}"`, () => {
      const html = renderEmailDoc(preset.doc);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html");
      expect(html).toContain('<meta charset="utf-8">');
      expect(html).toContain('name="viewport"');
      expect(html).toContain("<body");
      expect(html).toContain("</html>");
    });
  }

  it("produces a complete HTML document for the full block/mark doc", () => {
    const html = renderEmailDoc(FULL_DOC);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });
});

describe("renderEmailDoc — determinism", () => {
  it("renders the same document identically across calls", () => {
    for (const preset of EMAIL_DOC_PRESETS) {
      expect(renderEmailDoc(preset.doc)).toBe(renderEmailDoc(preset.doc));
    }
    expect(renderEmailDoc(FULL_DOC)).toBe(renderEmailDoc(FULL_DOC));
  });
});

describe("renderEmailDoc — layout allow-list", () => {
  it("satisfies the allow-list for every preset and the full doc", () => {
    for (const preset of EMAIL_DOC_PRESETS) assertAllowList(renderEmailDoc(preset.doc));
    assertAllowList(renderEmailDoc(FULL_DOC));
  });

  it("gives the content column both max-width and a width attribute", () => {
    const html = renderEmailDoc(EMAIL_DOC_PRESETS[0]!.doc);
    // width="600" attribute and max-width:600px inline style both present.
    expect(html).toContain('width="600"');
    expect(html.toLowerCase()).toContain("max-width:600px");
  });

  it("renders merge tags as literal {{path}} text", () => {
    const html = renderEmailDoc(EMAIL_DOC_PRESETS[0]!.doc);
    expect(html).toContain("{{contact.firstName}}");
  });
});

describe("renderEmailDoc — size", () => {
  it("stays under maxRenderedBytes", () => {
    for (const preset of EMAIL_DOC_PRESETS) {
      expect(Buffer.byteLength(renderEmailDoc(preset.doc), "utf8")).toBeLessThan(
        EMAIL_DOC_LIMITS.maxRenderedBytes,
      );
    }
    expect(Buffer.byteLength(renderEmailDoc(FULL_DOC), "utf8")).toBeLessThan(
      EMAIL_DOC_LIMITS.maxRenderedBytes,
    );
  });
});

describe("renderEmailDoc — fail-closed", () => {
  it("throws on an invalid document instead of emitting partial HTML", () => {
    expect(() => renderEmailDoc({ type: "doc", content: [] })).toThrow();
    // And it must not return a string that looks like a document.
    let threw = false;
    try {
      renderEmailDoc({
        type: "doc",
        content: [{ type: "emailSection", content: [{ type: "paragraph" }] }],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("emailDocToPlainText", () => {
  it("renders blocks line-by-line with blank lines between", () => {
    const text = emailDocToPlainText(FULL_DOC);
    expect(text).toContain("Heading");
    expect(text).toContain("Hi {{contact.firstName}}, read more");
    expect(text).toContain("Go (https://example.com)");
    expect(text).toContain("[image: An image]");
    expect(text).toContain("---");
    // blank line between blocks
    expect(text).toContain("\n\n");
  });

  it("returns an empty string for invalid input", () => {
    expect(emailDocToPlainText({ type: "doc", content: [] })).toBe("");
  });
});

describe("extractMergeTagPaths", () => {
  it("returns deduplicated, first-seen-order paths", () => {
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
              content: [
                { type: "emailMergeTag", attrs: { path: "contact.firstName" } },
                { type: "emailMergeTag", attrs: { path: "contact.firstName" } },
                { type: "emailMergeTag", attrs: { path: "workspaceId" } },
              ],
            },
            {
              type: "emailButton",
              attrs: { href: "{{contact.unsubscribeUrl}}" },
              content: [{ type: "text", text: "X" }],
            },
          ],
        },
      ],
    };
    expect(extractMergeTagPaths(doc)).toEqual([
      "contact.firstName",
      "workspaceId",
      "contact.unsubscribeUrl",
    ]);
  });

  it("collects merge tags from URL attributes (button href, link-mark href, image src/href)", () => {
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
              content: [
                {
                  type: "text",
                  text: "manage",
                  marks: [{ type: "link", attrs: { href: "https://{{contact.host}}/manage" } }],
                },
              ],
            },
            {
              type: "emailButton",
              attrs: { href: "{{contact.preferencesUrl}}", variant: "primary", align: "center" },
              content: [{ type: "text", text: "Preferences" }],
            },
            {
              type: "emailImage",
              attrs: {
                src: "{{contact.bannerUrl}}",
                alt: "Banner",
                width: 600,
                height: null,
                href: "{{contact.unsubscribeUrl}}",
                align: "center",
              },
            },
          ],
        },
      ],
    };
    expect(extractMergeTagPaths(doc)).toEqual([
      "contact.host",
      "contact.preferencesUrl",
      "contact.bannerUrl",
      "contact.unsubscribeUrl",
    ]);
  });

  it("does not collect merge tags from colour attributes", () => {
    const doc: EmailDocJson = {
      type: "doc",
      content: [
        {
          type: "emailSection",
          attrs: { paddingY: "md", backgroundColor: null },
          content: [
            {
              type: "emailDivider",
              attrs: { variant: "dashed", color: "#d4d4d8" },
            },
          ],
        },
      ],
    };
    expect(extractMergeTagPaths(doc)).toEqual([]);
  });
});
