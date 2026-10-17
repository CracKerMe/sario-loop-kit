/**
 * GTM surface: meetings booking (types, slots, bookings), follow-up task
 * queue, company account rollups. Session-guarded admin APIs + a public
 * booking surface.
 */
import {
  applyMeetingOutcome,
  bookMeeting,
  buildMeetingPrepBrief,
  completeTask,
  createMeetingHost,
  createMeetingType,
  createTask,
  deleteMeetingHost,
  deleteMeetingType,
  ensureCalendarToken,
  ensureDefaultMeetingType,
  getCompany,
  getMeeting,
  getMeetingByPublicId,
  getOrCreateMeetingSettings,
  listCompanies,
  listCompanyContacts,
  listMeetingHosts,
  listMeetingSlots,
  listMeetings,
  listMeetingTypes,
  listTasks,
  meetingEmailVariables,
  openTasksForContact,
  rankMeetingSlots,
  recomputeCompanyRollups,
  recordContactEvent,
  runIntelligenceHook,
  syncContactCompany,
  taskStats,
  updateMeetingHost,
  updateMeetingSettings,
  updateMeetingStatus,
  updateMeetingType,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { contact as contactTable } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import {
  buildMeetingIcsFile,
  buildWorkspaceCalendarFeed,
  sendBookingNotifications,
  workspaceIdForCalendarToken,
} from "../meetingMailer";
import { applyPlayJourneyStarts } from "../intelligenceHooks";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { getEngine } from "../loopkitRuntime";

type AppEnv = { Variables: AuthVariables };

function sessionAuth() {
  return requireAuth({ allow: ["session"] });
}

/* ------------------------------------------------------------------ */
/* Meetings (admin)                                                    */
/* ------------------------------------------------------------------ */

export const meetingsRouter = new Hono<AppEnv>();
meetingsRouter.use(sessionAuth());

const settingsSchema = z.object({
  bookingUrl: z.string().url().nullish(),
  meetingTitle: z.string().min(1).max(120).optional(),
  meetingDescription: z.string().max(500).nullish(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  ctaLabel: z.string().min(1).max(80).optional(),
  timezone: z.string().min(1).max(64).optional(),
  availableWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  dayStartMinute: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 - 15)
    .optional(),
  dayEndMinute: z
    .number()
    .int()
    .min(15)
    .max(24 * 60)
    .optional(),
  bufferMinutes: z.number().int().min(0).max(120).optional(),
  leadDays: z.number().int().min(1).max(60).optional(),
  bookingSlug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(40)
    .nullish(),
  reminderHoursBefore: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(24 * 30),
    )
    .max(6)
    .optional(),
  sendBookingConfirmation: z.boolean().optional(),
  sendReminders: z.boolean().optional(),
  assignmentMode: z.enum(["round_robin", "fixed", "none"]).optional(),
  fixedHostEmail: z.string().email().nullish(),
  organizerName: z.string().max(120).nullish(),
  organizerEmail: z.string().email().nullish(),
  postMeetingJourneyId: z.string().max(64).nullish(),
  noShowJourneyId: z.string().max(64).nullish(),
  cancellationJourneyId: z.string().max(64).nullish(),
  prepBriefHoursBefore: z.number().int().min(0).max(72).optional(),
});

meetingsRouter.get("/settings", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ settings: await getOrCreateMeetingSettings(db, workspaceId) });
});

meetingsRouter.put("/settings", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = settingsSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const settings = await updateMeetingSettings(db, workspaceId, parsed.data);
  return c.json({ settings });
});

/** Ensures a calendar feed token exists and returns the public URL. */
meetingsRouter.post("/calendar-token", async (c) => {
  const { workspaceId } = c.get("auth");
  const token = await ensureCalendarToken(db, workspaceId);
  return c.json({ token, feedPath: `/v1/calendar/${token}.ics` });
});

/* ---- Meeting hosts (round-robin pool) -------------------------------- */

const hostSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  userId: z.string().nullish(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

meetingsRouter.get("/hosts", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ hosts: await listMeetingHosts(db, workspaceId) });
});

meetingsRouter.post("/hosts", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = hostSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const host = await createMeetingHost(db, workspaceId, parsed.data);
  if (!host) return c.json({ error: "email_taken" }, 409);
  return c.json({ host }, 201);
});

meetingsRouter.patch("/hosts/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = hostSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const host = await updateMeetingHost(db, workspaceId, c.req.param("id"), parsed.data);
  if (!host) return c.json({ error: "not_found" }, 404);
  return c.json({ host });
});

meetingsRouter.delete("/hosts/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const ok = await deleteMeetingHost(db, workspaceId, c.req.param("id"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

meetingsRouter.get("/email-vars", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ variables: await meetingEmailVariables(db, workspaceId) });
});

const typeSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/),
  description: z.string().max(500).nullish(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  bookingUrl: z.string().url().nullish(),
  ctaLabel: z.string().min(1).max(80).optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

meetingsRouter.get("/types", async (c) => {
  const { workspaceId } = c.get("auth");
  await ensureDefaultMeetingType(db, workspaceId);
  return c.json({ types: await listMeetingTypes(db, workspaceId) });
});

meetingsRouter.post("/types", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = typeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    const type = await createMeetingType(db, workspaceId, parsed.data);
    return c.json({ type }, 201);
  } catch {
    return c.json({ error: "slug_taken" }, 409);
  }
});

meetingsRouter.patch("/types/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = typeSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const type = await updateMeetingType(db, workspaceId, c.req.param("id"), parsed.data);
  if (!type) return c.json({ error: "not_found" }, 404);
  return c.json({ type });
});

meetingsRouter.delete("/types/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const ok = await deleteMeetingType(db, workspaceId, c.req.param("id"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

meetingsRouter.get("/slots", async (c) => {
  const { workspaceId } = c.get("auth");
  const meetingTypeId = c.req.query("meetingTypeId") || undefined;
  const days = Number(c.req.query("days") ?? 14);
  const contactId = c.req.query("contactId") || undefined;
  const guestTimezone = c.req.query("timezone") || undefined;
  const smart = c.req.query("smart") === "1" || c.req.query("smart") === "true";
  const slots = await listMeetingSlots(db, workspaceId, {
    meetingTypeId,
    to: new Date(Date.now() + days * 24 * 3600_000),
  });
  if (!smart) return c.json({ slots });

  // Smart ranking: guest tz fit, host load, historical show-rate, urgency.
  let urgency = 0;
  if (contactId) {
    const [row] = await db
      .select({ properties: contactTable.properties })
      .from(contactTable)
      .where(eq(contactTable.id, contactId))
      .limit(1);
    const tier = row?.properties?.leadTier;
    urgency = tier === "hot" ? 0.9 : tier === "warm" ? 0.5 : 0.15;
  }
  const ranked = await rankMeetingSlots(db, workspaceId, slots, {
    contactId,
    guestTimezone,
    urgency,
  });
  return c.json({ slots: ranked, smart: true });
});

/** Meeting prep brief for the host — computed on demand, never stored. */
meetingsRouter.get("/:id/brief", async (c) => {
  const { workspaceId } = c.get("auth");
  const brief = await buildMeetingPrepBrief(db, workspaceId, c.req.param("id"));
  if (!brief) return c.json({ error: "not_found" }, 404);
  return c.json({ brief });
});

const bookSchema = z.object({
  contactId: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().max(80).optional(),
  meetingTypeId: z.string().optional(),
  startsAt: z.string(),
  notes: z.string().max(500).optional(),
  source: z.enum(["booking_page", "email_cta", "contact_360", "api", "external"]).optional(),
  timezone: z.string().max(64).optional(),
});

async function finalizeBooking(
  workspaceId: string,
  input: z.infer<typeof bookSchema>,
  source: "booking_page" | "email_cta" | "contact_360" | "api" | "external",
) {
  const result = await bookMeeting(db, workspaceId, {
    contactId: input.contactId ?? null,
    email: input.email,
    name: input.name,
    meetingTypeId: input.meetingTypeId ?? null,
    startsAt: input.startsAt,
    notes: input.notes ?? null,
    source: input.source ?? source,
    timezone: input.timezone,
  });

  if (result.contactId) {
    const [contact] = await db
      .select()
      .from(contactTable)
      .where(eq(contactTable.id, result.contactId))
      .limit(1);

    await recordContactEvent(db, {
      workspaceId,
      contactId: result.contactId,
      name: "meeting.booked",
      properties: {
        meetingId: result.meeting.id,
        startsAt: result.meeting.startsAt,
        endsAt: result.meeting.endsAt,
        source: result.meeting.source,
      },
    });

    // Close any open "book a meeting" tasks now that it's scheduled.
    const open = await openTasksForContact(db, workspaceId, result.contactId);
    for (const t of open.filter((t) => t.kind === "meeting" && t.sourceId !== result.meeting.id)) {
      await completeTask(db, workspaceId, t.id, "done");
    }

    const intelligence = await runIntelligenceHook(db, {
      workspaceId,
      contactId: result.contactId,
      email: contact?.email ?? input.email ?? result.contactId,
      signal: {
        kind: "event",
        eventName: "meeting.booked",
        eventProperties: {
          meetingId: result.meeting.id,
          source: result.meeting.source,
        },
      },
    }).catch(() => null);

    return {
      meeting: result.meeting,
      contactId: result.contactId,
      reminderTaskId: result.reminderTaskId,
      leadScore: intelligence?.leadScore,
      leadTier: intelligence?.leadTier,
    };
  }

  return {
    meeting: result.meeting,
    contactId: null,
    reminderTaskId: null,
  };
}

/** Fire-and-forget booking confirmation + host notice (never fails the booking). */
function fireBookingNotifications(
  workspaceId: string,
  meeting: Parameters<typeof sendBookingNotifications>[0],
) {
  const engine = getEngine();
  if (!engine?.emailProvider) return;
  void sendBookingNotifications(meeting, {
    provider: engine.emailProvider,
    defaultFrom: process.env.DEFAULT_FROM_EMAIL ?? "noreply@loopkit.dev",
  }).catch((error) => {
    console.error(
      `[loopkit] booking notifications failed for ${meeting.id}:`,
      error instanceof Error ? error.message : error,
    );
  });
  void workspaceId;
}

meetingsRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = bookSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    const result = await finalizeBooking(workspaceId, parsed.data, "api");
    fireBookingNotifications(workspaceId, result.meeting);
    return c.json(result, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "booking_failed";
    if (msg === "slot_unavailable") return c.json({ error: "slot_unavailable" }, 409);
    return c.json({ error: msg }, 400);
  }
});

/** Back-compat alias used by the previous Meetings panel / integrations. */
meetingsRouter.post("/booked", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = bookSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    const result = await finalizeBooking(workspaceId, parsed.data, "external");
    fireBookingNotifications(workspaceId, result.meeting);
    return c.json(
      {
        eventId: result.meeting.id,
        meeting: result.meeting,
        leadScore: result.leadScore,
        leadTier: result.leadTier,
      },
      201,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "booking_failed";
    return c.json({ error: msg }, 400);
  }
});

meetingsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const status = c.req.query("status") as
    | "scheduled"
    | "held"
    | "cancelled"
    | "no_show"
    | undefined;
  const contactId = c.req.query("contactId");
  const upcoming = c.req.query("upcoming") === "1" || c.req.query("upcoming") === "true";
  const meetings = await listMeetings(db, workspaceId, {
    status,
    contactId: contactId || undefined,
    upcoming,
    limit: Number(c.req.query("limit") ?? 100),
  });
  return c.json({ meetings });
});

meetingsRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const meeting = await getMeeting(db, workspaceId, c.req.param("id"));
  if (!meeting) return c.json({ error: "not_found" }, 404);
  return c.json({ meeting });
});

meetingsRouter.post("/:id/status", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z
    .object({
      status: z.enum(["scheduled", "held", "cancelled", "no_show"]),
      outcome: z.string().max(1000).nullish(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const meeting = await updateMeetingStatus(
    db,
    workspaceId,
    c.req.param("id"),
    parsed.data.status,
    parsed.data.outcome ?? null,
  );
  if (!meeting) return c.json({ error: "not_found" }, 404);

  // Intelligence loop: score + plays + follow-up tasks + journey enrollments.
  let intel = null;
  if (parsed.data.status !== "scheduled") {
    try {
      intel = await applyMeetingOutcome(
        db,
        workspaceId,
        meeting.id,
        parsed.data.status,
        parsed.data.outcome ?? null,
      );
      if (intel?.journeyStarts.length) {
        const engine = getEngine();
        if (engine) {
          await applyPlayJourneyStarts(
            db,
            engine.ctx.engine,
            intel.journeyStarts.map((s) => ({
              playId: "meeting-outcome",
              journeyId: s.journeyId,
              contactId: s.contactId,
            })),
          );
        }
      }
    } catch (error) {
      console.error(
        `[loopkit] meeting outcome intelligence failed for ${meeting.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return c.json({
    meeting,
    intelligence: intel
      ? {
          leadScore: intel.leadScore,
          leadTier: intel.leadTier,
          tasksCreated: intel.tasksCreated,
          journeyStarts: intel.journeyStarts.map((s) => s.journeyId),
          playsFired: intel.plays.fired.map((f) => f.playName),
          outcomeScoreDelta: intel.outcomeScoreDelta,
        }
      : null,
  });
});

/* ------------------------------------------------------------------ */
/* Public booking surface                                              */
/* ------------------------------------------------------------------ */

export const meetingsPublicRouter = new Hono();

/** Public booking page payload: types + settings + slots. */
meetingsPublicRouter.get("/book/:slug", async (c) => {
  const slug = c.req.param("slug");
  // Find workspace by bookingSlug (or fall back to type slug match on default ws).
  const { meetingSettings: meetingSettingsTable } = await import("@loopkit/db/schema");
  const { eq: eqOp } = await import("drizzle-orm");

  let workspaceId: string | null = null;
  const [bySlug] = await db
    .select({ workspaceId: meetingSettingsTable.workspaceId })
    .from(meetingSettingsTable)
    .where(eqOp(meetingSettingsTable.bookingSlug, slug))
    .limit(1);
  workspaceId = bySlug?.workspaceId ?? null;

  if (!workspaceId) {
    // Also allow type slug lookup across workspaces with a public booking page.
    const { meetingType: meetingTypeTable } = await import("@loopkit/db/schema");
    const [byType] = await db
      .select({ workspaceId: meetingTypeTable.workspaceId })
      .from(meetingTypeTable)
      .where(eqOp(meetingTypeTable.slug, slug))
      .limit(1);
    workspaceId = byType?.workspaceId ?? null;
  }

  if (!workspaceId) return c.json({ error: "not_found" }, 404);

  const settings = await getOrCreateMeetingSettings(db, workspaceId);
  await ensureDefaultMeetingType(db, workspaceId);
  const types = (await listMeetingTypes(db, workspaceId)).filter((t) => t.active);
  const slots = await listMeetingSlots(db, workspaceId, {
    to: new Date(Date.now() + (settings?.leadDays ?? 14) * 24 * 3600_000),
  });

  return c.json({
    workspaceId,
    settings: {
      meetingTitle: settings?.meetingTitle,
      meetingDescription: settings?.meetingDescription,
      ctaLabel: settings?.ctaLabel,
      timezone: settings?.timezone,
      durationMinutes: settings?.durationMinutes,
      bookingUrl: settings?.bookingUrl,
    },
    types: types.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      durationMinutes: t.durationMinutes,
      ctaLabel: t.ctaLabel,
      isDefault: t.isDefault,
      bookingUrl: t.bookingUrl,
    })),
    slots,
  });
});

const publicBookSchema = z.object({
  slug: z.string().min(1).max(40),
  meetingTypeId: z.string().optional(),
  email: z.string().email(),
  name: z.string().max(80).optional(),
  startsAt: z.string(),
  notes: z.string().max(500).optional(),
  timezone: z.string().max(64).optional(),
});

meetingsPublicRouter.post("/book", async (c) => {
  const parsed = publicBookSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

  const { meetingSettings: meetingSettingsTable, meetingType: meetingTypeTable } =
    await import("@loopkit/db/schema");
  const { eq: eqOp } = await import("drizzle-orm");

  let workspaceId: string | null = null;
  const [bySlug] = await db
    .select({ workspaceId: meetingSettingsTable.workspaceId })
    .from(meetingSettingsTable)
    .where(eqOp(meetingSettingsTable.bookingSlug, parsed.data.slug))
    .limit(1);
  workspaceId = bySlug?.workspaceId ?? null;
  if (!workspaceId) {
    const [byType] = await db
      .select({ workspaceId: meetingTypeTable.workspaceId })
      .from(meetingTypeTable)
      .where(eqOp(meetingTypeTable.slug, parsed.data.slug))
      .limit(1);
    workspaceId = byType?.workspaceId ?? null;
  }
  if (!workspaceId) return c.json({ error: "not_found" }, 404);

  try {
    const result = await bookMeeting(db, workspaceId, {
      email: parsed.data.email,
      name: parsed.data.name,
      meetingTypeId: parsed.data.meetingTypeId ?? null,
      startsAt: parsed.data.startsAt,
      notes: parsed.data.notes ?? null,
      source: "booking_page",
      timezone: parsed.data.timezone,
    });

    if (result.contactId) {
      await recordContactEvent(db, {
        workspaceId,
        contactId: result.contactId,
        name: "meeting.booked",
        properties: {
          meetingId: result.meeting.id,
          startsAt: result.meeting.startsAt,
          source: "booking_page",
        },
      });
    }

    fireBookingNotifications(workspaceId, result.meeting);

    return c.json(
      {
        ok: true,
        meeting: {
          id: result.meeting.id,
          title: result.meeting.title,
          startsAt: result.meeting.startsAt,
          endsAt: result.meeting.endsAt,
          timezone: result.meeting.timezone,
          hostName: result.meeting.hostName,
          hostEmail: result.meeting.hostEmail,
        },
      },
      201,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "booking_failed";
    if (msg === "slot_unavailable") return c.json({ error: "slot_unavailable" }, 409);
    return c.json({ error: msg }, 400);
  }
});

/* ------------------------------------------------------------------ */
/* Public ICS calendar feeds                                           */
/* ------------------------------------------------------------------ */

const ICS_HEADERS = {
  "Content-Type": "text/calendar; charset=utf-8",
  "Cache-Control": "private, max-age=300",
} as const;

/** Subscribed calendar feed: GET /v1/calendar/:token.ics */
meetingsPublicRouter.get("/calendar/:token", async (c) => {
  const token = c.req.param("token").replace(/\.ics$/i, "");
  const workspaceId = await workspaceIdForCalendarToken(token);
  if (!workspaceId) return c.json({ error: "not_found" }, 404);

  const body = await buildWorkspaceCalendarFeed(workspaceId);
  return c.body(body, 200, ICS_HEADERS);
});

/** Single-meeting .ics download: GET /v1/meetings/public/:id.ics */
meetingsPublicRouter.get("/meetings/public/:id", async (c) => {
  const id = c.req.param("id").replace(/\.ics$/i, "");
  const meeting = await getMeetingByPublicId(db, id);
  if (!meeting) return c.json({ error: "not_found" }, 404);

  const body = await buildMeetingIcsFile(meeting.workspaceId, meeting);
  const filename = `${meeting.title.replace(/[^\w-]+/g, "-").slice(0, 40) || "meeting"}.ics`;
  return c.body(body, 200, {
    ...ICS_HEADERS,
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
});

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export const tasksRouter = new Hono<AppEnv>();
tasksRouter.use(sessionAuth());

tasksRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const status = c.req.query("status") as "open" | "done" | "dismissed" | undefined;
  const contactId = c.req.query("contactId");
  const [tasks, stats] = await Promise.all([
    listTasks(db, workspaceId, {
      status: status || "open",
      contactId: contactId || undefined,
      limit: Number(c.req.query("limit") ?? 100),
    }),
    taskStats(db, workspaceId),
  ]);
  return c.json({ tasks, stats });
});

const createTaskSchema = z.object({
  contactId: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().max(1000).nullish(),
  kind: z.enum(["call", "email", "meeting", "review", "custom"]).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  dueAt: z.string().nullish(),
  source: z.string().max(60).optional(),
  sourceId: z.string().max(120).nullish(),
});

tasksRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = createTaskSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const task = await createTask(db, workspaceId, {
    ...parsed.data,
    dueAt: parsed.data.dueAt ?? null,
    sourceId: parsed.data.sourceId ?? null,
    body: parsed.data.body ?? null,
  });
  if (!task) return c.json({ error: "create_failed" }, 500);
  return c.json({ task }, 201);
});

tasksRouter.post("/:id/complete", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z
    .object({ status: z.enum(["done", "dismissed"]).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  const status = parsed.success ? (parsed.data.status ?? "done") : "done";
  const task = await completeTask(db, workspaceId, c.req.param("id"), status);
  if (!task) return c.json({ error: "not_found" }, 404);
  return c.json({ task });
});

/* ------------------------------------------------------------------ */
/* Companies                                                           */
/* ------------------------------------------------------------------ */

export const companiesRouter = new Hono<AppEnv>();
companiesRouter.use(sessionAuth());

companiesRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({
    companies: await listCompanies(db, workspaceId, Number(c.req.query("limit") ?? 100)),
  });
});

companiesRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const company = await getCompany(db, workspaceId, c.req.param("id"));
  if (!company) return c.json({ error: "not_found" }, 404);
  const contacts = await listCompanyContacts(db, workspaceId, company.id);
  return c.json({ company, contacts });
});

companiesRouter.post("/:id/recompute", async (c) => {
  const { workspaceId } = c.get("auth");
  const company = await recomputeCompanyRollups(db, workspaceId, c.req.param("id"));
  if (!company) return c.json({ error: "not_found" }, 404);
  return c.json({ company });
});

/** Manually attach a contact to a company by domain. */
companiesRouter.post("/sync-contact", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z
    .object({ contactId: z.string().min(1), name: z.string().max(120).optional() })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const [contact] = await db
    .select()
    .from(contactTable)
    .where(eq(contactTable.id, parsed.data.contactId))
    .limit(1);
  if (!contact) return c.json({ error: "not_found" }, 404);
  const company = await syncContactCompany(
    db,
    workspaceId,
    contact.id,
    contact.email,
    parsed.data.name,
  );
  if (!company) return c.json({ company: null, note: "free-mail or invalid domain" });
  const rolled = await recomputeCompanyRollups(db, workspaceId, company.id);
  return c.json({ company: rolled ?? company });
});
