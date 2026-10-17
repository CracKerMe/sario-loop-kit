import { and, asc, desc, eq, gt, gte, lt, lte, ne } from "drizzle-orm";

import type { Db } from "@loopkit/db";
import {
  contact as contactTable,
  meeting as meetingTable,
  meetingHost as meetingHostTable,
  meetingSettings as meetingSettingsTable,
  meetingType as meetingTypeTable,
} from "@loopkit/db/schema";

import { createTask } from "./gtm";
import type { IcsEventInput, IcsPerson } from "./ics";

export type MeetingStatus = "scheduled" | "held" | "cancelled" | "no_show";
export type MeetingSource = "booking_page" | "email_cta" | "contact_360" | "api" | "external";
export type MeetingAssignmentMode = "round_robin" | "fixed" | "none";

export type MeetingSettingsRow = typeof meetingSettingsTable.$inferSelect;
export type MeetingTypeRow = typeof meetingTypeTable.$inferSelect;
export type MeetingHostRow = typeof meetingHostTable.$inferSelect;
export type MeetingRow = typeof meetingTable.$inferSelect;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export async function getOrCreateMeetingSettings(db: Db, workspaceId: string) {
  const [existing] = await db
    .select()
    .from(meetingSettingsTable)
    .where(eq(meetingSettingsTable.workspaceId, workspaceId))
    .limit(1);
  if (existing) return existing;

  const [row] = await db
    .insert(meetingSettingsTable)
    .values({ workspaceId })
    .onConflictDoNothing()
    .returning();
  if (row) return row;

  const [again] = await db
    .select()
    .from(meetingSettingsTable)
    .where(eq(meetingSettingsTable.workspaceId, workspaceId))
    .limit(1);
  return again;
}

export type MeetingSettingsInput = {
  bookingUrl?: string | null;
  meetingTitle?: string;
  meetingDescription?: string | null;
  durationMinutes?: number;
  ctaLabel?: string;
  timezone?: string;
  availableWeekdays?: number[];
  dayStartMinute?: number;
  dayEndMinute?: number;
  bufferMinutes?: number;
  leadDays?: number;
  bookingSlug?: string | null;
  calendarToken?: string | null;
  reminderHoursBefore?: number[];
  sendBookingConfirmation?: boolean;
  sendReminders?: boolean;
  assignmentMode?: MeetingAssignmentMode;
  fixedHostEmail?: string | null;
  organizerName?: string | null;
  organizerEmail?: string | null;
  postMeetingJourneyId?: string | null;
  noShowJourneyId?: string | null;
  cancellationJourneyId?: string | null;
  prepBriefHoursBefore?: number;
};

/** Random URL-safe token used for the public ICS feed. */
export function generateCalendarToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function updateMeetingSettings(
  db: Db,
  workspaceId: string,
  input: MeetingSettingsInput,
) {
  await getOrCreateMeetingSettings(db, workspaceId);
  const [row] = await db
    .update(meetingSettingsTable)
    .set({
      ...(input.bookingUrl !== undefined ? { bookingUrl: input.bookingUrl } : {}),
      ...(input.meetingTitle !== undefined ? { meetingTitle: input.meetingTitle } : {}),
      ...(input.meetingDescription !== undefined
        ? { meetingDescription: input.meetingDescription }
        : {}),
      ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
      ...(input.ctaLabel !== undefined ? { ctaLabel: input.ctaLabel } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.availableWeekdays !== undefined
        ? { availableWeekdays: input.availableWeekdays }
        : {}),
      ...(input.dayStartMinute !== undefined ? { dayStartMinute: input.dayStartMinute } : {}),
      ...(input.dayEndMinute !== undefined ? { dayEndMinute: input.dayEndMinute } : {}),
      ...(input.bufferMinutes !== undefined ? { bufferMinutes: input.bufferMinutes } : {}),
      ...(input.leadDays !== undefined ? { leadDays: input.leadDays } : {}),
      ...(input.bookingSlug !== undefined ? { bookingSlug: input.bookingSlug } : {}),
      ...(input.calendarToken !== undefined ? { calendarToken: input.calendarToken } : {}),
      ...(input.reminderHoursBefore !== undefined
        ? { reminderHoursBefore: input.reminderHoursBefore }
        : {}),
      ...(input.sendBookingConfirmation !== undefined
        ? { sendBookingConfirmation: input.sendBookingConfirmation }
        : {}),
      ...(input.sendReminders !== undefined ? { sendReminders: input.sendReminders } : {}),
      ...(input.assignmentMode !== undefined ? { assignmentMode: input.assignmentMode } : {}),
      ...(input.fixedHostEmail !== undefined ? { fixedHostEmail: input.fixedHostEmail } : {}),
      ...(input.organizerName !== undefined ? { organizerName: input.organizerName } : {}),
      ...(input.organizerEmail !== undefined ? { organizerEmail: input.organizerEmail } : {}),
      ...(input.postMeetingJourneyId !== undefined
        ? { postMeetingJourneyId: input.postMeetingJourneyId }
        : {}),
      ...(input.noShowJourneyId !== undefined ? { noShowJourneyId: input.noShowJourneyId } : {}),
      ...(input.cancellationJourneyId !== undefined
        ? { cancellationJourneyId: input.cancellationJourneyId }
        : {}),
      ...(input.prepBriefHoursBefore !== undefined
        ? { prepBriefHoursBefore: input.prepBriefHoursBefore }
        : {}),
    })
    .where(eq(meetingSettingsTable.workspaceId, workspaceId))
    .returning();
  return row;
}

/**
 * Ensures the workspace has a calendar feed token (generated on first ask)
 * and returns the public feed path suffix.
 */
export async function ensureCalendarToken(db: Db, workspaceId: string): Promise<string> {
  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  if (settings?.calendarToken) return settings.calendarToken;
  const token = generateCalendarToken();
  await db
    .update(meetingSettingsTable)
    .set({ calendarToken: token })
    .where(eq(meetingSettingsTable.workspaceId, workspaceId));
  return token;
}

/* ------------------------------------------------------------------ */
/* Meeting hosts (round-robin pool)                                    */
/* ------------------------------------------------------------------ */

export type MeetingHostInput = {
  name: string;
  email: string;
  userId?: string | null;
  active?: boolean;
  sortOrder?: number;
};

export async function listMeetingHosts(db: Db, workspaceId: string): Promise<MeetingHostRow[]> {
  return db
    .select()
    .from(meetingHostTable)
    .where(eq(meetingHostTable.workspaceId, workspaceId))
    .orderBy(asc(meetingHostTable.sortOrder), asc(meetingHostTable.name));
}

export async function listActiveMeetingHosts(
  db: Db,
  workspaceId: string,
): Promise<MeetingHostRow[]> {
  return db
    .select()
    .from(meetingHostTable)
    .where(and(eq(meetingHostTable.workspaceId, workspaceId), eq(meetingHostTable.active, true)))
    .orderBy(asc(meetingHostTable.sortOrder), asc(meetingHostTable.name));
}

export async function createMeetingHost(
  db: Db,
  workspaceId: string,
  input: MeetingHostInput,
): Promise<MeetingHostRow | null> {
  const email = input.email.trim().toLowerCase();
  const [row] = await db
    .insert(meetingHostTable)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      userId: input.userId ?? null,
      name: input.name.trim(),
      email,
      active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function updateMeetingHost(
  db: Db,
  workspaceId: string,
  hostId: string,
  input: Partial<MeetingHostInput>,
): Promise<MeetingHostRow | null> {
  const [row] = await db
    .update(meetingHostTable)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.email !== undefined ? { email: input.email.trim().toLowerCase() } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    })
    .where(and(eq(meetingHostTable.workspaceId, workspaceId), eq(meetingHostTable.id, hostId)))
    .returning();
  return row ?? null;
}

export async function deleteMeetingHost(
  db: Db,
  workspaceId: string,
  hostId: string,
): Promise<boolean> {
  const rows = await db
    .delete(meetingHostTable)
    .where(and(eq(meetingHostTable.workspaceId, workspaceId), eq(meetingHostTable.id, hostId)))
    .returning({ id: meetingHostTable.id });
  return rows.length > 0;
}

/**
 * Picks the next host according to the workspace assignment mode.
 * round_robin: least-recently-assigned active host (nulls first).
 * fixed: the configured fixedHostEmail, if present in the pool.
 * none: no host.
 */
export async function assignMeetingHost(
  db: Db,
  workspaceId: string,
): Promise<MeetingHostRow | null> {
  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  const mode = settings?.assignmentMode ?? "round_robin";
  if (mode === "none") return null;

  if (mode === "fixed") {
    const fixed = settings?.fixedHostEmail?.trim().toLowerCase();
    if (!fixed) return null;
    const [host] = await db
      .select()
      .from(meetingHostTable)
      .where(
        and(
          eq(meetingHostTable.workspaceId, workspaceId),
          eq(meetingHostTable.email, fixed),
          eq(meetingHostTable.active, true),
        ),
      )
      .limit(1);
    return host ?? null;
  }

  // round_robin — least recently assigned, then lowest sortOrder/name.
  const hosts = await listActiveMeetingHosts(db, workspaceId);
  if (hosts.length === 0) return null;
  const sorted = [...hosts].sort((a, b) => {
    const at = a.lastAssignedAt?.getTime() ?? 0;
    const bt = b.lastAssignedAt?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });
  const chosen = sorted[0]!;
  await db
    .update(meetingHostTable)
    .set({ lastAssignedAt: new Date() })
    .where(eq(meetingHostTable.id, chosen.id));
  return chosen;
}

/* ------------------------------------------------------------------ */
/* Meeting types                                                       */
/* ------------------------------------------------------------------ */

export type MeetingTypeInput = {
  name: string;
  slug: string;
  description?: string | null;
  durationMinutes?: number;
  bookingUrl?: string | null;
  ctaLabel?: string;
  isDefault?: boolean;
  active?: boolean;
  sortOrder?: number;
};

export async function listMeetingTypes(db: Db, workspaceId: string) {
  return db
    .select()
    .from(meetingTypeTable)
    .where(eq(meetingTypeTable.workspaceId, workspaceId))
    .orderBy(asc(meetingTypeTable.sortOrder), asc(meetingTypeTable.name));
}

export async function getMeetingTypeBySlug(db: Db, workspaceId: string, slug: string) {
  const [row] = await db
    .select()
    .from(meetingTypeTable)
    .where(and(eq(meetingTypeTable.workspaceId, workspaceId), eq(meetingTypeTable.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function createMeetingType(db: Db, workspaceId: string, input: MeetingTypeInput) {
  if (input.isDefault) {
    await db
      .update(meetingTypeTable)
      .set({ isDefault: false })
      .where(eq(meetingTypeTable.workspaceId, workspaceId));
  }
  const [row] = await db
    .insert(meetingTypeTable)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      durationMinutes: input.durationMinutes ?? 30,
      bookingUrl: input.bookingUrl ?? null,
      ctaLabel: input.ctaLabel ?? "Book a meeting",
      isDefault: input.isDefault ?? false,
      active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  return row;
}

export async function updateMeetingType(
  db: Db,
  workspaceId: string,
  typeId: string,
  input: Partial<MeetingTypeInput>,
) {
  if (input.isDefault) {
    await db
      .update(meetingTypeTable)
      .set({ isDefault: false })
      .where(eq(meetingTypeTable.workspaceId, workspaceId));
  }
  const [row] = await db
    .update(meetingTypeTable)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
      ...(input.bookingUrl !== undefined ? { bookingUrl: input.bookingUrl } : {}),
      ...(input.ctaLabel !== undefined ? { ctaLabel: input.ctaLabel } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    })
    .where(and(eq(meetingTypeTable.workspaceId, workspaceId), eq(meetingTypeTable.id, typeId)))
    .returning();
  return row ?? null;
}

export async function deleteMeetingType(
  db: Db,
  workspaceId: string,
  typeId: string,
): Promise<boolean> {
  const rows = await db
    .delete(meetingTypeTable)
    .where(and(eq(meetingTypeTable.workspaceId, workspaceId), eq(meetingTypeTable.id, typeId)))
    .returning({ id: meetingTypeTable.id });
  return rows.length > 0;
}

/** Seeds a default "Intro call" type on first use so the booking page works. */
export async function ensureDefaultMeetingType(
  db: Db,
  workspaceId: string,
): Promise<MeetingTypeRow | null> {
  const types = await listMeetingTypes(db, workspaceId);
  const existing = types.find((t) => t.isDefault) ?? types[0];
  if (existing) return existing;
  return (
    (await createMeetingType(db, workspaceId, {
      name: "Intro call",
      slug: "intro-call",
      description: "A short intro to see if we can help.",
      durationMinutes: 30,
      isDefault: true,
      ctaLabel: "Book an intro",
    })) ?? null
  );
}

/* ------------------------------------------------------------------ */
/* Availability & slots                                                */
/* ------------------------------------------------------------------ */

export type Slot = {
  startsAt: string; // ISO
  endsAt: string;
  available: boolean;
};

/**
 * Generates bookable slots for a date range using the workspace availability
 * window. Times are computed in the settings timezone using Intl so the
 * scheduler works without pulling in a tz database.
 */
export async function listMeetingSlots(
  db: Db,
  workspaceId: string,
  opts: {
    from?: Date;
    to?: Date;
    meetingTypeId?: string;
    durationMinutes?: number;
  } = {},
): Promise<Slot[]> {
  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  if (!settings) return [];

  const weekdays = settings.availableWeekdays ?? [1, 2, 3, 4, 5];
  if (weekdays.length === 0) return [];

  let duration = opts.durationMinutes ?? settings.durationMinutes;
  if (opts.meetingTypeId) {
    const [type] = await db
      .select()
      .from(meetingTypeTable)
      .where(eq(meetingTypeTable.id, opts.meetingTypeId))
      .limit(1);
    if (type) duration = type.durationMinutes;
  }

  const now = new Date();
  const from = opts.from ?? now;
  const to = opts.to ?? new Date(now.getTime() + settings.leadDays * 24 * 3600_000);

  // Collect existing scheduled meetings to mark conflicts.
  const existing = await db
    .select({ startsAt: meetingTable.startsAt, endsAt: meetingTable.endsAt })
    .from(meetingTable)
    .where(
      and(
        eq(meetingTable.workspaceId, workspaceId),
        ne(meetingTable.status, "cancelled"),
        lte(meetingTable.startsAt, to),
        gte(meetingTable.endsAt, from),
      ),
    );

  const tz = settings.timezone || "UTC";
  const slots: Slot[] = [];

  // Walk day by day in the target timezone.
  for (let day = new Date(from); day <= to; day.setUTCDate(day.getUTCDate() + 1)) {
    // Weekday in the settings timezone.
    const weekday = Number(
      new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz })
        .formatToParts(day)
        .find((p) => p.type === "weekday")?.value
        ? // map Sun/Mon… to 0-6
          ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
            new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(day),
          )
        : -1,
    );
    if (weekday < 0 || !weekdays.includes(weekday)) continue;

    // Build the day's start/end instants in UTC from local wall-clock minutes.
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(day);

    const startMinute = settings.dayStartMinute;
    const endMinute = settings.dayEndMinute;
    if (endMinute <= startMinute) continue;

    for (let m = startMinute; m + duration <= endMinute; m += duration + settings.bufferMinutes) {
      const startsAt = localMinuteToDate(ymd, m, tz);
      const endsAt = new Date(startsAt.getTime() + duration * 60_000);
      if (startsAt < from || startsAt > to) continue;
      // Only future slots are bookable.
      if (startsAt.getTime() < Date.now() - 60_000) continue;

      const conflict = existing.some((e) => startsAt < e.endsAt && endsAt > e.startsAt);
      slots.push({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        available: !conflict,
      });
    }
  }

  return slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * Convert a local wall-clock minute-of-day in `timeZone` to a UTC Date.
 * Uses the timezone offset of that calendar day (handles DST via Intl).
 */
function localMinuteToDate(ymd: string, minuteOfDay: number, timeZone: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  // Probe offset at noon UTC on that date (stable across DST edges for our purposes).
  const probe = new Date(Date.UTC(y!, (mo ?? 1) - 1, d ?? 1, 12, 0, 0));
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(probe);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const offsetMatch = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const sign = offsetMatch?.[1] === "-" ? -1 : 1;
  const offsetMinutes = sign * (Number(offsetMatch?.[2] ?? 0) * 60 + Number(offsetMatch?.[3] ?? 0));

  // Local wall clock → UTC: subtract offset.
  const utcMinutes = minuteOfDay - offsetMinutes;
  return new Date(Date.UTC(y!, (mo ?? 1) - 1, d ?? 1, 0, 0, 0) + utcMinutes * 60_000);
}

/* ------------------------------------------------------------------ */
/* Bookings                                                            */
/* ------------------------------------------------------------------ */

export type BookMeetingInput = {
  contactId?: string | null;
  email?: string;
  name?: string;
  meetingTypeId?: string | null;
  startsAt: Date | string;
  notes?: string | null;
  source?: MeetingSource;
  timezone?: string;
  /** Skip creating the reminder task (used by bulk imports). */
  skipReminder?: boolean;
  /** Explicit host override; otherwise assigned via the workspace mode. */
  hostUserId?: string | null;
  hostName?: string | null;
  hostEmail?: string | null;
  /** Skip host assignment entirely (e.g. re-importing an external meeting). */
  skipHostAssignment?: boolean;
};

export type BookMeetingResult = {
  meeting: MeetingRow;
  contactId: string | null;
  reminderTaskId: string | null;
  host: MeetingHostRow | null;
};

export async function bookMeeting(
  db: Db,
  workspaceId: string,
  input: BookMeetingInput,
): Promise<BookMeetingResult> {
  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  let meetingTypeId = input.meetingTypeId ?? null;
  let duration = settings?.durationMinutes ?? 30;
  let title = settings?.meetingTitle ?? "Meeting";

  if (!meetingTypeId) {
    const def = await ensureDefaultMeetingType(db, workspaceId);
    meetingTypeId = def?.id ?? null;
    if (def) {
      duration = def.durationMinutes;
      title = def.name;
    }
  } else {
    const [type] = await db
      .select()
      .from(meetingTypeTable)
      .where(eq(meetingTypeTable.id, meetingTypeId))
      .limit(1);
    if (type) {
      duration = type.durationMinutes;
      title = type.name;
    }
  }

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    throw new Error("invalid_starts_at");
  }
  const endsAt = new Date(startsAt.getTime() + duration * 60_000);

  // Host assignment first — conflict checks are per-host so two hosts can
  // take the same slot. Unassigned meetings fall back to a workspace-wide
  // conflict check (one shared calendar).
  let host: MeetingHostRow | null = null;
  if (!input.skipHostAssignment) {
    if (input.hostEmail) {
      const email = input.hostEmail.trim().toLowerCase();
      host =
        (
          await db
            .select()
            .from(meetingHostTable)
            .where(
              and(eq(meetingHostTable.workspaceId, workspaceId), eq(meetingHostTable.email, email)),
            )
            .limit(1)
        )[0] ?? null;
    } else if (!input.hostUserId && !input.hostName) {
      host = await assignMeetingHost(db, workspaceId);
    }
  }

  // Conflict check — double-booking is rejected, not silently overlapped.
  // Scoped to the assigned host when one is set.
  const conflictFilters = [
    eq(meetingTable.workspaceId, workspaceId),
    ne(meetingTable.status, "cancelled"),
    lt(meetingTable.startsAt, endsAt),
    gt(meetingTable.endsAt, startsAt),
  ];
  const scopedHostEmail = input.hostEmail?.trim().toLowerCase() ?? host?.email ?? null;
  const scopedHostUserId = input.hostUserId ?? host?.userId ?? null;
  if (scopedHostEmail) {
    conflictFilters.push(eq(meetingTable.hostEmail, scopedHostEmail));
  } else if (scopedHostUserId) {
    conflictFilters.push(eq(meetingTable.hostUserId, scopedHostUserId));
  }

  const conflict = await db
    .select({ id: meetingTable.id })
    .from(meetingTable)
    .where(and(...conflictFilters))
    .limit(1);
  if (conflict.length > 0) {
    throw new Error("slot_unavailable");
  }

  // Resolve / create contact from email when needed.
  let contactId = input.contactId ?? null;
  if (!contactId && input.email) {
    const email = input.email.trim().toLowerCase();
    const [existing] = await db
      .select()
      .from(contactTable)
      .where(and(eq(contactTable.workspaceId, workspaceId), eq(contactTable.email, email)))
      .limit(1);
    if (existing) {
      contactId = existing.id;
    } else {
      const [created] = await db
        .insert(contactTable)
        .values({
          id: crypto.randomUUID(),
          workspaceId,
          email,
          properties: input.name ? { firstName: input.name } : {},
          subscribed: true,
        })
        .returning();
      contactId = created?.id ?? null;
    }
  }

  const guestEmail =
    input.email?.trim().toLowerCase() ??
    (contactId
      ? (
          await db
            .select({ email: contactTable.email })
            .from(contactTable)
            .where(eq(contactTable.id, contactId))
            .limit(1)
        )[0]?.email
      : null) ??
    null;

  const [meeting] = await db
    .insert(meetingTable)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      contactId,
      meetingTypeId,
      title: input.name ? `${title} · ${input.name}` : title,
      guestEmail,
      guestName: input.name ?? null,
      startsAt,
      endsAt,
      timezone: input.timezone ?? settings?.timezone ?? "UTC",
      status: "scheduled",
      source: input.source ?? "api",
      notes: input.notes ?? null,
      hostUserId: input.hostUserId ?? host?.userId ?? null,
      hostName: input.hostName ?? host?.name ?? null,
      hostEmail: input.hostEmail?.trim().toLowerCase() ?? host?.email ?? null,
      remindersSent: [],
    })
    .returning();

  if (!meeting) throw new Error("booking_failed");

  // Reminder task 2h before the meeting (or immediately if sooner).
  let reminderTaskId: string | null = null;
  if (contactId && !input.skipReminder) {
    const dueAt = new Date(Math.max(Date.now(), startsAt.getTime() - 2 * 3600_000));
    const task = await createTask(db, workspaceId, {
      contactId,
      title: `Meeting in ${Math.max(0, Math.round((startsAt.getTime() - Date.now()) / 60000))} min: ${title}`,
      body: `${startsAt.toISOString()} → ${endsAt.toISOString()}${input.notes ? `\n${input.notes}` : ""}`,
      kind: "meeting",
      priority: 8,
      source: "meeting",
      sourceId: meeting.id,
      dueAt,
    }).catch(() => null);
    reminderTaskId = task?.id ?? null;
    if (task) {
      await db
        .update(meetingTable)
        .set({ reminderSent: true })
        .where(eq(meetingTable.id, meeting.id));
    }
  }

  return { meeting, contactId, reminderTaskId, host };
}

export async function listMeetings(
  db: Db,
  workspaceId: string,
  opts: {
    status?: MeetingStatus;
    contactId?: string;
    upcoming?: boolean;
    limit?: number;
  } = {},
) {
  const filters = [eq(meetingTable.workspaceId, workspaceId)];
  if (opts.status) filters.push(eq(meetingTable.status, opts.status));
  if (opts.contactId) filters.push(eq(meetingTable.contactId, opts.contactId));
  if (opts.upcoming) filters.push(gte(meetingTable.startsAt, new Date()));

  return db
    .select({
      id: meetingTable.id,
      contactId: meetingTable.contactId,
      meetingTypeId: meetingTable.meetingTypeId,
      title: meetingTable.title,
      guestEmail: meetingTable.guestEmail,
      guestName: meetingTable.guestName,
      startsAt: meetingTable.startsAt,
      endsAt: meetingTable.endsAt,
      timezone: meetingTable.timezone,
      status: meetingTable.status,
      source: meetingTable.source,
      notes: meetingTable.notes,
      outcome: meetingTable.outcome,
      hostUserId: meetingTable.hostUserId,
      hostName: meetingTable.hostName,
      hostEmail: meetingTable.hostEmail,
      remindersSent: meetingTable.remindersSent,
      createdAt: meetingTable.createdAt,
      contactEmail: contactTable.email,
    })
    .from(meetingTable)
    .leftJoin(contactTable, eq(contactTable.id, meetingTable.contactId))
    .where(and(...filters))
    .orderBy(desc(meetingTable.startsAt))
    .limit(opts.limit ?? 100);
}

export async function updateMeetingStatus(
  db: Db,
  workspaceId: string,
  meetingId: string,
  status: MeetingStatus,
  outcome?: string | null,
) {
  const [row] = await db
    .update(meetingTable)
    .set({
      status,
      outcome: outcome ?? undefined,
      ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
    })
    .where(and(eq(meetingTable.workspaceId, workspaceId), eq(meetingTable.id, meetingId)))
    .returning();
  return row ?? null;
}

export async function getMeeting(db: Db, workspaceId: string, meetingId: string) {
  const [row] = await db
    .select()
    .from(meetingTable)
    .where(and(eq(meetingTable.workspaceId, workspaceId), eq(meetingTable.id, meetingId)))
    .limit(1);
  return row ?? null;
}

/** Email variables including per-type booking links. */
export async function meetingEmailVariables(
  db: Db,
  workspaceId: string,
): Promise<Record<string, string>> {
  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  const types = await listMeetingTypes(db, workspaceId);
  const vars: Record<string, string> = {
    "meeting.url": settings?.bookingUrl ?? "",
    "meeting.cta": settings?.ctaLabel ?? "Book a meeting",
    "meeting.title": settings?.meetingTitle ?? "Book a meeting",
    "meeting.slug": settings?.bookingSlug ?? "",
    "meeting.timezone": settings?.timezone ?? "UTC",
  };
  for (const t of types) {
    vars[`meeting.type.${t.slug}.url`] = t.bookingUrl ?? settings?.bookingUrl ?? "";
    vars[`meeting.type.${t.slug}.cta`] = t.ctaLabel;
    vars[`meeting.type.${t.slug}.name`] = t.name;
    vars[`meeting.type.${t.slug}.duration`] = String(t.durationMinutes);
  }
  return vars;
}

/* ------------------------------------------------------------------ */
/* ICS mapping                                                         */
/* ------------------------------------------------------------------ */

/** Map a meeting row to an ICS VEVENT input. */
export function meetingToIcsEvent(
  meeting:
    | MeetingRow
    | {
        id: string;
        title: string;
        startsAt: Date | string;
        endsAt: Date | string;
        timezone?: string | null;
        status: MeetingStatus;
        notes?: string | null;
        guestEmail?: string | null;
        guestName?: string | null;
        hostEmail?: string | null;
        hostName?: string | null;
        createdAt?: Date | string;
        updatedAt?: Date | string;
      },
  opts: {
    organizer?: IcsPerson | null;
    url?: string | null;
    alarmMinutes?: number | null;
    sequence?: number;
  } = {},
): IcsEventInput {
  const attendees: IcsPerson[] = [];
  if (meeting.guestEmail) {
    attendees.push({ email: meeting.guestEmail, name: meeting.guestName ?? null });
  }
  if (meeting.hostEmail && meeting.hostEmail !== meeting.guestEmail) {
    attendees.push({ email: meeting.hostEmail, name: meeting.hostName ?? null });
  }

  return {
    uid: `meeting-${meeting.id}@loopkit`,
    sequence: opts.sequence ?? (meeting.status === "cancelled" ? 1 : 0),
    summary: meeting.title,
    description: meeting.notes ?? null,
    startsAt: meeting.startsAt,
    endsAt: meeting.endsAt,
    timezone: meeting.timezone ?? "UTC",
    organizer: opts.organizer ?? null,
    attendees,
    status:
      meeting.status === "cancelled"
        ? "CANCELLED"
        : meeting.status === "no_show" || meeting.status === "held"
          ? "CONFIRMED"
          : "CONFIRMED",
    transparency: meeting.status === "cancelled" ? "TRANSPARENT" : "OPAQUE",
    url: opts.url ?? null,
    alarmMinutes: opts.alarmMinutes ?? null,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  };
}

/**
 * Upcoming (or in-window) meetings suitable for a subscribed calendar feed.
 * Cancelled meetings are included briefly so clients see the cancellation,
 * then drop out once the start time has passed.
 */
export async function listMeetingsForCalendar(
  db: Db,
  workspaceId: string,
  opts: { from?: Date; to?: Date; limit?: number } = {},
): Promise<MeetingRow[]> {
  const from = opts.from ?? new Date(Date.now() - 24 * 3600_000);
  const to = opts.to ?? new Date(Date.now() + 90 * 24 * 3600_000);
  return db
    .select()
    .from(meetingTable)
    .where(
      and(
        eq(meetingTable.workspaceId, workspaceId),
        gte(meetingTable.endsAt, from),
        lte(meetingTable.startsAt, to),
      ),
    )
    .orderBy(asc(meetingTable.startsAt))
    .limit(opts.limit ?? 500);
}

export async function getMeetingByPublicId(db: Db, meetingId: string): Promise<MeetingRow | null> {
  const [row] = await db.select().from(meetingTable).where(eq(meetingTable.id, meetingId)).limit(1);
  return row ?? null;
}

/** Marks the host prep brief as emailed (poller idempotency). */
export async function markPrepBriefSent(
  db: Db,
  workspaceId: string,
  meetingId: string,
): Promise<MeetingRow | null> {
  const [row] = await db
    .update(meetingTable)
    .set({ prepBriefSentAt: new Date() })
    .where(and(eq(meetingTable.workspaceId, workspaceId), eq(meetingTable.id, meetingId)))
    .returning();
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Reminder scheduling                                                 */
/* ------------------------------------------------------------------ */

export type DueReminder = {
  meeting: MeetingRow;
  /** Hours-before-start offset this reminder corresponds to. */
  hoursBefore: number;
  /** When the meeting starts (already known; kept for convenience). */
  startsAt: Date;
};

/**
 * Finds scheduled meetings whose configured reminder offsets have come due
 * but have not been sent yet. Safe to call repeatedly — a reminder is only
 * returned until `markReminderSent` records it.
 */
export async function listDueMeetingReminders(
  db: Db,
  workspaceId: string,
  opts: { now?: Date; limit?: number } = {},
): Promise<DueReminder[]> {
  const now = opts.now ?? new Date();
  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  if (!settings?.sendReminders) return [];

  const offsets = (settings.reminderHoursBefore ?? []).filter(
    (h) => typeof h === "number" && h >= 0,
  );
  if (offsets.length === 0) return [];

  const horizonHours = Math.max(...offsets);
  const windowEnd = new Date(now.getTime() + horizonHours * 3600_000);

  const rows = await db
    .select()
    .from(meetingTable)
    .where(
      and(
        eq(meetingTable.workspaceId, workspaceId),
        eq(meetingTable.status, "scheduled"),
        // Meeting must start within the reminder horizon (or already be close).
        lte(meetingTable.startsAt, windowEnd),
        // And still be in the future (or at most 5 min past — don't spam ghosts).
        gt(meetingTable.startsAt, new Date(now.getTime() - 5 * 60_000)),
      ),
    )
    .orderBy(asc(meetingTable.startsAt))
    .limit(opts.limit ?? 100);

  const out: DueReminder[] = [];
  for (const meeting of rows) {
    const startsAt = new Date(meeting.startsAt);
    const hoursUntil = (startsAt.getTime() - now.getTime()) / 3600_000;
    const already = new Set(meeting.remindersSent ?? []);
    for (const offset of offsets) {
      if (already.has(offset)) continue;
      // Due when we've reached or passed the offset point.
      if (hoursUntil <= offset) {
        out.push({ meeting, hoursBefore: offset, startsAt });
      }
    }
  }
  return out;
}

/** Records that the reminder at `hoursBefore` has been sent for a meeting. */
export async function markMeetingReminderSent(
  db: Db,
  workspaceId: string,
  meetingId: string,
  hoursBefore: number,
): Promise<MeetingRow | null> {
  const current = await getMeeting(db, workspaceId, meetingId);
  if (!current) return null;
  const sent = new Set(current.remindersSent ?? []);
  if (sent.has(hoursBefore)) return current;
  sent.add(hoursBefore);
  const [row] = await db
    .update(meetingTable)
    .set({ remindersSent: [...sent].sort((a, b) => b - a) })
    .where(and(eq(meetingTable.workspaceId, workspaceId), eq(meetingTable.id, meetingId)))
    .returning();
  return row ?? null;
}

/**
 * Silently records all configured offsets as sent — used when the caller
 * opts out of emails (skipReminder) so the poller never re-picks the row.
 */
export async function markAllMeetingRemindersSent(
  db: Db,
  workspaceId: string,
  meetingId: string,
): Promise<void> {
  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  const offsets = settings?.reminderHoursBefore ?? [];
  await db
    .update(meetingTable)
    .set({ remindersSent: offsets })
    .where(and(eq(meetingTable.workspaceId, workspaceId), eq(meetingTable.id, meetingId)));
}
