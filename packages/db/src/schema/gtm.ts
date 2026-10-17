import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { contact } from "./contacts";
import { workspace } from "./workspace";

/**
 * Workspace meeting / booking configuration.
 * Supports both an external booking URL (Cal.com / Calendly) AND a built-in
 * scheduler (availability windows + slot booking) so self-hosted installs
 * don't need a third-party scheduler.
 */
export const meetingSettings = pgTable("meeting_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  /** Optional external booking URL (Cal.com / Calendly). */
  bookingUrl: text("booking_url"),
  meetingTitle: text("meeting_title").notNull().default("Book a meeting"),
  meetingDescription: text("meeting_description"),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  /** Optional CTA label used by the email variable `{{meeting.cta}}`. */
  ctaLabel: text("cta_label").notNull().default("Book a meeting"),
  /** Built-in scheduler: IANA timezone for slot generation. */
  timezone: text("timezone").notNull().default("UTC"),
  /** 0=Sunday … 6=Saturday. Empty = no built-in availability. */
  availableWeekdays: jsonb("available_weekdays")
    .$type<number[]>()
    .notNull()
    .default([1, 2, 3, 4, 5]),
  /** Minutes from midnight, local to `timezone`. */
  dayStartMinute: integer("day_start_minute")
    .notNull()
    .default(9 * 60),
  dayEndMinute: integer("day_end_minute")
    .notNull()
    .default(17 * 60),
  /** Buffer between slots (minutes). */
  bufferMinutes: integer("buffer_minutes").notNull().default(0),
  /** How many days ahead slots are offered. */
  leadDays: integer("lead_days").notNull().default(14),
  /** Public slug for the hosted booking page: /book/:slug */
  bookingSlug: text("booking_slug"),
  /** Secret token for the ICS calendar feed: /v1/calendar/:token.ics */
  calendarToken: text("calendar_token"),
  /** Hours-before-start at which reminder emails fire (e.g. [24, 2]). */
  reminderHoursBefore: jsonb("reminder_hours_before").$type<number[]>().notNull().default([24, 2]),
  /** Send a booking confirmation email (with .ics) right after a booking. */
  sendBookingConfirmation: boolean("send_booking_confirmation").notNull().default(true),
  /** Send pre-meeting reminder emails at the configured offsets. */
  sendReminders: boolean("send_reminders").notNull().default(true),
  /**
   * Host assignment: round_robin rotates active hosts, fixed always uses
   * `fixedHostEmail`, none leaves the meeting unassigned.
   */
  assignmentMode: text("assignment_mode")
    .$type<"round_robin" | "fixed" | "none">()
    .notNull()
    .default("round_robin"),
  /** Used when assignmentMode = "fixed". */
  fixedHostEmail: text("fixed_host_email"),
  /** ORGANIZER identity written into generated .ics files. */
  organizerName: text("organizer_name"),
  organizerEmail: text("organizer_email"),
  /** Auto-enroll the contact when a meeting ends successfully. */
  postMeetingJourneyId: text("post_meeting_journey_id"),
  /** Auto-enroll on no-show recovery. */
  noShowJourneyId: text("no_show_journey_id"),
  /** Auto-enroll when a meeting is cancelled before it happens. */
  cancellationJourneyId: text("cancellation_journey_id"),
  /** Hours before start to email the host a prep brief (0 = off). */
  prepBriefHoursBefore: integer("prep_brief_hours_before").notNull().default(2),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Named meeting types (Intro call, Demo, QBR…). One default per workspace. */
export const meetingType = pgTable(
  "meeting_type",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    /** External booking URL override; falls back to workspace settings. */
    bookingUrl: text("booking_url"),
    ctaLabel: text("cta_label").notNull().default("Book a meeting"),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("meeting_type_ws_slug_uidx").on(t.workspaceId, t.slug),
    index("meeting_type_ws_idx").on(t.workspaceId, t.active, t.sortOrder),
  ],
);

/**
 * Scheduled / completed meetings. Created by the built-in scheduler, the
 * public booking form, external booking webhooks, or manually from Contact 360.
 */
export const meeting = pgTable(
  "meeting",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contact.id, { onDelete: "set null" }),
    meetingTypeId: text("meeting_type_id").references(() => meetingType.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    /** Guest identity when contact is unknown at booking time. */
    guestEmail: text("guest_email"),
    guestName: text("guest_name"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    /**
     * scheduled | held | cancelled | no_show
     */
    status: text("status")
      .$type<"scheduled" | "held" | "cancelled" | "no_show">()
      .notNull()
      .default("scheduled"),
    /** booking_page | email_cta | contact_360 | api | external */
    source: text("source").notNull().default("api"),
    notes: text("notes"),
    /** Meeting outcome notes recorded after the call. */
    outcome: text("outcome"),
    /** External calendar event id if synced later. */
    externalId: text("external_id"),
    /** True when a reminder task was already created. */
    reminderSent: boolean("reminder_sent").notNull().default(false),
    /** Assigned host (round-robin / fixed). Denormalized for fast ICS + lists. */
    hostUserId: text("host_user_id"),
    hostName: text("host_name"),
    hostEmail: text("host_email"),
    /** Hour-offsets of reminder emails already sent for this meeting. */
    remindersSent: jsonb("reminders_sent").$type<number[]>().notNull().default([]),
    /** Set once the host prep brief has been emailed (poller idempotency). */
    prepBriefSentAt: timestamp("prep_brief_sent_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("meeting_ws_starts_idx").on(t.workspaceId, t.startsAt.desc()),
    index("meeting_contact_idx").on(t.contactId, t.startsAt.desc()),
    index("meeting_status_idx").on(t.workspaceId, t.status, t.startsAt),
  ],
);

/**
 * Sales / success follow-up queue. Tasks are created by plays, hot-lead
 * crossings, high-intent visits, journey goals, or manually from Contact 360.
 */
export const task = pgTable(
  "task",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    /**
     * call | email | meeting | review | custom
     */
    kind: text("kind")
      .$type<"call" | "email" | "meeting" | "review" | "custom">()
      .notNull()
      .default("review"),
    /**
     * open | done | dismissed
     */
    status: text("status").$type<"open" | "done" | "dismissed">().notNull().default("open"),
    priority: integer("priority").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** Where the task came from: play / score / intent / goal / manual */
    source: text("source").notNull().default("manual"),
    sourceId: text("source_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("task_ws_status_idx").on(t.workspaceId, t.status, t.priority),
    index("task_contact_idx").on(t.contactId, t.status),
    // One open task of the same source for a contact — prevents task spam.
    uniqueIndex("task_open_source_uidx")
      .on(t.workspaceId, t.contactId, t.source, t.sourceId)
      .where(sql`${t.status} = 'open'`),
  ],
);

/**
 * Meeting hosts used for round-robin assignment. A host may be a workspace
 * member (userId set) or an external person (name/email only).
 */
export const meetingHost = pgTable(
  "meeting_host",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** Set when the host is a workspace member. */
    userId: text("user_id"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Updated on each assignment so round-robin picks the least-recently-used host. */
    lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("meeting_host_ws_email_uidx").on(t.workspaceId, t.email),
    index("meeting_host_ws_active_idx").on(t.workspaceId, t.active, t.lastAssignedAt),
  ],
);

/**
 * Account / company rollup. Contacts link via email domain (derived) or an
 * explicit `companyId` property. Apollo-style Book of Business foundation.
 */
export const company = pgTable(
  "company",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** Primary domain, e.g. acme.com — unique per workspace. */
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    /** Cached rollups recomputed on contact changes. */
    contactCount: integer("contact_count").notNull().default(0),
    hotLeadCount: integer("hot_lead_count").notNull().default(0),
    totalLeadScore: integer("total_lead_score").notNull().default(0),
    totalLtvCents: integer("total_ltv_cents").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("company_ws_domain_uidx").on(t.workspaceId, t.domain),
    index("company_ws_idx").on(t.workspaceId, t.lastActivityAt.desc()),
  ],
);

export const meetingSettingsRelations = relations(meetingSettings, ({ one }) => ({
  workspace: one(workspace, {
    fields: [meetingSettings.workspaceId],
    references: [workspace.id],
  }),
}));

export const meetingTypeRelations = relations(meetingType, ({ one }) => ({
  workspace: one(workspace, {
    fields: [meetingType.workspaceId],
    references: [workspace.id],
  }),
}));

export const meetingHostRelations = relations(meetingHost, ({ one }) => ({
  workspace: one(workspace, {
    fields: [meetingHost.workspaceId],
    references: [workspace.id],
  }),
}));

export const meetingRelations = relations(meeting, ({ one }) => ({
  workspace: one(workspace, {
    fields: [meeting.workspaceId],
    references: [workspace.id],
  }),
  contact: one(contact, {
    fields: [meeting.contactId],
    references: [contact.id],
  }),
  meetingType: one(meetingType, {
    fields: [meeting.meetingTypeId],
    references: [meetingType.id],
  }),
}));

export const taskRelations = relations(task, ({ one }) => ({
  workspace: one(workspace, {
    fields: [task.workspaceId],
    references: [workspace.id],
  }),
  contact: one(contact, {
    fields: [task.contactId],
    references: [contact.id],
  }),
}));

export const companyRelations = relations(company, ({ one }) => ({
  workspace: one(workspace, {
    fields: [company.workspaceId],
    references: [workspace.id],
  }),
}));

export const gtmTables = [
  meetingSettings,
  meetingType,
  meetingHost,
  meeting,
  task,
  company,
] as const;

/** Derive a company domain from an email address. Returns null for free mail. */
export function domainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!domain.includes(".")) return null;
  const FREE = new Set([
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.co.jp",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "qq.com",
    "163.com",
    "126.com",
    "sina.com",
    "foxmail.com",
  ]);
  if (FREE.has(domain)) return null;
  return domain;
}

/** Humanize a domain into a company name: acme.com → Acme. */
export function companyNameFromDomain(domain: string): string {
  const head = domain.split(".")[0] ?? domain;
  return head
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function isBusinessEmail(email: string): boolean {
  return domainFromEmail(email) != null;
}
