/**
 * Meetings Intelligence — the loop that turns calendar events into funnel
 * motion. Not CRUD: every status change, every slot offered, and every
 * upcoming meeting is scored, briefed, and routed into tasks / plays /
 * journeys so the sales side actually moves without manual babysitting.
 *
 * Three capabilities live here:
 *   1. applyMeetingOutcome      — held / no_show / cancelled → score + plays
 *                                + follow-up tasks + journey enrollments
 *   2. buildMeetingPrepBrief    — a composed prep packet from signals,
 *                                score, company, and history for the host
 *   3. rankMeetingSlots         — slot ordering by guest timezone, host
 *                                load, and historical held-rate
 */
import { and, desc, eq, gte, ne } from "drizzle-orm";

import type { Db } from "@loopkit/db";
import {
  company as companyTable,
  contact as contactTable,
  contactEvent as contactEventTable,
  meeting as meetingTable,
} from "@loopkit/db/schema";

import { recordContactEvent } from "./contacts";
import { createTask } from "./gtm";
import { recomputeLeadScore } from "./leadScoring";
import {
  getMeeting,
  getOrCreateMeetingSettings,
  type MeetingRow,
  type MeetingStatus,
  type Slot,
} from "./meetings";
import { evaluatePlays, type PlayEvaluationResult } from "./plays";

export type MeetingOutcome = Exclude<MeetingStatus, "scheduled">;

/** Built-in score weights for meeting outcomes (added on top of rules). */
export const MEETING_OUTCOME_SCORE: Record<MeetingOutcome, number> = {
  held: 20,
  no_show: -15,
  cancelled: -5,
};

export type MeetingOutcomeResult = {
  meeting: MeetingRow;
  status: MeetingOutcome;
  /** Contact event recorded for this outcome (one per meeting+status). */
  eventId: string | null;
  leadScore?: number;
  leadTier?: "hot" | "warm" | "cold";
  /** Tasks the loop dispatched. */
  tasksCreated: string[];
  /** Journeys the caller should start (engine lives in the server). */
  journeyStarts: Array<{ playId?: string; journeyId: string; contactId: string; reason: string }>;
  plays: PlayEvaluationResult;
  /** Score contribution from the built-in meeting-outcome weights. */
  outcomeScoreDelta: number;
};

const OUTCOME_EVENT: Record<MeetingOutcome, string> = {
  held: "meeting.held",
  no_show: "meeting.no_show",
  cancelled: "meeting.cancelled",
};

const OUTCOME_JOURNEY_FIELD: Record<MeetingOutcome, string> = {
  held: "postMeetingJourneyId",
  no_show: "noShowJourneyId",
  cancelled: "cancellationJourneyId",
};

/**
 * Runs the meeting-outcome intelligence loop. Idempotent on (meeting,
 * status) via the contact-event idempotency key — flipping status twice
 * does not double-score or double-task.
 */
export async function applyMeetingOutcome(
  db: Db,
  workspaceId: string,
  meetingId: string,
  status: MeetingOutcome,
  outcomeNotes?: string | null,
): Promise<MeetingOutcomeResult | null> {
  let meeting = await getMeeting(db, workspaceId, meetingId);
  if (!meeting) return null;

  // Own the transition: write the status so built-in outcome scoring sees it
  // even when the caller only invokes this function (tests, imports, hooks).
  if (meeting.status !== status) {
    const { updateMeetingStatus } = await import("./meetings");
    const updated = await updateMeetingStatus(
      db,
      workspaceId,
      meetingId,
      status,
      outcomeNotes ?? null,
    );
    if (updated) meeting = updated;
  }

  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  const contactId = meeting.contactId;
  const guestEmail = meeting.guestEmail;

  const journeyStarts: MeetingOutcomeResult["journeyStarts"] = [];
  const tasksCreated: string[] = [];

  // 1. First-class contact event — the play/scoring substrate.
  let eventId: string | null = null;
  if (contactId) {
    const recorded = await recordContactEvent(db, {
      workspaceId,
      contactId,
      name: OUTCOME_EVENT[status],
      properties: {
        meetingId: meeting.id,
        title: meeting.title,
        startsAt: meeting.startsAt,
        endsAt: meeting.endsAt,
        status,
        source: meeting.source,
        hostEmail: meeting.hostEmail ?? null,
        ...(outcomeNotes ? { outcome: outcomeNotes } : {}),
      },
      idempotencyKey: `meeting:${meeting.id}:${status}`,
    });
    eventId = recorded?.id ?? null;
  }

  // 2. Built-in follow-up tasks (also idempotent via (source, sourceId)).
  if (contactId) {
    if (status === "held") {
      const task = await createTask(db, workspaceId, {
        contactId,
        title: `Post-meeting follow-up: ${meeting.title}`,
        body: `Meeting held ${new Date(meeting.startsAt).toISOString()}. Log notes and propose next steps.`,
        kind: "email",
        priority: 9,
        source: "meeting_outcome",
        sourceId: `${meeting.id}:held`,
        dueAt: new Date(Date.now() + 24 * 3600_000),
      }).catch(() => null);
      if (task) tasksCreated.push(task.id);
    } else if (status === "no_show") {
      const task = await createTask(db, workspaceId, {
        contactId,
        title: `No-show recovery: ${meeting.title}`,
        body: `Guest missed the meeting on ${new Date(meeting.startsAt).toISOString()}. Offer a rebook link.`,
        kind: "call",
        priority: 10,
        source: "meeting_outcome",
        sourceId: `${meeting.id}:no_show`,
        dueAt: new Date(Date.now() + 2 * 3600_000),
      }).catch(() => null);
      if (task) tasksCreated.push(task.id);
    } else if (status === "cancelled") {
      const task = await createTask(db, workspaceId, {
        contactId,
        title: `Meeting cancelled: ${meeting.title}`,
        body: `Cancelled before it happened. Decide whether to re-engage.`,
        kind: "email",
        priority: 4,
        source: "meeting_outcome",
        sourceId: `${meeting.id}:cancelled`,
        dueAt: new Date(Date.now() + 48 * 3600_000),
      }).catch(() => null);
      if (task) tasksCreated.push(task.id);
    }
  }

  // 3. Configured journey enrollments (post-meeting / no-show recovery).
  const journeyField = OUTCOME_JOURNEY_FIELD[status] as keyof typeof settings;
  const journeyId = settings?.[journeyField];
  if (typeof journeyId === "string" && journeyId && contactId) {
    journeyStarts.push({
      journeyId,
      contactId,
      reason: `meeting.${status}`,
    });
  }

  // 4. Score + plays. recomputeLeadScore already folds in the built-in
  //    meeting-outcome weights (see leadScoring.ts), so a status flip
  //    moves the score without the operator writing a single rule.
  let leadScore: number | undefined;
  let leadTier: "hot" | "warm" | "cold" | undefined;
  let plays: PlayEvaluationResult = { fired: [], journeyStarts: [] };

  if (contactId && (guestEmail || meeting.guestEmail)) {
    const email = guestEmail ?? meeting.guestEmail ?? "";
    const scored = await recomputeLeadScore(db, workspaceId, contactId);
    leadScore = scored?.score;
    leadTier = scored?.tier;

    // Plays react to the outcome event itself.
    const eventPlays = await evaluatePlays(db, workspaceId, {
      kind: "event",
      contactId,
      email,
      eventName: OUTCOME_EVENT[status],
      eventProperties: {
        meetingId: meeting.id,
        status,
        source: meeting.source,
      },
      properties: {},
      leadScore,
    });
    plays.fired.push(...eventPlays.fired);
    plays.journeyStarts.push(...eventPlays.journeyStarts);

    // And to any score boundary this outcome crossed.
    if (leadScore != null) {
      const prev = Number(
        (
          await db
            .select({ properties: contactTable.properties })
            .from(contactTable)
            .where(eq(contactTable.id, contactId))
            .limit(1)
        )[0]?.properties?.leadScore ?? 0,
      );
      if (prev !== leadScore) {
        const cross = await evaluatePlays(db, workspaceId, {
          kind: "score_changed",
          contactId,
          email,
          leadScore,
          previousScore: prev,
          properties: {},
        });
        plays.fired.push(...cross.fired);
        plays.journeyStarts.push(...cross.journeyStarts);
      }
    }
  }

  // Collect any journey starts plays requested alongside ours.
  for (const start of plays.journeyStarts) {
    if (
      !journeyStarts.some((j) => j.journeyId === start.journeyId && j.contactId === start.contactId)
    ) {
      journeyStarts.push({
        playId: start.playId,
        journeyId: start.journeyId,
        contactId: start.contactId,
        reason: `play:${OUTCOME_EVENT[status]}`,
      });
    }
  }

  return {
    meeting,
    status,
    eventId,
    leadScore,
    leadTier,
    tasksCreated,
    journeyStarts,
    plays,
    outcomeScoreDelta: MEETING_OUTCOME_SCORE[status],
  };
}

/* ------------------------------------------------------------------ */
/* Meeting prep brief                                                  */
/* ------------------------------------------------------------------ */

export type MeetingPrepBrief = {
  meeting: {
    id: string;
    title: string;
    startsAt: Date | string;
    endsAt: Date | string;
    timezone: string;
    status: MeetingStatus;
    source: string;
    notes: string | null;
    hostName: string | null;
    hostEmail: string | null;
  };
  contact: {
    id: string | null;
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
  /** Most recent high-intent / page activity. */
  signals: Array<{ name: string; path?: string; occurredAt: string }>;
  /** Last events, newest first. */
  timeline: Array<{ name: string; occurredAt: string; properties: Record<string, unknown> }>;
  /** Prior meetings and how they went. */
  history: Array<{
    title: string;
    startsAt: string;
    status: MeetingStatus;
    outcome: string | null;
  }>;
  openTasks: Array<{ title: string; kind: string; dueAt: string | null; priority: number }>;
  /** Derived talking points — the part a host actually reads. */
  talkingPoints: string[];
};

/**
 * Composes a prep brief from what the platform already knows: score,
 * company rollup, website signals, event timeline, prior meetings, open
 * tasks. Computed on demand — never stored, never stale.
 */
export async function buildMeetingPrepBrief(
  db: Db,
  workspaceId: string,
  meetingId: string,
): Promise<MeetingPrepBrief | null> {
  const meeting = await getMeeting(db, workspaceId, meetingId);
  if (!meeting) return null;

  const contactId = meeting.contactId;
  const contactRow = contactId
    ? ((await db.select().from(contactTable).where(eq(contactTable.id, contactId)).limit(1))[0] ??
      null)
    : null;

  const props = (contactRow?.properties ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(props.tags) ? (props.tags as string[]).map(String) : [];
  const leadScore = typeof props.leadScore === "number" ? props.leadScore : 0;
  const leadTier = typeof props.leadTier === "string" ? props.leadTier : "cold";
  const ltvCents = typeof props.ltvCents === "number" ? props.ltvCents : 0;
  const name =
    (typeof props.firstName === "string" ? props.firstName : "") || meeting.guestName || null;

  // Company rollup via email domain.
  const email = contactRow?.email ?? meeting.guestEmail ?? "";
  let company: MeetingPrepBrief["company"] = null;
  if (email) {
    const { domainFromEmail, companyNameFromDomain } = await import("@loopkit/db/schema");
    const domain = domainFromEmail(email);
    if (domain) {
      const [row] = await db
        .select()
        .from(companyTable)
        .where(and(eq(companyTable.workspaceId, workspaceId), eq(companyTable.domain, domain)))
        .limit(1);
      if (row) {
        company = {
          name: row.name,
          domain: row.domain,
          contactCount: row.contactCount,
          hotLeadCount: row.hotLeadCount,
          totalLtvCents: row.totalLtvCents,
        };
      } else {
        company = {
          name: companyNameFromDomain(domain),
          domain,
          contactCount: 0,
          hotLeadCount: 0,
          totalLtvCents: 0,
        };
      }
    }
  }

  // Recent website signals + timeline.
  const signals: MeetingPrepBrief["signals"] = [];
  const timeline: MeetingPrepBrief["timeline"] = [];
  if (contactId) {
    const events = await db
      .select()
      .from(contactEventTable)
      .where(eq(contactEventTable.contactId, contactId))
      .orderBy(desc(contactEventTable.occurredAt))
      .limit(25);
    for (const e of events) {
      const path =
        e.properties && typeof e.properties === "object" && "path" in e.properties
          ? String((e.properties as Record<string, unknown>).path ?? "")
          : undefined;
      if (e.name === "page.viewed") {
        signals.push({
          name: e.name,
          path,
          occurredAt: e.occurredAt.toISOString(),
        });
      }
      timeline.push({
        name: e.name,
        occurredAt: e.occurredAt.toISOString(),
        properties: (e.properties ?? {}) as Record<string, unknown>,
      });
    }
  }

  // Prior meetings.
  const history = contactId
    ? (
        await db
          .select({
            title: meetingTable.title,
            startsAt: meetingTable.startsAt,
            status: meetingTable.status,
            outcome: meetingTable.outcome,
          })
          .from(meetingTable)
          .where(
            and(
              eq(meetingTable.workspaceId, workspaceId),
              eq(meetingTable.contactId, contactId),
              ne(meetingTable.id, meeting.id),
            ),
          )
          .orderBy(desc(meetingTable.startsAt))
          .limit(5)
      ).map((h) => ({
        title: h.title,
        startsAt: h.startsAt.toISOString(),
        status: h.status,
        outcome: h.outcome,
      }))
    : [];

  // Open tasks.
  const { openTasksForContact } = await import("./gtm");
  const taskRows = contactId
    ? await openTasksForContact(db, workspaceId, contactId).catch(() => [])
    : [];
  const openTasks = taskRows.map((t) => ({
    title: t.title,
    kind: t.kind,
    dueAt: t.dueAt ? new Date(t.dueAt).toISOString() : null,
    priority: t.priority,
  }));

  // Derived talking points — the actual product value.
  const talkingPoints: string[] = [];
  if (leadTier === "hot") {
    talkingPoints.push(`Hot lead (score ${leadScore}) — expect buying questions.`);
  } else if (leadTier === "warm") {
    talkingPoints.push(`Warm lead (score ${leadScore}) — focus on use-case fit.`);
  } else {
    talkingPoints.push(`Cold lead (score ${leadScore}) — lead with discovery.`);
  }
  const highIntent = signals.filter((s) =>
    /pricing|demo|checkout|upgrade|contact|security/i.test(s.path ?? ""),
  );
  if (highIntent.length > 0) {
    talkingPoints.push(
      `Recently visited ${highIntent
        .slice(0, 3)
        .map((s) => s.path)
        .join(", ")} — pull that thread first.`,
    );
  }
  if (company && company.contactCount > 1) {
    talkingPoints.push(
      `${company.name} has ${company.contactCount} contacts here (LTV $${(company.totalLtvCents / 100).toFixed(0)}) — multi-thread if needed.`,
    );
  }
  const lastHeld = history.find((h) => h.status === "held");
  if (lastHeld) {
    talkingPoints.push(
      `Last meeting ${new Date(lastHeld.startsAt).toISOString().slice(0, 10)}${lastHeld.outcome ? `: ${lastHeld.outcome}` : " — follow up on prior commitments."}`,
    );
  }
  const noShow = history.find((h) => h.status === "no_show");
  if (noShow) {
    talkingPoints.push("Previously no-showed — confirm attendance early.");
  }
  if (meeting.notes) {
    talkingPoints.push(`Booking note: ${meeting.notes}`);
  }
  if (openTasks.length > 0) {
    talkingPoints.push(
      `${openTasks.length} open task${openTasks.length > 1 ? "s" : ""} already queued — don't duplicate outreach.`,
    );
  }

  return {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      startsAt: meeting.startsAt,
      endsAt: meeting.endsAt,
      timezone: meeting.timezone,
      status: meeting.status,
      source: meeting.source,
      notes: meeting.notes,
      hostName: meeting.hostName,
      hostEmail: meeting.hostEmail,
    },
    contact: {
      id: contactId,
      email: email || null,
      name,
      leadScore,
      leadTier,
      tags,
      ltvCents,
    },
    company,
    signals: signals.slice(0, 8),
    timeline: timeline.slice(0, 12),
    history,
    openTasks,
    talkingPoints,
  };
}

/* ------------------------------------------------------------------ */
/* Smart slot ranking                                                  */
/* ------------------------------------------------------------------ */

export type RankedSlot = Slot & {
  /** 0–100. Higher is a better offer. */
  score: number;
  /** Human-readable reasons the slot scored what it did. */
  reasons: string[];
  hostEmail: string | null;
};

export type RankSlotsOptions = {
  /** Guest's IANA timezone, when known. */
  guestTimezone?: string | null;
  /** Contact id — used to pull historical held-rate by hour. */
  contactId?: string | null;
  /** Bias toward sooner slots (hot leads). */
  urgency?: number;
  limit?: number;
};

/**
 * Ranks bookable slots by how likely they are to convert and stick:
 *   - guest business-hours fit (when their timezone is known)
 *   - host day-load (prefer less-burdened days)
 *   - historical held-rate for that hour-of-day in this workspace
 *   - mild recency bias when urgency is set
 */
export async function rankMeetingSlots(
  db: Db,
  workspaceId: string,
  slots: Slot[],
  opts: RankSlotsOptions = {},
): Promise<RankedSlot[]> {
  if (slots.length === 0) return [];

  const now = Date.now();
  const dayLoad = new Map<string, number>();
  const hourHeld = new Map<number, { held: number; total: number }>();

  // Host day-load + historical hour quality from past meetings.
  const past = await db
    .select({
      startsAt: meetingTable.startsAt,
      status: meetingTable.status,
    })
    .from(meetingTable)
    .where(
      and(
        eq(meetingTable.workspaceId, workspaceId),
        ne(meetingTable.status, "cancelled"),
        gte(meetingTable.startsAt, new Date(now - 90 * 24 * 3600_000)),
      ),
    );

  for (const row of past) {
    const day = row.startsAt.toISOString().slice(0, 10);
    dayLoad.set(day, (dayLoad.get(day) ?? 0) + 1);
    const hour = row.startsAt.getUTCHours();
    const bucket = hourHeld.get(hour) ?? { held: 0, total: 0 };
    bucket.total += 1;
    if (row.status === "held") bucket.held += 1;
    hourHeld.set(hour, bucket);
  }

  const guestTz = opts.guestTimezone || null;
  const urgency = Math.max(0, Math.min(1, opts.urgency ?? 0));

  const ranked: RankedSlot[] = slots.map((slot) => {
    const starts = new Date(slot.startsAt);
    const reasons: string[] = [];
    let score = 50;

    if (!slot.available) {
      return { ...slot, score: 0, reasons: ["unavailable"], hostEmail: null };
    }

    // Guest business-hours fit (9–18 local).
    if (guestTz) {
      try {
        const localHour = Number(
          new Intl.DateTimeFormat("en-US", { timeZone: guestTz, hour: "numeric", hour12: false })
            .formatToParts(starts)
            .find((p) => p.type === "hour")?.value ?? "0",
        );
        if (localHour >= 9 && localHour < 18) {
          score += 18;
          reasons.push("in guest business hours");
        } else if (localHour >= 8 && localHour < 20) {
          score += 8;
          reasons.push("near guest business hours");
        } else {
          score -= 20;
          reasons.push("outside guest business hours");
        }
      } catch {
        /* unknown tz — skip */
      }
    }

    // Host day-load: quieter days score higher.
    const day = starts.toISOString().slice(0, 10);
    const load = dayLoad.get(day) ?? 0;
    if (load === 0) {
      score += 12;
      reasons.push("host day is open");
    } else if (load <= 2) {
      score += 6;
      reasons.push("light host day");
    } else if (load >= 5) {
      score -= 10;
      reasons.push("host day is heavy");
    }

    // Historical held-rate for this hour-of-day.
    const bucket = hourHeld.get(starts.getUTCHours());
    if (bucket && bucket.total >= 3) {
      const rate = bucket.held / bucket.total;
      if (rate >= 0.8) {
        score += 15;
        reasons.push("strong historical show-rate this hour");
      } else if (rate >= 0.5) {
        score += 5;
        reasons.push("solid show-rate this hour");
      } else if (rate < 0.3) {
        score -= 12;
        reasons.push("weak historical show-rate this hour");
      }
    }

    // Recency bias for urgent leads: earlier slots win.
    if (urgency > 0) {
      const daysOut = (starts.getTime() - now) / (24 * 3600_000);
      const recency = Math.max(0, 20 - daysOut * 2.5) * urgency;
      if (recency > 1) {
        score += recency;
        reasons.push("sooner is better for this lead");
      }
    }

    // Mid-morning / early-afternoon mild preference (universal, not tz-based).
    const utcHour = starts.getUTCHours();
    if (utcHour >= 14 && utcHour <= 17) {
      score += 4;
      reasons.push("popular afternoon slot");
    }

    return {
      ...slot,
      score: Math.round(Math.max(0, Math.min(100, score))),
      reasons,
      hostEmail: null,
    };
  });

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.startsAt.localeCompare(b.startsAt);
  });

  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}
