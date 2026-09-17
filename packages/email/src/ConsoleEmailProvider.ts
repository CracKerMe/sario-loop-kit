import type {
  EmailProvider,
  NormalizedEmailEvent,
  SendEmailInput,
  SendEmailResult,
  WebhookRequest,
} from "./provider";

/**
 * Logs sends to the console instead of calling a real provider. Useful
 * for local development and demos where a Resend API key isn't
 * configured yet — the engine's retry/DLQ machinery and the
 * email_send/email_delivery bookkeeping all behave identically to a
 * real provider, only the actual network call is skipped.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  private counter = 0;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const messageId = `console_${Date.now()}_${this.counter++}`;
    console.log(`[ConsoleEmailProvider] would send email`, {
      messageId,
      to: input.to,
      from: input.from,
      subject: input.subject,
      htmlPreview: input.html.slice(0, 200),
    });
    return { messageId };
  }

  async parseWebhook(_request: WebhookRequest): Promise<NormalizedEmailEvent[]> {
    return [];
  }
}
