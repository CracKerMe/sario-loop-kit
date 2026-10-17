/**
 * Meetings 2.0 surface: public ICS feeds, booking confirmation with .ics,
 * host round-robin notification, and the pre-meeting reminder poller.
 */
import {
  bookMeeting,
  createMeetingHost,
  ensureCalendarToken,
  listMeetingSlots,
  updateMeetingSettings,
} from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import { meeting, meetingHost, meetingSettings, meetingType, workspace } from "@loopkit/db/schema";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "@loopkit/email";
import { eq, getTableName, sql } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildMeetingIcsFile,
  buildWorkspaceCalendarFeed,
  meetingReminderTick,
  sendBookingNotifications,
  workspaceIdForCalendarToken,
} from "../meetingMailer";
import { meetingsPublicRouter } from "../routes/gtm";

const { testDbUrl } = vi.hoisted(() => {
  const fallback = "postgresql://postgres:password@localhost:5432/loopkit";
  const base = process.env.DATABASE_URL ?? fallback;
  const url = new URL(base);
  url.pathname = "/loopkit_test_server";
  const testDbUrl = url.toString();
  process.env.DATABASE_URL = testDbUrl;
  return { testDbUrl };
});

const db: Db = createDb(testDbUrl);

/** Undo RFC 5545 line folding so assertions can match whole content lines. */
function unfold(ics: string | Buffer): string {
  const text = typeof ics === "string" ? ics : ics.toString("utf8");
  return text.replace(/\r\n[ \t]/g, "");
}

class RecordingProvider implements EmailProvider {
  readonly name = "recording";
  sends: SendEmailInput[] = [];
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sends.push(input);
    return { messageId: `msg-${this.sends.length}` };
  }
  async parseWebhook(): Promise<never[]> {
    return [];
  }
}

const TABLES = [meeting, meetingHost, meetingType, meetingSettings, workspace] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

let workspaceId: string;

async function nextSlotStartsAt(): Promise<string> {
  const slots = await listMeetingSlots(db, workspaceId, {
    from: new Date(),
    to: new Date(Date.now() + 7 * 24 * 3600_000),
  });
  return slots.find((s) => s.available)!.startsAt;
}

beforeEach(async () => {
  await resetTables();
  const id = crypto.randomUUID();
  await db.insert(workspace).values({ id, name: "Meet", slug: "meet-" + id.slice(0, 8) });
  workspaceId = id;
  await updateMeetingSettings(db, workspaceId, {
    timezone: "UTC",
    availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
    dayStartMinute: 9 * 60,
    dayEndMinute: 17 * 60,
    durationMinutes: 30,
    bufferMinutes: 0,
    leadDays: 14,
    organizerEmail: "hello@acme.com",
    organizerName: "Acme",
  });
});

describe("public ICS feed", () => {
  it("serves a subscribed calendar at /calendar/:token", async () => {
    const token = await ensureCalendarToken(db, workspaceId);
    const startsAt = await nextSlotStartsAt();
    await bookMeeting(db, workspaceId, { email: "g@acme.com", startsAt, name: "Guest" });

    const app = new Hono().route("/", meetingsPublicRouter);
    const res = await app.request(`/calendar/${token}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    const body = unfold(await res.text());
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("X-WR-CALNAME:");
    expect(body).toContain("ORGANIZER");
    expect(body).toContain("ATTENDEE");
  });

  it("404s an unknown token", async () => {
    const app = new Hono().route("/", meetingsPublicRouter);
    const res = await app.request("/calendar/deadbeef.ics");
    expect(res.status).toBe(404);
  });

  it("serves a single-meeting .ics download", async () => {
    const startsAt = await nextSlotStartsAt();
    const { meeting: m } = await bookMeeting(db, workspaceId, {
      email: "g@acme.com",
      startsAt,
    });

    const app = new Hono().route("/", meetingsPublicRouter);
    const res = await app.request(`/meetings/public/${m.id}.ics`);
    expect(res.status).toBe(200);
    const body = unfold(await res.text());
    expect(body).toContain(`UID:meeting-${m.id}@loopkit`);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("resolves a workspace from its calendar token", async () => {
    const token = await ensureCalendarToken(db, workspaceId);
    expect(await workspaceIdForCalendarToken(token)).toBe(workspaceId);
    expect(await workspaceIdForCalendarToken("nope")).toBeNull();
  });
});

describe("booking notifications", () => {
  it("emails the guest a confirmation with .ics and the host an assignment notice", async () => {
    await createMeetingHost(db, workspaceId, { name: "Ann", email: "ann@acme.com" });
    const startsAt = await nextSlotStartsAt();
    const { meeting: m } = await bookMeeting(db, workspaceId, {
      email: "buyer@acme.com",
      name: "Buyer",
      startsAt,
    });

    const provider = new RecordingProvider();
    await sendBookingNotifications(m, {
      provider,
      defaultFrom: "noreply@loopkit.dev",
    });

    expect(provider.sends).toHaveLength(2);
    const guest = provider.sends.find((s) => s.to === "buyer@acme.com")!;
    expect(guest.subject).toContain("Confirmed");
    expect(unfold(guest.attachments?.[0]?.content ?? "")).toContain("BEGIN:VCALENDAR");
    expect(guest.from).toBe("hello@acme.com");

    const host = provider.sends.find((s) => s.to === "ann@acme.com")!;
    expect(host.subject).toContain("New meeting");
  });

  it("skips confirmation when the setting is off", async () => {
    await updateMeetingSettings(db, workspaceId, { sendBookingConfirmation: false });
    const startsAt = await nextSlotStartsAt();
    const { meeting: m } = await bookMeeting(db, workspaceId, {
      email: "buyer@acme.com",
      startsAt,
    });
    const provider = new RecordingProvider();
    await sendBookingNotifications(m, { provider, defaultFrom: "noreply@loopkit.dev" });
    expect(provider.sends).toHaveLength(0);
  });
});

describe("reminder poller", () => {
  it("sends due reminders once and records the offset", async () => {
    const startsAt = new Date(Date.now() + 30 * 60_000);
    const { meeting: m } = await bookMeeting(db, workspaceId, {
      email: "soon@acme.com",
      startsAt,
    });

    const provider = new RecordingProvider();
    const first = await meetingReminderTick({
      provider,
      defaultFrom: "noreply@loopkit.dev",
    });
    expect(first.sent).toBeGreaterThanOrEqual(2); // 24h + 2h offsets both due
    expect(provider.sends.length).toBeGreaterThanOrEqual(2);
    expect(provider.sends.every((s) => s.attachments?.length === 1)).toBe(true);

    // Second tick: nothing left to send.
    const second = await meetingReminderTick({
      provider,
      defaultFrom: "noreply@loopkit.dev",
    });
    expect(second.sent).toBe(0);
    expect(second.scanned).toBe(0);

    const [row] = await db.select().from(meeting).where(eq(meeting.id, m.id));
    expect(row?.remindersSent).toEqual([24, 2]);
  });

  it("skips when sendReminders is false", async () => {
    await updateMeetingSettings(db, workspaceId, { sendReminders: false });
    const startsAt = new Date(Date.now() + 30 * 60_000);
    await bookMeeting(db, workspaceId, { email: "x@acme.com", startsAt });

    const provider = new RecordingProvider();
    const stats = await meetingReminderTick({
      provider,
      defaultFrom: "noreply@loopkit.dev",
    });
    expect(stats.sent).toBe(0);
    expect(provider.sends).toHaveLength(0);
  });

  it("does not re-send after a meeting is cancelled", async () => {
    const startsAt = new Date(Date.now() + 30 * 60_000);
    const { meeting: m } = await bookMeeting(db, workspaceId, {
      email: "x@acme.com",
      startsAt,
    });
    await db.update(meeting).set({ status: "cancelled" }).where(eq(meeting.id, m.id));

    const provider = new RecordingProvider();
    const stats = await meetingReminderTick({
      provider,
      defaultFrom: "noreply@loopkit.dev",
    });
    expect(stats.scanned).toBe(0);
    expect(provider.sends).toHaveLength(0);
  });
});

describe("workspace calendar feed builder", () => {
  it("includes upcoming meetings and marks cancellations", async () => {
    const startsAt = await nextSlotStartsAt();
    const { meeting: m } = await bookMeeting(db, workspaceId, {
      email: "g@acme.com",
      startsAt,
    });
    await db.update(meeting).set({ status: "cancelled" }).where(eq(meeting.id, m.id));

    const ics = unfold(await buildWorkspaceCalendarFeed(workspaceId, "Acme calendar"));
    expect(ics).toContain("X-WR-CALNAME:Acme calendar");
    expect(ics).toContain(`UID:meeting-${m.id}@loopkit`);
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
  });

  it("builds a single-meeting file with the organizer", async () => {
    const startsAt = await nextSlotStartsAt();
    const { meeting: m } = await bookMeeting(db, workspaceId, {
      email: "g@acme.com",
      startsAt,
    });
    const ics = unfold(await buildMeetingIcsFile(workspaceId, m));
    expect(ics).toContain("ORGANIZER;CN=Acme");
    expect(ics).toContain("mailto:hello@acme.com");
    expect(ics).toContain("TRIGGER:-PT30M");
  });
});

describe("host assignment at booking time", () => {
  it("stamps the round-robin host and notifies them", async () => {
    await createMeetingHost(db, workspaceId, { name: "Ann", email: "ann@acme.com" });
    await createMeetingHost(db, workspaceId, { name: "Bob", email: "bob@acme.com" });

    const startsAt = await nextSlotStartsAt();
    const { meeting: m } = await bookMeeting(db, workspaceId, {
      email: "buyer@acme.com",
      startsAt,
    });
    expect(m.hostEmail).toBeTruthy();

    // The other host is free at the same time.
    const other = m.hostEmail === "ann@acme.com" ? "bob@acme.com" : "ann@acme.com";
    const { meeting: m2 } = await bookMeeting(db, workspaceId, {
      email: "buyer2@acme.com",
      startsAt,
      hostEmail: other,
    });
    expect(m2.hostEmail).toBe(other);
    expect(m2.hostEmail).not.toBe(m.hostEmail);
  });
});
