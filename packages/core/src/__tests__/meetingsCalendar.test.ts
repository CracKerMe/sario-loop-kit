import { beforeEach, describe, expect, it } from "vitest";

import {
  assignMeetingHost,
  bookMeeting,
  buildMeetingIcs,
  buildVCalendar,
  buildVEvent,
  createMeetingHost,
  ensureCalendarToken,
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  generateCalendarToken,
  getOrCreateMeetingSettings,
  listActiveMeetingHosts,
  listDueMeetingReminders,
  listMeetingHosts,
  listMeetingSlots,
  listMeetingsForCalendar,
  markAllMeetingRemindersSent,
  markMeetingReminderSent,
  meetingToIcsEvent,
  updateMeetingHost,
  updateMeetingSettings,
  updateMeetingStatus,
} from "@loopkit/core";
import { meeting as meetingTable, workspace as workspaceTable } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";

import { resetTables, testDb } from "./testDb";

const db = testDb();
let workspaceId: string;

function nextSlot(): Promise<string> {
  return listMeetingSlots(db, workspaceId, {
    from: new Date(),
    to: new Date(Date.now() + 7 * 24 * 3600_000),
  }).then((slots) => slots.find((s) => s.available)!.startsAt);
}

beforeEach(async () => {
  await resetTables(db);
  const id = crypto.randomUUID();
  await db.insert(workspaceTable).values({ id, name: "Meet", slug: "meet-" + id.slice(0, 8) });
  workspaceId = id;
  await updateMeetingSettings(db, workspaceId, {
    timezone: "UTC",
    availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
    dayStartMinute: 9 * 60,
    dayEndMinute: 17 * 60,
    durationMinutes: 30,
    bufferMinutes: 0,
    leadDays: 14,
  });
});

describe("calendar token", () => {
  it("generates and reuses a stable token", async () => {
    const t1 = await ensureCalendarToken(db, workspaceId);
    expect(t1).toHaveLength(48);
    const t2 = await ensureCalendarToken(db, workspaceId);
    expect(t2).toBe(t1);
  });

  it("generateCalendarToken produces unique values", () => {
    expect(generateCalendarToken()).not.toBe(generateCalendarToken());
  });
});

describe("meeting hosts + round-robin", () => {
  it("rotates assignment by least-recently-assigned", async () => {
    await createMeetingHost(db, workspaceId, { name: "Ann", email: "ann@acme.com" });
    await createMeetingHost(db, workspaceId, { name: "Bob", email: "bob@acme.com" });

    const first = await assignMeetingHost(db, workspaceId);
    const second = await assignMeetingHost(db, workspaceId);
    const third = await assignMeetingHost(db, workspaceId);

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first!.id).not.toBe(second!.id);
    // Third cycles back to the first-assigned host.
    expect(third!.id).toBe(first!.id);
  });

  it("respects fixed assignment mode", async () => {
    await createMeetingHost(db, workspaceId, { name: "Ann", email: "ann@acme.com" });
    await createMeetingHost(db, workspaceId, { name: "Bob", email: "bob@acme.com" });
    await updateMeetingSettings(db, workspaceId, {
      assignmentMode: "fixed",
      fixedHostEmail: "bob@acme.com",
    });
    const host = await assignMeetingHost(db, workspaceId);
    expect(host?.email).toBe("bob@acme.com");
    // Fixed mode does not rotate.
    const again = await assignMeetingHost(db, workspaceId);
    expect(again?.email).toBe("bob@acme.com");
  });

  it("deactivates a host out of the pool", async () => {
    const ann = await createMeetingHost(db, workspaceId, { name: "Ann", email: "ann@acme.com" });
    await createMeetingHost(db, workspaceId, { name: "Bob", email: "bob@acme.com" });
    await updateMeetingHost(db, workspaceId, ann!.id, { active: false });
    const active = await listActiveMeetingHosts(db, workspaceId);
    expect(active.map((h) => h.email)).toEqual(["bob@acme.com"]);
    const all = await listMeetingHosts(db, workspaceId);
    expect(all).toHaveLength(2);
  });

  it("stamps the assigned host onto the meeting", async () => {
    await createMeetingHost(db, workspaceId, { name: "Ann", email: "ann@acme.com" });
    const startsAt = await nextSlot();
    const result = await bookMeeting(db, workspaceId, {
      email: "buyer@acme.com",
      startsAt,
    });
    expect(result.host?.email).toBe("ann@acme.com");
    expect(result.meeting.hostEmail).toBe("ann@acme.com");
    expect(result.meeting.hostName).toBe("Ann");
  });

  it("allows two hosts to book the same slot", async () => {
    await createMeetingHost(db, workspaceId, { name: "Ann", email: "ann@acme.com" });
    await createMeetingHost(db, workspaceId, { name: "Bob", email: "bob@acme.com" });
    const startsAt = await nextSlot();

    await bookMeeting(db, workspaceId, {
      email: "a@acme.com",
      startsAt,
      hostEmail: "ann@acme.com",
    });
    // Different host, same time — should succeed.
    await expect(
      bookMeeting(db, workspaceId, {
        email: "b@acme.com",
        startsAt,
        hostEmail: "bob@acme.com",
      }),
    ).resolves.toBeTruthy();

    // Same host, same time — rejected.
    await expect(
      bookMeeting(db, workspaceId, {
        email: "c@acme.com",
        startsAt,
        hostEmail: "ann@acme.com",
      }),
    ).rejects.toThrow("slot_unavailable");
  });

  it("falls back to workspace-wide conflict when unassigned", async () => {
    const startsAt = await nextSlot();
    await bookMeeting(db, workspaceId, { email: "a@acme.com", startsAt });
    await expect(bookMeeting(db, workspaceId, { email: "b@acme.com", startsAt })).rejects.toThrow(
      "slot_unavailable",
    );
  });
});

describe("ics generation", () => {
  it("escapes text and folds long lines", () => {
    expect(escapeIcsText("a,b;c\nd\\e")).toBe("a\\,b\\;c\\nd\\\\e");
    const long = "X".repeat(100);
    const folded = foldIcsLine(`DESCRIPTION:${long}`);
    expect(folded.split("\r\n")[0]!.length).toBeLessThanOrEqual(75);
    expect(folded).toContain("\r\n ");
  });

  it("formats UTC timestamps", () => {
    expect(formatIcsUtc(new Date("2026-03-01T15:04:05Z"))).toBe("20260301T150405Z");
  });

  it("builds a valid VEVENT with attendees and alarm", () => {
    const ics = buildVEvent({
      uid: "meeting-1@loopkit",
      summary: "Intro, with Alice",
      description: "Line1\nLine2",
      startsAt: new Date("2026-03-01T15:00:00Z"),
      endsAt: new Date("2026-03-01T15:30:00Z"),
      organizer: { email: "host@acme.com", name: "Host" },
      attendees: [{ email: "guest@acme.com", name: "Guest" }],
      alarmMinutes: 30,
      status: "CONFIRMED",
    });
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:meeting-1@loopkit");
    expect(ics).toContain("SUMMARY:Intro\\, with Alice");
    expect(ics).toContain("DESCRIPTION:Line1\\nLine2");
    expect(ics).toContain("ORGANIZER;CN=Host");
    expect(ics).toContain("ATTENDEE;CN=Guest");
    expect(ics).toContain("TRIGGER:-PT30M");
    expect(ics).toContain("DTSTART:20260301T150000Z");
    expect(ics).toContain("END:VEVENT");
  });

  it("builds a calendar feed with multiple events", () => {
    const ics = buildVCalendar({
      calendarName: "Acme meetings",
      refreshInterval: "PT1H",
      events: [
        {
          uid: "a@loopkit",
          summary: "A",
          startsAt: "2026-03-01T10:00:00Z",
          endsAt: "2026-03-01T10:30:00Z",
        },
        {
          uid: "b@loopkit",
          summary: "B",
          startsAt: "2026-03-02T10:00:00Z",
          endsAt: "2026-03-02T10:30:00Z",
          status: "CANCELLED",
        },
      ],
    });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("X-WR-CALNAME:Acme meetings");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    expect(ics).toContain("UID:a@loopkit");
    expect(ics).toContain("UID:b@loopkit");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    // Every content line is CRLF-terminated.
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  it("maps a meeting row to an ICS event", async () => {
    const startsAt = await nextSlot();
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "guest@acme.com",
      name: "Guest",
      startsAt,
      notes: "Pricing talk",
    });
    const event = meetingToIcsEvent(meeting, {
      organizer: { email: "org@acme.com", name: "Org" },
      alarmMinutes: 60,
    });
    expect(event.uid).toBe(`meeting-${meeting.id}@loopkit`);
    expect(event.attendees?.map((a) => a.email)).toContain("guest@acme.com");
    expect(event.organizer?.email).toBe("org@acme.com");
    expect(event.alarmMinutes).toBe(60);

    const ics = buildMeetingIcs(event);
    expect(ics).toContain(`UID:meeting-${meeting.id}@loopkit`);
    expect(ics).toContain("Pricing talk");
  });

  it("lists meetings for the calendar feed including cancellations", async () => {
    const startsAt = await nextSlot();
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "guest@acme.com",
      startsAt,
    });
    await updateMeetingStatus(db, workspaceId, meeting.id, "cancelled", "gone");

    const rows = await listMeetingsForCalendar(db, workspaceId);
    expect(rows.some((r) => r.id === meeting.id && r.status === "cancelled")).toBe(true);
  });
});

describe("meeting reminders", () => {
  it("returns due offsets and marks them sent", async () => {
    // Book a meeting ~1 hour out so the 2h offset is already due.
    const startsAt = new Date(Date.now() + 60 * 60_000);
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "soon@acme.com",
      startsAt,
    });

    const due = await listDueMeetingReminders(db, workspaceId);
    expect(due.some((d) => d.meeting.id === meeting.id && d.hoursBefore === 24)).toBe(true);
    expect(due.some((d) => d.meeting.id === meeting.id && d.hoursBefore === 2)).toBe(true);

    await markMeetingReminderSent(db, workspaceId, meeting.id, 2);
    const after = await listDueMeetingReminders(db, workspaceId);
    expect(after.some((d) => d.meeting.id === meeting.id && d.hoursBefore === 2)).toBe(false);
    // 24h offset is still due (we're past that point too).
    expect(after.some((d) => d.meeting.id === meeting.id && d.hoursBefore === 24)).toBe(true);
  });

  it("does not return reminders for far-future meetings beyond the horizon", async () => {
    const startsAt = new Date(Date.now() + 72 * 3600_000);
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "later@acme.com",
      startsAt,
    });
    const due = await listDueMeetingReminders(db, workspaceId);
    expect(due.some((d) => d.meeting.id === meeting.id)).toBe(false);
  });

  it("skips cancelled meetings and respects sendReminders=false", async () => {
    const startsAt = new Date(Date.now() + 30 * 60_000);
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "x@acme.com",
      startsAt,
    });
    await updateMeetingStatus(db, workspaceId, meeting.id, "cancelled");
    let due = await listDueMeetingReminders(db, workspaceId);
    expect(due.some((d) => d.meeting.id === meeting.id)).toBe(false);

    const { meeting: m2 } = await bookMeeting(db, workspaceId, {
      email: "y@acme.com",
      startsAt: new Date(Date.now() + 30 * 60_000),
    });
    await updateMeetingSettings(db, workspaceId, { sendReminders: false });
    due = await listDueMeetingReminders(db, workspaceId);
    expect(due.some((d) => d.meeting.id === m2.id)).toBe(false);
  });

  it("markAllMeetingRemindersSent clears the queue", async () => {
    const startsAt = new Date(Date.now() + 30 * 60_000);
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "z@acme.com",
      startsAt,
    });
    await markAllMeetingRemindersSent(db, workspaceId, meeting.id);
    const due = await listDueMeetingReminders(db, workspaceId);
    expect(due.some((d) => d.meeting.id === meeting.id)).toBe(false);
    const [row] = await db.select().from(meetingTable).where(eq(meetingTable.id, meeting.id));
    expect(row?.remindersSent).toEqual([24, 2]);
  });

  it("honours custom reminder offsets", async () => {
    await updateMeetingSettings(db, workspaceId, {
      reminderHoursBefore: [48],
      sendReminders: true,
    });
    const startsAt = new Date(Date.now() + 24 * 3600_000);
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "custom@acme.com",
      startsAt,
    });
    const due = await listDueMeetingReminders(db, workspaceId);
    // 24h out: the 48h offset is due, no 2h/24h offsets exist.
    expect(due.filter((d) => d.meeting.id === meeting.id).map((d) => d.hoursBefore)).toEqual([48]);
  });
});

describe("settings plumbing", () => {
  it("persists new meeting settings fields", async () => {
    await updateMeetingSettings(db, workspaceId, {
      reminderHoursBefore: [24],
      sendBookingConfirmation: false,
      assignmentMode: "none",
      organizerName: "Acme",
      organizerEmail: "hello@acme.com",
    });
    const s = await getOrCreateMeetingSettings(db, workspaceId);
    expect(s?.reminderHoursBefore).toEqual([24]);
    expect(s?.sendBookingConfirmation).toBe(false);
    expect(s?.assignmentMode).toBe("none");
    expect(s?.organizerEmail).toBe("hello@acme.com");
  });
});
