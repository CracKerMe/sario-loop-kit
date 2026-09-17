export interface SendEmailInput {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  /** Provider-side correlation tags (e.g. Resend's `tags`). */
  tags?: Record<string, string>;
}

export interface SendEmailResult {
  messageId: string;
}

export interface NormalizedEmailEvent {
  /** Used for webhook replay dedup — e.g. Resend's `svix-id`. */
  providerEventId: string;
  providerMessageId: string;
  type: "delivered" | "opened" | "clicked" | "bounced" | "complained" | "delivery_delayed";
  url?: string;
  occurredAt: Date;
  raw: unknown;
}

export interface WebhookRequest {
  body: string;
  headers: Record<string, string>;
}

export interface EmailProvider {
  readonly name: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
  /**
   * Parse and verify a provider webhook payload into normalized events.
   * Must verify the request's signature — never trust the body alone.
   * Throws if verification fails.
   */
  parseWebhook(request: WebhookRequest): Promise<NormalizedEmailEvent[]>;
}
