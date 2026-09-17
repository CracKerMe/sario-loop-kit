import { createHmac, timingSafeEqual } from "node:crypto";
import { Resend } from "resend";

import type {
  EmailProvider,
  NormalizedEmailEvent,
  SendEmailInput,
  SendEmailResult,
  WebhookRequest,
} from "./provider";

const EVENT_TYPE_MAP: Record<string, NormalizedEmailEvent["type"] | undefined> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delivery_delayed",
};

interface ResendWebhookEvent {
  type: string;
  created_at: string;
  data: { email_id: string; click?: { link?: string } };
}

export class ResendProvider implements EmailProvider {
  readonly name = "resend";
  private readonly client: Resend;

  constructor(
    apiKey: string,
    /** Resend's per-endpoint webhook signing secret (starts with `whsec_`). */
    private readonly webhookSecret?: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const { data, error } = await this.client.emails.send({
      from: input.from,
      to: input.to,
      replyTo: input.replyTo,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.headers,
      tags: input.tags
        ? Object.entries(input.tags).map(([name, value]) => ({ name, value }))
        : undefined,
    });

    if (error || !data) {
      throw new Error(`Resend send failed: ${error?.message ?? "unknown error"}`);
    }

    return { messageId: data.id };
  }

  /**
   * Verifies Resend's Svix-based webhook signature and normalizes the
   * event. Never trust the body without this — anyone who knows a send's
   * providerMessageId could otherwise forge delivery/bounce events.
   *
   * Svix signs `${id}.${timestamp}.${body}` with HMAC-SHA256 using the
   * base64-decoded portion of the secret after its `whsec_` prefix, and
   * sends one or more base64 `v1,<sig>` signatures in `svix-signature`
   * (space-separated) — verification passes if ANY of them matches.
   */
  async parseWebhook(request: WebhookRequest): Promise<NormalizedEmailEvent[]> {
    if (this.webhookSecret) {
      this.verifySignature(request);
    }

    const event = JSON.parse(request.body) as ResendWebhookEvent;
    const type = EVENT_TYPE_MAP[event.type];
    if (!type) return [];

    const svixId = request.headers["svix-id"] ?? request.headers["Svix-Id"];
    return [
      {
        // svix-id is the header Resend sets for replay dedup; if a caller
        // disabled signature verification (no secret configured) it may
        // be absent, so fall back to a value derived from the payload —
        // still stable for a given delivery, just not attacker-resistant.
        providerEventId: svixId ?? `${event.data.email_id}:${event.type}:${event.created_at}`,
        providerMessageId: event.data.email_id,
        type,
        url: event.data.click?.link,
        occurredAt: new Date(event.created_at),
        raw: event,
      },
    ];
  }

  private verifySignature(request: WebhookRequest): void {
    const secret = this.webhookSecret;
    if (!secret) return;

    const id = request.headers["svix-id"] ?? request.headers["Svix-Id"];
    const timestamp = request.headers["svix-timestamp"] ?? request.headers["Svix-Timestamp"];
    const signatureHeader = request.headers["svix-signature"] ?? request.headers["Svix-Signature"];
    if (!id || !timestamp || !signatureHeader) {
      throw new Error("Resend webhook missing svix-id/svix-timestamp/svix-signature headers");
    }

    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const signedContent = `${id}.${timestamp}.${request.body}`;
    // digest("base64") already returns the base64-encoded signature — do
    // NOT re-encode it. It must be compared as bytes against each
    // candidate's own base64-decoded bytes, not compared as an ASCII
    // string of base64 characters (that would compare the wrong things
    // and never match a real signature).
    const expectedBuf = createHmac("sha256", secretBytes).update(signedContent).digest();

    const candidates = signatureHeader
      .split(" ")
      .map((part) => part.split(",")[1])
      .filter((part): part is string => Boolean(part));
    const verified = candidates.some((candidate) => {
      const candidateBuf = Buffer.from(candidate, "base64");
      return (
        candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)
      );
    });

    if (!verified) {
      throw new Error("Resend webhook signature verification failed");
    }
  }
}
