import { describe, expect, it } from "vitest";

import {
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeUrl,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../unsubscribe";

/**
 * These tokens are the only authorization on a public endpoint that can
 * change a recipient's send permission, so the negative cases matter more
 * than the happy path: a token that can be edited, or that never expires,
 * is a capability leak into every archived copy of every marketing email.
 */
const SECRET = "test-secret-that-is-at-least-32-chars-long";
const PAYLOAD = {
  workspaceId: "ws-1",
  contactId: "contact-1",
  email: "Sam@Example.com",
};

describe("unsubscribe tokens", () => {
  it("round-trips a payload", () => {
    const token = createUnsubscribeToken(PAYLOAD, SECRET);
    const verified = verifyUnsubscribeToken(token, SECRET);
    expect(verified).not.toBeNull();
    expect(verified?.workspaceId).toBe("ws-1");
    expect(verified?.contactId).toBe("contact-1");
    // Normalised at signing time, so lookups against suppression rows (which
    // are stored lowercased) can't miss on case.
    expect(verified?.email).toBe("sam@example.com");
  });

  it("carries journey/campaign attribution when present", () => {
    const token = createUnsubscribeToken(
      { ...PAYLOAD, journeyId: "journey-1", campaignId: "campaign-1" },
      SECRET,
    );
    const verified = verifyUnsubscribeToken(token, SECRET);
    expect(verified?.journeyId).toBe("journey-1");
    expect(verified?.campaignId).toBe("campaign-1");
  });

  it("rejects a token signed with a different secret", () => {
    const token = createUnsubscribeToken(PAYLOAD, SECRET);
    expect(verifyUnsubscribeToken(token, "another-secret-that-is-32-chars-long!!")).toBeNull();
  });

  it("rejects a payload edited to point at another contact", () => {
    const token = createUnsubscribeToken(PAYLOAD, SECRET);
    const encoded = token.split(".")[0]!;
    const signature = token.split(".")[1]!;
    const body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    body.c = "someone-elses-contact";
    const tampered = `${Buffer.from(JSON.stringify(body), "utf8").toString("base64url")}.${signature}`;

    expect(verifyUnsubscribeToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a swapped signature", () => {
    const a = createUnsubscribeToken(PAYLOAD, SECRET);
    const b = createUnsubscribeToken({ ...PAYLOAD, contactId: "contact-2" }, SECRET);
    const encodedA = a.split(".")[0]!;
    const signatureB = b.split(".")[1]!;
    expect(verifyUnsubscribeToken(`${encodedA}.${signatureB}`, SECRET)).toBeNull();
  });

  it("rejects malformed tokens without throwing", () => {
    for (const bad of ["", ".", "abc", "a.b.c", "not-base64.not-base64", "..."]) {
      expect(() => verifyUnsubscribeToken(bad, SECRET)).not.toThrow();
      expect(verifyUnsubscribeToken(bad, SECRET)).toBeNull();
    }
  });

  it("rejects a well-signed token whose payload is not the expected shape", () => {
    // Signed by the right key but missing required fields — must not be
    // treated as valid just because the HMAC checks out.
    const encoded = Buffer.from(JSON.stringify({ w: "ws-1", exp: 9_999_999_999 }), "utf8").toString(
      "base64url",
    );
    const signature = createUnsubscribeToken(PAYLOAD, SECRET).split(".")[1]!;
    expect(verifyUnsubscribeToken(`${encoded}.${signature}`, SECRET)).toBeNull();
  });

  it("expires", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const token = createUnsubscribeToken(PAYLOAD, SECRET, { now: issued, ttlSeconds: 3600 });

    expect(verifyUnsubscribeToken(token, SECRET, new Date("2026-01-01T00:59:59Z"))).not.toBeNull();
    expect(verifyUnsubscribeToken(token, SECRET, new Date("2026-01-01T01:00:01Z"))).toBeNull();
  });

  it("outlives a realistic inbox lifetime by default", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const token = createUnsubscribeToken(PAYLOAD, SECRET, { now: issued });
    // An unsubscribe link sits in archives for years of realistic list-hygiene
    // cycles; the default must not be a marketing-cycle-short TTL.
    expect(verifyUnsubscribeToken(token, SECRET, new Date("2026-06-01T00:00:00Z"))).not.toBeNull();
    expect(verifyUnsubscribeToken(token, SECRET, new Date("2027-09-01T00:00:00Z"))).toBeNull();
  });

  it("is URL-safe with no characters a mail client might rewrite", () => {
    const url = buildOneClickUnsubscribeUrl("https://api.example.com/", PAYLOAD, SECRET);
    const token = new URL(url).searchParams.get("token")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  it("builds the page URL and the one-click API URL from the same payload", () => {
    const pageUrl = buildUnsubscribeUrl("https://app.example.com/", PAYLOAD, SECRET);
    const apiUrl = buildOneClickUnsubscribeUrl("https://api.example.com/", PAYLOAD, SECRET);
    expect(pageUrl.startsWith("https://app.example.com/unsubscribe?token=")).toBe(true);
    expect(apiUrl.startsWith("https://api.example.com/v1/public/unsubscribe?token=")).toBe(true);

    // Same token: one is the human page, the other the RFC 8058 POST target.
    const pageToken = new URL(pageUrl).searchParams.get("token");
    const apiToken = new URL(apiUrl).searchParams.get("token");
    expect(pageToken).toBe(apiToken);
    expect(verifyUnsubscribeToken(apiToken!, SECRET)?.contactId).toBe("contact-1");
  });
});
