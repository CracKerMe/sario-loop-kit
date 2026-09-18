import { describe, expect, it } from "vitest";

import { renderEmailDoc } from "@loopkit/email-doc";

import { renderTemplate } from "../render";
import type { EmailDocJson } from "@loopkit/email-doc";

/**
 * The sequential contract: `@loopkit/email-doc` renders merge tags to literal
 * `{{path}}` text, and `@loopkit/email`'s `renderTemplate` interpolates them
 * *afterwards*. This test is the gate that proves the ordering and that the
 * interpolation never regresses the renderer's hard guarantees.
 */

const ANNOUNCEMENT: EmailDocJson = {
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
            { type: "text", text: "Hi " },
            { type: "emailMergeTag", attrs: { path: "contact.firstName" } },
            { type: "text", text: ", welcome." },
          ],
        },
      ],
    },
  ],
};

describe("emailDoc → renderTemplate interop", () => {
  it("renders merge tags as literal {{path}} before interpolation", () => {
    const html = renderEmailDoc(ANNOUNCEMENT);
    expect(html).toContain("{{contact.firstName}}");
    // And it must NOT already be the contact value.
    expect(html).not.toContain("Ada");
  });

  it("interpolates a known path into the contact value", () => {
    const html = renderEmailDoc(ANNOUNCEMENT);
    const out = renderTemplate(html, { contact: { firstName: "Ada" } });
    expect(out).toContain("Hi Ada, welcome.");
    expect(out).not.toContain("{{contact.firstName}}");
  });

  it("HTML-escapes a dangerous interpolated value", () => {
    const html = renderEmailDoc(ANNOUNCEMENT);
    const out = renderTemplate(html, { contact: { firstName: "<script>alert(1)</script>" } });
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>alert(1)</script>");
  });

  it("leaves an unresolved path as a literal", () => {
    const html = renderEmailDoc(ANNOUNCEMENT);
    const out = renderTemplate(html, {});
    expect(out).toContain("{{contact.firstName}}");
  });

  it("keeps an unknown merge tag literal through the whole pipeline", () => {
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
              content: [{ type: "emailMergeTag", attrs: { path: "unknown" } }],
            },
          ],
        },
      ],
    };
    const html = renderEmailDoc(doc);
    expect(html).toContain("{{unknown}}");
    const out = renderTemplate(html, { contact: { firstName: "Ada" } });
    expect(out).toContain("{{unknown}}");
  });

  it("renderer output (pre-interpolation) contains no <style and no ${", () => {
    // The hard guarantee email-doc owns: its emitted HTML must never carry a
    // <style> block or a ${ token, because the engine's downstream renderTemplate
    // evaluates ${...}. So this is asserted on renderEmailDoc output directly.
    const html = renderEmailDoc(ANNOUNCEMENT);
    expect(html.toLowerCase()).not.toContain("<style");
    expect(html).not.toContain("${");
  });

  it("output still contains no <style and no ${ after interpolation", () => {
    // A hostile but $-free value: <script> must be HTML-escaped by renderTemplate,
    // and since the value carries no $, no ${ token can survive into the output.
    const html = renderEmailDoc(ANNOUNCEMENT);
    const out = renderTemplate(html, { contact: { firstName: "Ada</script>evil" } });
    expect(out.toLowerCase()).not.toContain("<style");
    expect(out).not.toContain("${");
    expect(out).toContain("&lt;/script&gt;");
  });
});
