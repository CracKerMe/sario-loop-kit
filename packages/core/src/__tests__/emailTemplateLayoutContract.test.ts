import { EMAIL_DOC_PRESETS, EMAIL_DOC_LIMITS, type EmailDocJson } from "@loopkit/email-doc";
import { workspace } from "@loopkit/db/schema";
import { beforeEach, describe, expect, it } from "vitest";

import { createEmailTemplate, renderTemplateDoc } from "../emailTemplates";
import { resetTables, testDb } from "./testDb";

const db = testDb();

/**
 * Adversarial verification of the **stored** email artefact.
 *
 * Written by the team lead independently of the renderer's own test suite, on
 * purpose: a renderer's tests assert what its author believed the contract was,
 * so they cannot catch a contract the author misread. This file checks the HTML
 * that `createEmailTemplate` actually persists — i.e. byte-for-byte what a
 * recipient will receive — against the layout allow-list.
 *
 * Every rule here traces to a concrete mail-client behaviour, not to taste:
 *
 * | Rule | Why |
 * | --- | --- |
 * | no `<style>` | Gmail strips it after a forward, so layout must not depend on it |
 * | no flex/grid/float/position/z-index | Outlook's Word engine ignores all of it |
 * | every `<table role="presentation">` | otherwise a screen reader announces a data table |
 * | `cellpadding/cellspacing/border="0"` | Word engine adds gutter/borders by default |
 * | `width`/`alt`/`display:block` on every image | blocked images and Outlook's attribute-based sizing |
 * | no padding on `<a>` | Word engine ignores padding on inline elements |
 * | no text directly in table/tr/tbody | stray text outside a cell breaks Word's table layout |
 * | < 100KB | Gmail clips beyond ~102KB |
 */

const FORBIDDEN_DECLARATIONS = [
  "display:flex",
  "display:grid",
  "float:",
  "position:",
  "z-index",
] as const;

/** Every opening tag of the given name, with its attributes, as raw strings. */
function openingTags(html: string, name: string): string[] {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
}

/**
 * Entities a renderer may legitimately use where the raw character would be
 * ambiguous. Decoding before asserting on *user copy* is the right invariant:
 * what must survive is the text a recipient reads, not one particular encoding
 * of it.
 */
function decodeEntities(html: string): string {
  return html
    .replaceAll("&#36;", "$")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function assertLayoutContract(html: string, label: string): void {
  const context = ` (${label})`;

  expect(html, context).not.toContain("<style");
  for (const declaration of FORBIDDEN_DECLARATIONS) {
    expect(html, `${context} must not contain ${declaration}`).not.toContain(declaration);
  }
  const tables = openingTags(html, "table");
  expect(tables.length, `${context} should use layout tables`).toBeGreaterThan(0);
  for (const table of tables) {
    expect(table, `${context}: ${table}`).toContain('role="presentation"');
    expect(table, `${context}: ${table}`).toContain('cellpadding="0"');
    expect(table, `${context}: ${table}`).toContain('cellspacing="0"');
    expect(table, `${context}: ${table}`).toContain('border="0"');
  }

  for (const img of openingTags(html, "img")) {
    expect(img, `${context}: ${img}`).toContain("width");
    expect(img, `${context}: ${img}`).toContain("alt=");
    expect(img, `${context}: ${img}`).toContain("display:block");
  }

  // Outlook ignores padding on an inline element, so a button's padding must
  // live on its wrapping cell.
  for (const anchor of openingTags(html, "a")) {
    expect(anchor, `${context}: <a> must not carry padding — ${anchor}`).not.toContain("padding");
  }

  // Text must never be a direct child of a table section: Word lays those out
  // as stray content outside the grid.
  expect(html, `${context} has text directly inside a table`).not.toMatch(
    /<(?:table|thead|tbody|tr)\b[^>]*>\s*[^<\s]/i,
  );

  expect(html, context).not.toContain("<button");

  expect(
    Buffer.byteLength(html, "utf8"),
    `${context} exceeds the Gmail clipping ceiling`,
  ).toBeLessThan(EMAIL_DOC_LIMITS.maxRenderedBytes);
}

/** A document using every block and mark the format allows. */
const EVERYTHING: EmailDocJson = {
  type: "doc",
  content: [
    {
      type: "emailSection",
      attrs: { paddingY: "lg", backgroundColor: "#f4f4f5" },
      content: [
        {
          type: "emailHeading",
          attrs: { level: 1, align: "center" },
          content: [{ type: "text", text: "Everything at once", marks: [{ type: "bold" }] }],
        },
        {
          type: "emailParagraph",
          attrs: { align: "left" },
          content: [
            { type: "text", text: "Hi " },
            { type: "emailMergeTag", attrs: { path: "contact.firstName" } },
            { type: "text", text: " — ", marks: [{ type: "italic" }] },
            {
              type: "text",
              text: "a link",
              marks: [
                { type: "link", attrs: { href: "https://example.com/x" } },
                { type: "underline" },
              ],
            },
            { type: "text", text: "." },
          ],
        },
        {
          type: "emailButton",
          attrs: { href: "https://example.com/cta", variant: "primary", align: "center" },
          content: [{ type: "text", text: "Do the thing" }],
        },
        {
          type: "emailButton",
          attrs: { href: "https://example.com/secondary", variant: "secondary", align: "right" },
          content: [{ type: "text", text: "Not now" }],
        },
        {
          type: "emailImage",
          attrs: {
            src: "https://example.com/banner.png",
            alt: "A banner",
            width: 600,
            height: 220,
            align: "center",
          },
        },
        { type: "emailDivider", attrs: { variant: "dashed", color: "#d4d4d8" } },
      ],
    },
    {
      type: "emailSection",
      attrs: { paddingY: "none" },
      content: [
        {
          type: "emailParagraph",
          attrs: { align: "right" },
          // Merge tag as the whole href: the downstream interpolator supplies
          // the real URL, so the validator has to accept it.
          content: [
            {
              type: "text",
              text: "Unsubscribe",
              marks: [{ type: "link", attrs: { href: "{{contact.unsubscribeUrl}}" } }],
            },
          ],
        },
      ],
    },
  ],
};

describe("stored email artefact satisfies the layout contract", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  });

  it("holds for every shipped preset", () => {
    for (const preset of EMAIL_DOC_PRESETS) {
      const { html } = renderTemplateDoc(preset.doc);
      assertLayoutContract(html, `preset:${preset.id}`);
    }
  });

  it("holds for a document exercising every block, mark and attribute", () => {
    const { html } = renderTemplateDoc(EVERYTHING);
    assertLayoutContract(html, "everything");
  });

  it("produces byte-identical output for identical input", () => {
    // Determinism is what allows the rendered HTML to be cached in a column and
    // asserted at all; a timestamp or map-order dependence would break both.
    expect(renderTemplateDoc(EVERYTHING).html).toBe(renderTemplateDoc(EVERYTHING).html);
  });

  it("preserves merge tags as literal text for the downstream interpolator", () => {
    const { html, mergeTags } = renderTemplateDoc(EVERYTHING);
    expect(html).toContain("{{contact.firstName}}");
    expect(html).toContain("{{contact.unsubscribeUrl}}");
    expect(mergeTags).toEqual(["contact.firstName", "contact.unsubscribeUrl"]);
  });

  it("emits no `${` in markup the renderer generates itself", () => {
    // `${` is the workflow engine's expression syntax. The email body never
    // goes through that evaluator (see @loopkit/email's render.ts), but keeping
    // our own output free of the sequence means a future change that does route
    // it there cannot turn template markup into executable code.
    for (const preset of EMAIL_DOC_PRESETS) {
      expect(renderTemplateDoc(preset.doc).html, preset.id).not.toContain("${");
    }
    expect(renderTemplateDoc(EVERYTHING).html).not.toContain("${");
  });

  it("preserves user copy verbatim as rendered text, including `${` and `{{`", () => {
    // The renderer escapes `$` as `&#36;`, which is strictly better than
    // leaving `${` in the markup: the sequence never appears in the output, so
    // a future change that routed the body through the engine's `${}` evaluator
    // could not execute it — while a mail client still displays `${...}`.
    // The invariant that must hold is therefore about the *decoded* text.
    const original = "Set it with ${process.env.TOKEN} in your shell.";
    const doc: EmailDocJson = {
      type: "doc",
      content: [
        {
          type: "emailSection",
          content: [
            { type: "emailParagraph", content: [{ type: "text", text: original }] },
            {
              type: "emailParagraph",
              content: [{ type: "text", text: "Braces like {{name}} are also just text here." }],
            },
          ],
        },
      ],
    };

    const { html } = renderTemplateDoc(doc);
    const displayed = decodeEntities(html);
    expect(displayed).toContain(original);
    // The merge tag survives untouched — it is real markup to the interpolator,
    // not text, so it must NOT be entity-encoded.
    expect(html).toContain("{{name}}");
  });

  it("holds for the html that was actually persisted, not just the renderer's return value", async () => {
    const template = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Contract",
      subject: "s",
      doc: EVERYTHING,
    });

    // The end of the story: this string is what the email channel will send.
    assertLayoutContract(template.html, "persisted");
    expect(template.html).toBe(renderTemplateDoc(EVERYTHING).html);
  });

  it("keeps the rendered size sane for a realistic long template", () => {
    // 40 paragraphs is a long newsletter; the ceiling issue is real, not
    // theoretical, so it is worth measuring at a plausible upper bound.
    const longDoc: EmailDocJson = {
      type: "doc",
      content: [
        {
          type: "emailSection",
          content: Array.from({ length: 40 }, () => ({
            type: "emailParagraph",
            attrs: { align: "left" },
            content: [
              {
                type: "text",
                text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
                  3,
                ),
              },
            ],
          })),
        },
      ],
    };
    const { html } = renderTemplateDoc(longDoc);
    assertLayoutContract(html, "long");
  });
});
