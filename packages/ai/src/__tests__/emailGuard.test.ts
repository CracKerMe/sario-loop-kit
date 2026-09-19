import { describe, expect, it } from "vitest";
import { EMAIL_DOC_PRESETS } from "@loopkit/email-doc";
import { guardEmailContent } from "../emailGuard";
import { AiGraphError } from "../graphGuard";

/** The announcement preset is guaranteed valid by email-doc's own suites. */
const validDoc = structuredClone(EMAIL_DOC_PRESETS[0]!.doc);

describe("guardEmailContent", () => {
  it("passes a well-formed envelope and drops injected keys", () => {
    const out = guardEmailContent({
      subject: "Welcome aboard",
      doc: validDoc,
      // injected junk next to the envelope — must not survive
      action: "drop table contacts",
      metadata: { promptInjection: true },
    });
    expect(out.subject).toBe("Welcome aboard");
    expect(out.doc).toEqual(validDoc);
    expect(Object.keys(out)).toEqual(["subject", "doc"]);
  });

  it("extracts JSON from a string payload", () => {
    const out = guardEmailContent(JSON.stringify({ subject: "Hi", doc: validDoc }));
    expect(out.subject).toBe("Hi");
  });

  it("rejects a missing or empty subject with a named issue", () => {
    expect(() => guardEmailContent({ doc: validDoc })).toThrow(AiGraphError);
    expect(() => guardEmailContent({ subject: "   ", doc: validDoc })).toThrow(/non-empty string/);
  });

  it("rejects an over-long subject", () => {
    expect(() => guardEmailContent({ subject: "x".repeat(501), doc: validDoc })).toThrow(
      /exceeds 500/,
    );
  });

  it("rejects a missing doc", () => {
    expect(() => guardEmailContent({ subject: "Hi" })).toThrow(/`doc` is required/);
  });

  it("feeds back validator issues for an unknown node type", () => {
    const dirty = structuredClone(validDoc);
    (dirty.content![0] as { content?: unknown[] }).content!.push({
      type: "script",
      attrs: { src: "https://evil.example/x.js" },
    });
    try {
      guardEmailContent({ subject: "Hi", doc: dirty });
      expect.unreachable("guard should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiGraphError);
      expect((err as AiGraphError).issues.length).toBeGreaterThan(0);
      expect((err as AiGraphError).message).toMatch(/failed validation/);
    }
  });

  it("feeds back validator issues for a non-absolute button href", () => {
    const dirty = structuredClone(validDoc);
    const section = dirty.content![0] as {
      content?: { type: string; attrs?: Record<string, unknown> }[];
    };
    const button = section.content!.find((n) => n.type === "emailButton")!;
    button.attrs!.href = "javascript:alert(1)";
    try {
      guardEmailContent({ subject: "Hi", doc: dirty });
      expect.unreachable("guard should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AiGraphError);
      expect((err as AiGraphError).issues.join(" ")).toMatch(/href/i);
    }
  });

  it("rejects non-object payloads", () => {
    expect(() => guardEmailContent(null)).toThrow(AiGraphError);
    expect(() => guardEmailContent([1, 2])).toThrow(AiGraphError);
    expect(() => guardEmailContent("not json at all {")).toThrow(AiGraphError);
  });
});
