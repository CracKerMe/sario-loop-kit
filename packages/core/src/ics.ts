/**
 * RFC 5545 iCalendar generation for meetings.
 *
 * Pure string builders — no I/O — so the same code backs the public
 * `/calendar/:token.ics` feed, single-event downloads, and the .ics
 * attachment on booking confirmation / reminder emails.
 */

export type IcsPerson = {
  name?: string | null;
  email: string;
};

export type IcsEventInput = {
  /** Stable UID. Callers should use `meeting-<id>@loopkit`. */
  uid: string;
  /** Sequence number; bump when the event is updated (reschedule, cancel). */
  sequence?: number;
  summary: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date | string;
  endsAt: Date | string;
  /** IANA timezone of the event; times themselves are emitted in UTC. */
  timezone?: string | null;
  organizer?: IcsPerson | null;
  attendees?: IcsPerson[];
  /** CONFIRMED | CANCELLED | TENTATIVE */
  status?: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
  /** Minutes before start for a DISPLAY alarm (0 disables). */
  alarmMinutes?: number | null;
  /** Free/busy: OPAQUE (busy) | TRANSPARENT (free). */
  transparency?: "OPAQUE" | "TRANSPARENT";
  url?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

export type IcsCalendarInput = {
  /** Calendar name shown by subscribed clients. */
  calendarName?: string;
  productId?: string;
  /** Refresh interval hint for subscribed feeds, e.g. "PT1H". */
  refreshInterval?: string;
  events: IcsEventInput[];
  /** X-WR-TIMEZONE for the calendar. */
  timezone?: string | null;
};

const CRLF = "\r\n";

/** Escape TEXT values per RFC 5545 §3.3.11. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n/g, "\\n")
    .replace(/[\n\r]/g, "\\n");
}

/** Fold long lines at 75 octets (RFC 5545 §3.1). */
export function foldIcsLine(line: string): string {
  // Work on UTF-8 bytes so multi-byte CJK characters aren't split mid-codepoint.
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const chunks: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    // Continuation lines are 74 octets + leading space.
    const limit = first ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    // Don't split a multi-byte sequence: back up while we're mid-character.
    if (end < bytes.length) {
      while (end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    }
    const piece = bytes.subarray(start, end).toString("utf8");
    chunks.push(first ? piece : ` ${piece}`);
    first = false;
    start = end;
  }
  return chunks.join(CRLF);
}

/** Format a date as UTC iCalendar DATE-TIME (`19700101T000000Z`). */
export function formatIcsUtc(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) throw new Error("invalid_date");
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function formatIcsUtcStamp(date: Date | string = new Date()): string {
  return formatIcsUtc(date);
}

function personLine(
  kind: "ORGANIZER" | "ATTENDEE",
  person: IcsPerson,
  role: string,
  partstat: string,
): string {
  const cn = person.name ? `;CN=${escapeIcsText(person.name)}` : "";
  return `${kind}${cn};ROLE=${role};PARTSTAT=${partstat}:mailto:${person.email}`;
}

/**
 * Build a single VEVENT. The returned block does NOT include BEGIN/END:VCALENDAR
 * so multiple events can be composed into one feed.
 */
export function buildVEvent(event: IcsEventInput): string {
  const start = formatIcsUtc(event.startsAt);
  const end = formatIcsUtc(event.endsAt);
  const stamp = formatIcsUtcStamp(event.updatedAt ?? event.createdAt ?? new Date());
  const dtstamp =
    event.updatedAt || event.createdAt ? formatIcsUtc(event.updatedAt ?? event.createdAt!) : stamp;

  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
  ];

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  if (event.url) {
    lines.push(`URL:${event.url}`);
  }

  lines.push(`STATUS:${event.status ?? "CONFIRMED"}`);
  lines.push(`TRANSP:${event.transparency ?? "OPAQUE"}`);

  if (event.organizer?.email) {
    lines.push(personLine("ORGANIZER", event.organizer, "CHAIR", "ACCEPTED"));
  }
  for (const attendee of event.attendees ?? []) {
    if (!attendee?.email) continue;
    lines.push(personLine("ATTENDEE", attendee, "REQ-PARTICIPANT", "NEEDS-ACTION"));
  }

  const alarmMinutes = event.alarmMinutes ?? null;
  if (alarmMinutes != null && alarmMinutes > 0) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcsText(event.summary)}`,
      `TRIGGER:-PT${alarmMinutes}M`,
      "END:VALARM",
    );
  }

  lines.push("END:VEVENT");
  return lines.map(foldIcsLine).join(CRLF);
}

/** Build a complete VCALENDAR document ready to serve as `text/calendar`. */
export function buildVCalendar(input: IcsCalendarInput): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${input.productId ?? "-//Loopkit//Meetings//EN"}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (input.calendarName) {
    lines.push(`X-WR-CALNAME:${escapeIcsText(input.calendarName)}`);
  }
  if (input.timezone) {
    lines.push(`X-WR-TIMEZONE:${escapeIcsText(input.timezone)}`);
  }
  if (input.refreshInterval) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${input.refreshInterval}`);
    lines.push(`X-PUBLISHED-TTL:${input.refreshInterval}`);
  }
  for (const event of input.events) {
    lines.push(buildVEvent(event));
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}

/** Convenience: one-event calendar (booking confirmation attachment). */
export function buildMeetingIcs(event: IcsEventInput, calendarName?: string): string {
  return buildVCalendar({
    calendarName: calendarName ?? event.summary,
    events: [event],
  });
}

/** Content-Type / Content-Disposition helpers for email attachments. */
export function icsAttachment(
  filename: string,
  ics: string,
): {
  filename: string;
  content: string;
  contentType: string;
  disposition: "attachment";
} {
  return {
    filename,
    content: ics,
    contentType: "text/calendar; charset=utf-8; method=PUBLISH",
    disposition: "attachment",
  };
}
