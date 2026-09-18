import { describe, expect, it } from "vitest";

import {
  COMMUNITY_EMAIL_TEMPLATES,
  COMMUNITY_TEMPLATE_CATEGORIES,
  communityTemplatesByCategory,
  findCommunityTemplate,
} from "../communityTemplates";
import { renderEmailDoc } from "../render";
import { EMAIL_DOC_LIMITS } from "../types";
import { validateEmailDoc } from "../validate";

/**
 * A shipped template that does not render is worse than no template at all:
 * the user meets it at the moment they are least equipped to debug it. These
 * assertions are the same contract the presets are held to, plus the ones
 * specific to a gallery (unique ids, a real subject, no lorem ipsum).
 */

describe("community templates — document validity", () => {
  for (const template of COMMUNITY_EMAIL_TEMPLATES) {
    it(`"${template.id}" is a valid email document`, () => {
      const result = validateEmailDoc(template.doc);
      expect(result.valid, JSON.stringify(result.valid ? [] : result.issues)).toBe(true);
    });

    it(`"${template.id}" renders to a complete HTML document`, () => {
      const html = renderEmailDoc(template.doc);
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html.trimEnd().endsWith("</html>")).toBe(true);
    });

    it(`"${template.id}" stays under the Gmail clipping ceiling`, () => {
      expect(Buffer.byteLength(renderEmailDoc(template.doc), "utf8")).toBeLessThan(
        EMAIL_DOC_LIMITS.maxRenderedBytes,
      );
    });
  }
});

describe("community templates — gallery metadata", () => {
  it("has unique ids", () => {
    const ids = COMMUNITY_EMAIL_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every template a non-empty label, description and subject", () => {
    for (const t of COMMUNITY_EMAIL_TEMPLATES) {
      expect(t.label.trim(), t.id).not.toBe("");
      expect(t.description.trim(), t.id).not.toBe("");
      expect(t.subject.trim(), t.id).not.toBe("");
      expect(t.tags.length, t.id).toBeGreaterThan(0);
    }
  });

  it("only uses declared categories, and every category has at least one template", () => {
    const declared = new Set(COMMUNITY_TEMPLATE_CATEGORIES.map((c) => c.id));
    for (const t of COMMUNITY_EMAIL_TEMPLATES) expect(declared.has(t.category), t.id).toBe(true);
    for (const c of COMMUNITY_TEMPLATE_CATEGORIES) {
      expect(communityTemplatesByCategory(c.id).length, c.id).toBeGreaterThan(0);
    }
  });

  it("resolves a template by id and returns undefined for an unknown one", () => {
    expect(findCommunityTemplate(COMMUNITY_EMAIL_TEMPLATES[0]!.id)?.id).toBe(
      COMMUNITY_EMAIL_TEMPLATES[0]!.id,
    );
    expect(findCommunityTemplate("no-such-template")).toBeUndefined();
  });
});

describe("community templates — content quality", () => {
  it("contains no unresolved-looking merge tags in subjects", () => {
    // A subject is interpolated against renderData (contact properties spread
    // to the top level plus a `contact` object). @loopkit/email's
    // renderTemplate leaves an unresolved path as literal text, so a tag for
    // anything outside that shape ships a broken subject line.
    for (const t of COMMUNITY_EMAIL_TEMPLATES) {
      const paths = [...t.subject.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!);
      for (const path of paths) {
        expect(
          path === "contact" || path.startsWith("contact."),
          `${t.id}: subject uses {{${path}}}, which renderData does not provide`,
        ).toBe(true);
      }
    }
  });

  it("uses no images, so no template can ship a dead asset URL", () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: string; content?: unknown[] };
      expect(n.type).not.toBe("emailImage");
      if (Array.isArray(n.content)) n.content.forEach(walk);
    };
    for (const t of COMMUNITY_EMAIL_TEMPLATES) t.doc.content?.forEach(walk);
  });

  it("gives marketing-shaped templates an unsubscribe link", () => {
    // Transactional templates must NOT carry one — "unsubscribing" from a
    // receipt or a password reset is a compliance bug, and the send path
    // already omits List-Unsubscribe for them.
    for (const t of COMMUNITY_EMAIL_TEMPLATES) {
      const html = renderEmailDoc(t.doc);
      const hasUnsubscribe = /unsubscribe/i.test(html);
      expect(hasUnsubscribe, `${t.id} (${t.category})`).toBe(t.category !== "transactional");
    }
  });

  it("uses no placeholder filler copy", () => {
    for (const t of COMMUNITY_EMAIL_TEMPLATES) {
      const html = renderEmailDoc(t.doc);
      expect(html.toLowerCase(), t.id).not.toContain("lorem ipsum");
      expect(html, t.id).not.toContain("TODO");
    }
  });
});
