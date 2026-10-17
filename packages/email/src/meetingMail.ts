/**
 * Meeting transactional mail: booking confirmation, pre-meeting reminders,
 * and host-assignment notices. These are service messages (no unsubscribe
 * link, no marketing cadence) sent straight through an EmailProvider —
 * they are deliberately NOT routed via the journey/campaign channel, which
 * requires a saved template and is optimized for lifecycle mail.
 */
import type { EmailAttachment, EmailProvider, SendEmailInput } from "./provider";

export type MeetingMailPerson = {
  email: string;
  name?: string | null;
};

export type MeetingMailData = {
  meetingId: string;
  title: string;
  startsAt: Date | string;
  endsAt: Date | string;
  timezone?: string | null;
  notes?: string | null;
  guest: MeetingMailPerson;
  host?: MeetingMailPerson | null;
  organizer?: MeetingMailPerson | null;
  /** Absolute URL the guest can open to see / manage the booking. */
  manageUrl?: string | null;
  /** Absolute URL of the ICS feed the guest can subscribe to. */
  calendarFeedUrl?: string | null;
  /** Pre-built .ics body attached to the message. */
  ics?: string | null;
  icsFilename?: string | null;
};

export type ComposeMeetingMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
};

function fmtWhen(startsAt: Date | string, endsAt: Date | string, timezone?: string | null): string {
  const tz = timezone || "UTC";
  try {
    const start = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(startsAt));
    const end = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeStyle: "short",
    }).format(new Date(endsAt));
    return `${start} – ${end} (${tz})`;
  } catch {
    return `${startsAt} → ${endsAt}`;
  }
}

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.55;color:#0f172a;padding:24px;max-width:560px;margin:0 auto">
  <h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
  ${bodyHtml}
  <p style="margin-top:28px;font-size:12px;color:#64748b">Sent by Loopkit Meetings</p>
</body></html>`;
}

function attachIcs(data: MeetingMailData): EmailAttachment[] | undefined {
  if (!data.ics) return undefined;
  return [
    {
      filename: data.icsFilename ?? "meeting.ics",
      content: data.ics,
      contentType: "text/calendar; charset=utf-8; method=PUBLISH",
      disposition: "attachment",
    },
  ];
}

/** Booking confirmation for the guest (includes .ics). */
export function composeBookingConfirmation(data: MeetingMailData): ComposeMeetingMail {
  const when = fmtWhen(data.startsAt, data.endsAt, data.timezone);
  const hostLine =
    data.host?.name || data.host?.email
      ? `<p>Your host: <strong>${data.host.name ?? data.host.email}</strong></p>`
      : "";
  const links = [
    data.manageUrl ? `<p><a href="${data.manageUrl}">View or reschedule</a></p>` : "",
    data.calendarFeedUrl
      ? `<p><a href="${data.calendarFeedUrl}">Subscribe to this calendar</a></p>`
      : "",
  ].join("");

  return {
    to: data.guest.email,
    subject: `Confirmed: ${data.title}`,
    html: shell(
      "You're booked",
      `<p>Hi ${data.guest.name ?? ""},</p>
       <p>Your meeting <strong>${data.title}</strong> is confirmed.</p>
       <p><strong>${when}</strong></p>
       ${hostLine}
       ${data.notes ? `<p style="white-space:pre-wrap">${data.notes}</p>` : ""}
       ${links}
       <p style="margin-top:16px">An .ics calendar file is attached.</p>`,
    ),
    text: [
      `You're booked: ${data.title}`,
      when,
      data.host?.name ? `Host: ${data.host.name}` : "",
      data.notes ?? "",
      data.manageUrl ? `Manage: ${data.manageUrl}` : "",
      data.calendarFeedUrl ? `Calendar feed: ${data.calendarFeedUrl}` : "",
      "",
      "An .ics calendar file is attached.",
    ]
      .filter(Boolean)
      .join("\n"),
    attachments: attachIcs(data),
  };
}

/** Pre-meeting reminder for the guest (includes .ics). */
export function composeMeetingReminder(
  data: MeetingMailData,
  hoursBefore: number,
): ComposeMeetingMail {
  const when = fmtWhen(data.startsAt, data.endsAt, data.timezone);
  const label =
    hoursBefore >= 24
      ? `in ${Math.round(hoursBefore / 24)} day${hoursBefore >= 48 ? "s" : ""}`
      : hoursBefore >= 1
        ? `in ${Math.round(hoursBefore)} hour${hoursBefore >= 2 ? "s" : ""}`
        : "soon";

  return {
    to: data.guest.email,
    subject: `Reminder: ${data.title} ${label}`,
    html: shell(
      `Meeting ${label}`,
      `<p>Hi ${data.guest.name ?? ""},</p>
       <p>Just a reminder that <strong>${data.title}</strong> starts ${label}.</p>
       <p><strong>${when}</strong></p>
       ${data.host?.name ? `<p>Your host: <strong>${data.host.name}</strong></p>` : ""}
       ${data.manageUrl ? `<p><a href="${data.manageUrl}">View details</a></p>` : ""}`,
    ),
    text: [
      `Reminder: ${data.title} ${label}`,
      when,
      data.host?.name ? `Host: ${data.host.name}` : "",
      data.manageUrl ? `Details: ${data.manageUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    attachments: attachIcs(data),
  };
}

/** Notice to the assigned host that a meeting landed on their calendar. */
export function composeHostAssignment(data: MeetingMailData): ComposeMeetingMail {
  const when = fmtWhen(data.startsAt, data.endsAt, data.timezone);
  const to = data.host?.email;
  if (!to) throw new Error("host_email_required");

  return {
    to,
    subject: `New meeting: ${data.title}`,
    html: shell(
      "New meeting assigned to you",
      `<p><strong>${data.title}</strong></p>
       <p><strong>${when}</strong></p>
       <p>Guest: ${data.guest.name ?? ""} &lt;${data.guest.email}&gt;</p>
       ${data.notes ? `<p style="white-space:pre-wrap">${data.notes}</p>` : ""}
       ${data.manageUrl ? `<p><a href="${data.manageUrl}">View in Loopkit</a></p>` : ""}`,
    ),
    text: [
      `New meeting: ${data.title}`,
      when,
      `Guest: ${data.guest.name ?? ""} <${data.guest.email}>`,
      data.notes ?? "",
      data.manageUrl ? `Manage: ${data.manageUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    attachments: attachIcs(data),
  };
}

/**
 * Prep-brief mail for the host. Accepts the structured brief from
 * @loopkit/core's buildMeetingPrepBrief — the composition layer here stays
 * presentation-only so core keeps zero email dependencies.
 */
export function composePrepBrief(brief: {
  meeting: {
    title: string;
    startsAt: Date | string;
    endsAt: Date | string;
    timezone: string;
    notes: string | null;
    hostEmail?: string | null;
    hostName?: string | null;
  };
  contact: {
    email: string | null;
    name: string | null;
    leadScore: number;
    leadTier: string;
    tags: string[];
    ltvCents: number;
  };
  company: {
    name: string;
    domain: string;
    contactCount: number;
    hotLeadCount: number;
    totalLtvCents: number;
  } | null;
  signals: Array<{ name: string; path?: string; occurredAt: string }>;
  history: Array<{ title: string; startsAt: string; status: string; outcome: string | null }>;
  openTasks: Array<{ title: string; kind: string; dueAt: string | null }>;
  talkingPoints: string[];
}): ComposeMeetingMail {
  const to = brief.meeting.hostEmail ?? "";
  if (!to) throw new Error("host_email_required");

  const when = fmtWhen(brief.meeting.startsAt, brief.meeting.endsAt, brief.meeting.timezone);
  const c = brief.contact;
  const signalLines = brief.signals
    .slice(0, 5)
    .map(
      (s) =>
        `<li>${s.path ?? s.name} <span style="color:#64748b">${s.occurredAt.slice(0, 10)}</span></li>`,
    )
    .join("");
  const historyLines = brief.history
    .slice(0, 3)
    .map(
      (h) =>
        `<li>${h.title} — ${h.status}${h.outcome ? `: ${h.outcome}` : ""} <span style="color:#64748b">${h.startsAt.slice(0, 10)}</span></li>`,
    )
    .join("");
  const points = brief.talkingPoints.map((p) => `<li>${p}</li>`).join("");

  return {
    to,
    subject: `Prep: ${brief.meeting.title} — ${c.name ?? c.email ?? "guest"} (${c.leadTier} · ${c.leadScore})`,
    html: shell(
      "Meeting prep brief",
      `<p><strong>${brief.meeting.title}</strong> · ${when}</p>
       <p>Guest: <strong>${c.name ?? "—"}</strong> &lt;${c.email ?? "—"}&gt; ·
          score <strong>${c.leadScore}</strong> (${c.leadTier}) ·
          LTV $${(c.ltvCents / 100).toFixed(0)}${
            c.tags.length ? ` · tags: ${c.tags.join(", ")}` : ""
          }</p>
       ${
         brief.company
           ? `<p>Company: <strong>${brief.company.name}</strong> (${brief.company.domain}) · ${brief.company.contactCount} contacts · $${(brief.company.totalLtvCents / 100).toFixed(0)} LTV</p>`
           : ""
       }
       <h2 style="font-size:15px;margin:20px 0 8px">Talking points</h2>
       <ul style="margin:0;padding-left:18px">${points || "<li>—</li>"}</ul>
       ${signalLines ? `<h2 style="font-size:15px;margin:20px 0 8px">Recent signals</h2><ul style="margin:0;padding-left:18px">${signalLines}</ul>` : ""}
       ${historyLines ? `<h2 style="font-size:15px;margin:20px 0 8px">Meeting history</h2><ul style="margin:0;padding-left:18px">${historyLines}</ul>` : ""}
       ${brief.meeting.notes ? `<p style="white-space:pre-wrap;margin-top:16px"><strong>Notes:</strong> ${brief.meeting.notes}</p>` : ""}`,
    ),
    text: [
      `Prep: ${brief.meeting.title}`,
      when,
      `Guest: ${c.name ?? ""} <${c.email ?? ""}> · ${c.leadTier} · score ${c.leadScore}`,
      brief.company ? `Company: ${brief.company.name} (${brief.company.domain})` : "",
      "",
      "Talking points:",
      ...brief.talkingPoints.map((p) => `  • ${p}`),
      brief.signals.length
        ? `\nRecent signals:\n${brief.signals
            .slice(0, 5)
            .map((s) => `  • ${s.path ?? s.name}`)
            .join("\n")}`
        : "",
      brief.meeting.notes ? `\nNotes: ${brief.meeting.notes}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export type SendMeetingMailInput = {
  from: string;
  replyTo?: string | null;
  /** Compose output, plus any extra headers. */
  mail: ComposeMeetingMail;
  tags?: Record<string, string>;
};

/** Thin wrapper so callers don't repeat from/replyTo plumbing. */
export async function sendMeetingMail(
  provider: EmailProvider,
  input: SendMeetingMailInput,
): Promise<{ messageId: string }> {
  const payload: SendEmailInput = {
    to: input.mail.to,
    from: input.from,
    replyTo: input.replyTo ?? undefined,
    subject: input.mail.subject,
    html: input.mail.html,
    text: input.mail.text,
    attachments: input.mail.attachments,
    tags: input.tags,
  };
  return provider.send(payload);
}
