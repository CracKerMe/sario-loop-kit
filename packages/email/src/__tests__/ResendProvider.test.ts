import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ResendProvider } from "../ResendProvider";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"; // fake, self-consistent test secret

function sign(id: string, timestamp: string, body: string, secret: string): string {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${id}.${timestamp}.${body}`;
  const sig = createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  return `v1,${sig}`;
}

function makeEvent(type: string, emailId = "msg_123") {
  return JSON.stringify({
    type,
    created_at: "2026-09-17T00:00:00.000Z",
    data: { email_id: emailId },
  });
}

describe("ResendProvider.parseWebhook", () => {
  it("accepts a correctly-signed payload and normalizes the event", async () => {
    const provider = new ResendProvider("re_fake_api_key", SECRET);
    const body = makeEvent("email.delivered");
    const id = "msg_abc";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(id, timestamp, body, SECRET);

    const events = await provider.parseWebhook({
      body,
      headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "delivered",
      providerMessageId: "msg_123",
      providerEventId: id,
    });
  });

  it("rejects a payload with an invalid signature", async () => {
    const provider = new ResendProvider("re_fake_api_key", SECRET);
    const body = makeEvent("email.delivered");
    const id = "msg_abc";
    const timestamp = String(Math.floor(Date.now() / 1000));

    await expect(
      provider.parseWebhook({
        body,
        headers: {
          "svix-id": id,
          "svix-timestamp": timestamp,
          "svix-signature": "v1,not-a-real-signature",
        },
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const provider = new ResendProvider("re_fake_api_key", SECRET);
    const body = makeEvent("email.delivered");
    const id = "msg_abc";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const wrongSignature = sign(id, timestamp, body, "whsec_wrongwrongwrongwrongwrongwrong");

    await expect(
      provider.parseWebhook({
        body,
        headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": wrongSignature },
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("rejects a tampered body even with a signature that was valid for the original body", async () => {
    const provider = new ResendProvider("re_fake_api_key", SECRET);
    const originalBody = makeEvent("email.delivered");
    const id = "msg_abc";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(id, timestamp, originalBody, SECRET);
    const tamperedBody = makeEvent("email.bounced"); // attacker flips the event type

    await expect(
      provider.parseWebhook({
        body: tamperedBody,
        headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature },
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("throws when required svix headers are missing", async () => {
    const provider = new ResendProvider("re_fake_api_key", SECRET);
    await expect(
      provider.parseWebhook({ body: makeEvent("email.delivered"), headers: {} }),
    ).rejects.toThrow(/missing svix-id/);
  });

  it("skips signature verification when no webhook secret is configured", async () => {
    const provider = new ResendProvider("re_fake_api_key"); // no secret
    const body = makeEvent("email.opened");
    const events = await provider.parseWebhook({ body, headers: {} });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("opened");
  });

  it("maps click events and extracts the clicked URL", async () => {
    const provider = new ResendProvider("re_fake_api_key");
    const body = JSON.stringify({
      type: "email.clicked",
      created_at: "2026-09-17T00:00:00.000Z",
      data: { email_id: "msg_456", click: { link: "https://example.com/promo" } },
    });
    const events = await provider.parseWebhook({ body, headers: {} });
    expect(events[0]?.url).toBe("https://example.com/promo");
  });

  it("returns an empty array for an event type it doesn't recognize", async () => {
    const provider = new ResendProvider("re_fake_api_key");
    const body = JSON.stringify({
      type: "email.sent",
      created_at: "2026-09-17T00:00:00.000Z",
      data: { email_id: "x" },
    });
    const events = await provider.parseWebhook({ body, headers: {} });
    expect(events).toHaveLength(0);
  });
});
