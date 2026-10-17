/**
 * Meeting mail + reminder poller.
 *
 * Booking confirmations are sent inline at booking time (the HTTP request
 * that created the meeting). Pre-meeting reminders are table-backed and
 * polled here on a plain setInterval — same shape as campaignRunner's
 * scheduler and loopkitRuntime's history sweeper: single process, advisory
 * lock already guarantees one API instance, durable rows mean a restart
 * between ticks loses nothing.
 */
import {
  buildMeetingIcs,
  ensureCalendarToken,
  getOrCreateMeetingSettings,
  listDueMeetingReminders,
  listMeetingHosts,
  listMeetingsForCalendar,
  markMeetingReminderSent,
  meetingToIcsEvent,
  buildVCalendar,
  type MeetingRow,
  type DueReminder,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import {
  composeBookingConfirmation,
  composeHostAssignment,
  composeMeetingReminder,
  sendMeetingMail,
  type EmailProvider,
  type MeetingMailData,
} from "@loopkit/email";

/** Public origin used to build manage/calendar links in emails. */
function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_WEB_URL ||
    process.env.VITE_SERVER_URL ||
    `http://localhost:${process.env.PORT ?? 3000}`
  ).replace(/\/$/, "");
}

function calendarFeedUrl(token: string): string {
  return `${publicBaseUrl()}/v1/calendar/${token}.ics`;
}

function meetingIcsFor(
  meeting: MeetingRow,
  organizer: { email: string; name?: string | null } | null,
  alarmMinutes: number | null,
): string {
  return buildMeetingIcs(meetingToIcsEvent(meeting, { organizer, alarmMinutes }), meeting.title);
}

function mailDataFor(
  meeting: MeetingRow,
  opts: {
    organizer: { email: string; name?: string | null } | null;
    feedUrl: string | null;
    ics: string | null;
  },
): MeetingMailData {
  return {
    meetingId: meeting.id,
    title: meeting.title,
    startsAt: meeting.startsAt,
    endsAt: meeting.endsAt,
    timezone: meeting.timezone,
    notes: meeting.notes,
    guest: {
      email: meeting.guestEmail ?? "",
      name: meeting.guestName,
    },
    host: meeting.hostEmail ? { email: meeting.hostEmail, name: meeting.hostName } : null,
    organizer: opts.organizer,
    manageUrl: null,
    calendarFeedUrl: opts.feedUrl,
    ics: opts.ics,
    icsFilename: `${meeting.title.replace(/[^\w-]+/g, "-").slice(0, 40) || "meeting"}.ics`,
  };
}

export type MeetingMailerOptions = {
  provider: EmailProvider;
  defaultFrom: string;
};

/**
 * Sends the booking confirmation (+ ICS) to the guest and an assignment
 * notice to the host. Failures are swallowed and logged — a mail hiccup
 * must never fail the booking itself.
 */
export async function sendBookingNotifications(
  meeting: MeetingRow,
  opts: MeetingMailerOptions,
): Promise<void> {
  const settings = await getOrCreateMeetingSettings(db, meeting.workspaceId);
  if (!settings?.sendBookingConfirmation) return;

  const organizer =
    settings.organizerEmail != null
      ? { email: settings.organizerEmail, name: settings.organizerName }
      : null;

  const feedToken = await ensureCalendarToken(db, meeting.workspaceId);
  const feedUrl = calendarFeedUrl(feedToken);
  const ics = meetingIcsFor(meeting, organizer, 30);
  const data = mailDataFor(meeting, { organizer, feedUrl, ics });

  // Guest confirmation (require a guest address).
  if (data.guest.email) {
    try {
      await sendMeetingMail(opts.provider, {
        from: settings.organizerEmail || opts.defaultFrom,
        mail: composeBookingConfirmation(data),
        tags: { type: "meeting-confirmation", meeting: meeting.id },
      });
    } catch (error) {
      console.error(
        `[loopkit] booking confirmation failed for ${meeting.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Host assignment notice.
  if (meeting.hostEmail && meeting.hostEmail !== data.guest.email) {
    try {
      await sendMeetingMail(opts.provider, {
        from: settings.organizerEmail || opts.defaultFrom,
        mail: composeHostAssignment(data),
        tags: { type: "meeting-host-notice", meeting: meeting.id },
      });
    } catch (error) {
      console.error(
        `[loopkit] host notice failed for ${meeting.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/** Sends one due reminder and records it. */
export async function sendDueReminder(
  reminder: DueReminder,
  opts: MeetingMailerOptions,
): Promise<boolean> {
  const { meeting, hoursBefore } = reminder;
  const settings = await getOrCreateMeetingSettings(db, meeting.workspaceId);
  const organizer =
    settings?.organizerEmail != null
      ? { email: settings.organizerEmail, name: settings.organizerName }
      : null;

  const feedToken = settings?.calendarToken ?? (await ensureCalendarToken(db, meeting.workspaceId));
  const feedUrl = feedToken ? calendarFeedUrl(feedToken) : null;
  const ics = meetingIcsFor(meeting, organizer, 30);
  const data = mailDataFor(meeting, { organizer, feedUrl, ics });

  if (!data.guest.email) {
    // No guest address — mark sent so the poller doesn't spin on it.
    await markMeetingReminderSent(db, meeting.workspaceId, meeting.id, hoursBefore);
    return false;
  }

  try {
    await sendMeetingMail(opts.provider, {
      from: settings?.organizerEmail || opts.defaultFrom,
      mail: composeMeetingReminder(data, hoursBefore),
      tags: { type: "meeting-reminder", meeting: meeting.id, offset: String(hoursBefore) },
    });
    await markMeetingReminderSent(db, meeting.workspaceId, meeting.id, hoursBefore);
    return true;
  } catch (error) {
    console.error(
      `[loopkit] meeting reminder failed for ${meeting.id} (-${hoursBefore}h):`,
      error instanceof Error ? error.message : error,
    );
    // Don't mark sent — next tick retries.
    return false;
  }
}

/**
 * Sends the host a prep brief N hours before the meeting. Idempotent via
 * `meeting.prepBriefSentAt` — the poller can tick freely. Quietly no-ops
 * when there is no host or the window has passed.
 */
export async function sendPrepBrief(
  meeting: MeetingRow,
  opts: MeetingMailerOptions,
): Promise<boolean> {
  if (!meeting.hostEmail) return false;
  if (meeting.prepBriefSentAt) return false;
  const settings = await getOrCreateMeetingSettings(db, meeting.workspaceId);
  const hours = settings?.prepBriefHoursBefore ?? 2;
  if (hours <= 0) return false;

  const startsAt = new Date(meeting.startsAt).getTime();
  const windowMs = hours * 3600_000;
  const now = Date.now();
  // Only send once we are inside the window and before the meeting starts.
  if (now < startsAt - windowMs || now > startsAt) return false;

  const { buildMeetingPrepBrief, markPrepBriefSent } = await import("@loopkit/core");
  const { composePrepBrief, sendMeetingMail } = await import("@loopkit/email");
  const brief = await buildMeetingPrepBrief(db, meeting.workspaceId, meeting.id);
  if (!brief) return false;

  try {
    await sendMeetingMail(opts.provider, {
      from: settings?.organizerEmail || opts.defaultFrom,
      mail: composePrepBrief(brief),
      tags: { type: "meeting-prep-brief", meeting: meeting.id },
    });
    await markPrepBriefSent(db, meeting.workspaceId, meeting.id);
    return true;
  } catch (error) {
    console.error(
      `[loopkit] prep brief failed for ${meeting.id}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * One poll cycle across all workspaces: send every due reminder.
 * Exposed for tests; the interval wrapper is startMeetingReminderPoller.
 */
export async function meetingReminderTick(
  opts: MeetingMailerOptions,
  limit = 50,
): Promise<{ scanned: number; sent: number; briefs: number }> {
  const { sql } = await import("drizzle-orm");
  const { meetingSettings: meetingSettingsTable } = await import("@loopkit/db/schema");

  const workspaces = await db
    .select({ workspaceId: meetingSettingsTable.workspaceId })
    .from(meetingSettingsTable)
    .where(sql`${meetingSettingsTable.sendReminders} = true`);

  let scanned = 0;
  let sent = 0;
  let briefs = 0;
  for (const { workspaceId } of workspaces) {
    const due = await listDueMeetingReminders(db, workspaceId, { limit });
    scanned += due.length;
    for (const reminder of due) {
      const ok = await sendDueReminder(reminder, opts);
      if (ok) sent += 1;
    }

    // Prep briefs ride the same poller (once inside the pre-meeting window).
    const upcoming = await listMeetingsForCalendar(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 24 * 3600_000),
    });
    for (const meeting of upcoming) {
      if (meeting.status !== "scheduled") continue;
      const ok = await sendPrepBrief(meeting, opts);
      if (ok) briefs += 1;
    }
  }
  return { scanned, sent, briefs };
}

let reminderPollerTimer: NodeJS.Timeout | null = null;

/**
 * Starts the reminder poller. Idempotent. Interval via
 * MEETING_REMINDER_POLL_MS (default 60s); 0 disables.
 */
export function startMeetingReminderPoller(opts: MeetingMailerOptions): void {
  if (reminderPollerTimer) return;
  const parsed = Number.parseInt(process.env.MEETING_REMINDER_POLL_MS ?? "", 10);
  const intervalMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
  if (Number.isFinite(parsed) && parsed <= 0) {
    console.log("[loopkit] meeting reminder poller disabled (MEETING_REMINDER_POLL_MS<=0)");
    return;
  }

  const tick = async () => {
    try {
      const stats = await meetingReminderTick(opts);
      if (stats.sent > 0) {
        console.log(`[loopkit] meeting reminders: ${stats.sent}/${stats.scanned} sent`);
      }
    } catch (error) {
      console.error(
        "[loopkit] meeting reminder poll failed:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  void tick();
  reminderPollerTimer = setInterval(() => void tick(), intervalMs);
  reminderPollerTimer.unref();
}

export function stopMeetingReminderPoller(): void {
  if (reminderPollerTimer) {
    clearInterval(reminderPollerTimer);
    reminderPollerTimer = null;
  }
}

/** Build the public ICS feed body for a workspace. */
export async function buildWorkspaceCalendarFeed(
  workspaceId: string,
  calendarName?: string,
): Promise<string> {
  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  const organizer =
    settings?.organizerEmail != null
      ? { email: settings.organizerEmail, name: settings.organizerName }
      : null;
  const rows = await listMeetingsForCalendar(db, workspaceId);
  const events = rows.map((m) =>
    meetingToIcsEvent(m, {
      organizer,
      alarmMinutes: 30,
      sequence: m.status === "cancelled" ? 1 : 0,
    }),
  );
  return buildVCalendar({
    calendarName: calendarName ?? settings?.meetingTitle ?? "Meetings",
    timezone: settings?.timezone ?? "UTC",
    refreshInterval: "PT1H",
    events,
  });
}

/** Build a single-meeting .ics body. */
export async function buildMeetingIcsFile(
  workspaceId: string,
  meeting: MeetingRow,
): Promise<string> {
  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  const organizer =
    settings?.organizerEmail != null
      ? { email: settings.organizerEmail, name: settings.organizerName }
      : null;
  return meetingIcsFor(meeting, organizer, 30);
}

/** Resolve workspace by calendar feed token. */
export async function workspaceIdForCalendarToken(token: string): Promise<string | null> {
  const { meetingSettings: meetingSettingsTable } = await import("@loopkit/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ workspaceId: meetingSettingsTable.workspaceId })
    .from(meetingSettingsTable)
    .where(eq(meetingSettingsTable.calendarToken, token))
    .limit(1);
  return row?.workspaceId ?? null;
}

/** Hosts for the assignment UI. */
export async function listHosts(workspaceId: string) {
  return listMeetingHosts(db, workspaceId);
}
