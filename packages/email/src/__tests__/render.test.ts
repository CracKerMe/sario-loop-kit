import { describe, expect, it } from "vitest";

import { renderTemplate } from "../render";

describe("renderTemplate", () => {
  it("substitutes a dotted path and HTML-escapes it by default", () => {
    const out = renderTemplate("Hi {{firstName}}!", { firstName: "Sam" });
    expect(out).toBe("Hi Sam!");
  });

  it("escapes HTML-significant characters in substituted values", () => {
    const out = renderTemplate("Name: {{name}}", { name: '<script>alert("x")</script>' });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("does not touch literal ${...} in the template — no expression evaluation", () => {
    const out = renderTemplate("price: ${amount}", { amount: 5 });
    expect(out).toBe("price: ${amount}");
  });

  it("resolves nested dotted paths", () => {
    const out = renderTemplate("{{contact.firstName}} <{{contact.email}}>", {
      contact: { firstName: "Ada", email: "ada@example.com" },
    });
    expect(out).toBe("Ada <ada@example.com>");
  });

  it("leaves an unresolved path as-is rather than throwing", () => {
    const out = renderTemplate("Hi {{missing.path}}!", {});
    expect(out).toBe("Hi {{missing.path}}!");
  });

  it("triple-brace renders raw, unescaped HTML", () => {
    const out = renderTemplate("{{{body}}}", { body: "<b>bold</b>" });
    expect(out).toBe("<b>bold</b>");
  });

  it("double-brace still escapes even when a triple-brace value exists elsewhere", () => {
    const out = renderTemplate("{{{raw}}} and {{escaped}}", {
      raw: "<i>x</i>",
      escaped: "<i>x</i>",
    });
    expect(out).toBe("<i>x</i> and &lt;i&gt;x&lt;/i&gt;");
  });

  it("renders numbers and booleans as their string form", () => {
    const out = renderTemplate("count={{count}} active={{active}}", { count: 3, active: true });
    expect(out).toBe("count=3 active=true");
  });
});
