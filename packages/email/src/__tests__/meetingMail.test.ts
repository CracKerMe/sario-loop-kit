import { describe, expect, it } from "vitest";

import {
  composeBookingConfirmation,
  composeHostAssignment,
  composeMeetingReminder,
  sendMeetingMail,
  type EmailAttachment,
  type EmailProvider,
  type SendEmailInput,
  type SendEmailResult,
} from "@loopkit/email";

class RecordingProvider implements EmailProvider {
  readonly name = "recording";
  readonly sent: SendEmailInput[] = [];
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sent.push(input);
    return { messageId: `msg-${this.sent.length}` };
  }
  async parseWebhook() {
    return [];
  }
}

const baseData = {
  meetingId: "m-1",
  title: "Intro call",
  startsAt: new Date("2026-03-01T15:00:00Z"),
  endsAt: new Date("2026-03-01T15:30:00Z"),
  timezone: "UTC",
  notes: "Wants pricing",
  guest: { email: "buyer@acme.com", name: "Buyer" },
  host: { email: "ann@acme.com", name: "Ann" },
  organizer: { email: "hello@acme.com", name: "Acme" },
  manageUrl: "https://app.test/m/m-1",
  calendarFeedUrl: "https://app.test/v1/calendar/tok.ics",
  ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
  icsFilename: "intro.ics",
};

describe("meeting mail composition", () => {
  it("composes a booking confirmation with an .ics attachment", () => {
    const mail = composeBookingConfirmation(baseData);
    expect(mail.to).toBe("buyer@acme.com");
    expect(mail.subject).toBe("Confirmed: Intro call");
    expect(mail.html).toContain("You're booked");
    expect(mail.html).toContain("Buyer");
    expect(mail.text).toContain("Intro call");
    expect(mail.attachments).toHaveLength(1);
    const att: EmailAttachment = mail.attachments![0]!;
    expect(att.filename).toBe("intro.ics");
    expect(att.contentType).toContain("text/calendar");
    expect(att.content).toContain("BEGIN:VCALENDAR");
  });

  it("composes a reminder with hour / day labels", () => {
    const h2 = composeMeetingReminder(baseData, 2);
    expect(h2.subject).toContain("in 2 hours");
    const d1 = composeMeetingReminder(baseData, 24);
    expect(d1.subject).toContain("in 1 day");
    const d2 = composeMeetingReminder(baseData, 48);
    expect(d2.subject).toContain("in 2 days");
    expect(h2.attachments).toHaveLength(1);
  });

  it("composes a host assignment notice to the host", () => {
    const mail = composeHostAssignment(baseData);
    expect(mail.to).toBe("ann@acme.com");
    expect(mail.subject).toBe("New meeting: Intro call");
    expect(mail.html).toContain("buyer@acme.com");
  });

  it("throws when composing a host notice without a host email", () => {
    expect(() => composeHostAssignment({ ...baseData, host: null })).toThrow("host_email_required");
  });

  it("omits the attachment when no ics is provided", () => {
    const mail = composeBookingConfirmation({ ...baseData, ics: null });
    expect(mail.attachments).toBeUndefined();
  });
});

describe("sendMeetingMail", () => {
  it("routes through the provider with from/replyTo", async () => {
    const provider = new RecordingProvider();
    const mail = composeBookingConfirmation(baseData);
    const result = await sendMeetingMail(provider, {
      from: "hello@acme.com",
      replyTo: "sales@acme.com",
      mail,
      tags: { type: "meeting-confirmation" },
    });
    expect(result.messageId).toBe("msg-1");
    const sent = provider.sent[0]!;
    expect(sent.to).toBe("buyer@acme.com");
    expect(sent.from).toBe("hello@acme.com");
    expect(sent.replyTo).toBe("sales@acme.com");
    expect(sent.attachments).toHaveLength(1);
    expect(sent.tags).toEqual({ type: "meeting-confirmation" });
  });
});
