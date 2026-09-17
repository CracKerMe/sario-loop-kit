import type {
  EmailProvider,
  NormalizedEmailEvent,
  SendEmailInput,
  SendEmailResult,
  WebhookRequest,
} from "../provider";

/** In-memory EmailProvider double — records every send, no network calls. */
export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  sends: SendEmailInput[] = [];
  nextMessageId = 0;
  shouldFail = false;
  private queuedEvents: NormalizedEmailEvent[] = [];

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (this.shouldFail) {
      throw new Error("fake provider send failure");
    }
    this.sends.push(input);
    return { messageId: `fake_msg_${this.nextMessageId++}` };
  }

  async parseWebhook(_request: WebhookRequest): Promise<NormalizedEmailEvent[]> {
    return this.queuedEvents;
  }

  queueWebhookEvent(event: NormalizedEmailEvent): void {
    this.queuedEvents.push(event);
  }
}
