/**
 * Send-time optimization (STO) — the half of "when to send" that a fixed
 * schedule cannot do.
 *
 * Marketing platforms call this Intelligent Timing / STO. The idea is
 * simple and the value is not: contacts who habitually open mail at 21:00
 * should not receive a campaign at 09:00 just because that is when the
 * operator clicked Launch.
 *
 * Profiles are derived from real engagement (email_delivery opens/clicks
 * joined back to the send), never invented. Clicks weigh more than opens
 * because Apple Mail Privacy Protection inflates opens and does not click.
 * Contacts with thin history fall back to the workspace profile, which in
 * turn falls back to a quiet default (10:00 local) rather than 00:00.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import type { Db } from "@loopkit/db";
import {
  emailDelivery as emailDeliveryTable,
  emailSend as emailSendTable,
} from "@loopkit/db/schema";

/** Engagement weight: a click is worth more than an open. */
const OPEN_WEIGHT = 1;
const CLICK_WEIGHT = 3;

/** Minimum weighted samples before we trust a contact-level profile. */
export const MIN_PROFILE_SAMPLES = 5;

export interface EngagementProfile {
  /** 24 buckets, 0–23. Weighted engagement mass per hour. */
  hours: number[];
  samples: number;
  /** Hour with the highest mass, 0–23. */
  bestHour: number;
  /** Mass at bestHour / total mass. */
  confidence: number;
  source: "contact" | "workspace" | "default";
}

const DEFAULT_HOUR = 10;

function emptyHours(): number[] {
  return Array.from({ length: 24 }, () => 0);
}

function finalizeProfile(
  hours: number[],
  samples: number,
  source: EngagementProfile["source"],
): EngagementProfile {
  const total = hours.reduce((a, b) => a + b, 0);
  let bestHour = DEFAULT_HOUR;
  let bestMass = -1;
  for (let h = 0; h < 24; h++) {
    if (hours[h]! > bestMass) {
      bestMass = hours[h]!;
      bestHour = h;
    }
  }
  if (total <= 0) {
    hours = emptyHours();
    hours[DEFAULT_HOUR] = 1;
    bestHour = DEFAULT_HOUR;
    return {
      hours,
      samples,
      bestHour,
      confidence: 0,
      source: source === "default" ? "default" : source,
    };
  }
  return {
    hours,
    samples,
    bestHour,
    confidence: bestMass / total,
    source,
  };
}

/**
 * Workspace-wide engagement-hour histogram. This is the cold-start
 * fallback and also what the dashboard shows as "when your audience is
 * awake".
 */
export async function getWorkspaceEngagementProfile(
  db: Db,
  workspaceId: string,
  options: { sinceDays?: number } = {},
): Promise<EngagementProfile> {
  const sinceDays = options.sinceDays ?? 90;
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  // Hours are UTC. The timeWindow node already treats hours as server-local;
  // pinning STO to UTC keeps the profile stable across operator timezones
  // and makes the math testable. A per-contact timezone is a later upgrade.
  const hourExpr = sql<number>`extract(hour from ${emailDeliveryTable.occurredAt} at time zone 'UTC')::int`;
  const rows = await db
    .select({
      hour: hourExpr,
      type: emailDeliveryTable.type,
      n: sql<number>`count(*)::int`,
    })
    .from(emailDeliveryTable)
    .innerJoin(emailSendTable, eq(emailDeliveryTable.sendId, emailSendTable.id))
    .where(
      and(
        eq(emailSendTable.workspaceId, workspaceId),
        gte(emailDeliveryTable.occurredAt, since),
        sql`${emailDeliveryTable.type} in ('opened','clicked')`,
      ),
    )
    .groupBy(hourExpr, emailDeliveryTable.type);

  const hours = emptyHours();
  let samples = 0;
  for (const row of rows) {
    const weight = row.type === "clicked" ? CLICK_WEIGHT : OPEN_WEIGHT;
    const hour = ((row.hour % 24) + 24) % 24;
    hours[hour] = (hours[hour] ?? 0) + weight * row.n;
    samples += row.n;
  }
  return finalizeProfile(hours, samples, samples > 0 ? "workspace" : "default");
}

/**
 * Per-contact engagement profile. Falls back to the workspace profile
 * when the contact has not engaged enough to form an opinion.
 */
export async function getContactEngagementProfile(
  db: Db,
  workspaceId: string,
  contactId: string,
  options: { sinceDays?: number } = {},
): Promise<EngagementProfile> {
  const sinceDays = options.sinceDays ?? 180;
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const hourExpr = sql<number>`extract(hour from ${emailDeliveryTable.occurredAt} at time zone 'UTC')::int`;
  const rows = await db
    .select({
      hour: hourExpr,
      type: emailDeliveryTable.type,
      n: sql<number>`count(*)::int`,
    })
    .from(emailDeliveryTable)
    .innerJoin(emailSendTable, eq(emailDeliveryTable.sendId, emailSendTable.id))
    .where(
      and(
        eq(emailSendTable.workspaceId, workspaceId),
        eq(emailSendTable.contactId, contactId),
        gte(emailDeliveryTable.occurredAt, since),
        sql`${emailDeliveryTable.type} in ('opened','clicked')`,
      ),
    )
    .groupBy(hourExpr, emailDeliveryTable.type);

  const hours = emptyHours();
  let samples = 0;
  for (const row of rows) {
    const weight = row.type === "clicked" ? CLICK_WEIGHT : OPEN_WEIGHT;
    const hour = ((row.hour % 24) + 24) % 24;
    hours[hour] = (hours[hour] ?? 0) + weight * row.n;
    samples += row.n;
  }

  if (samples < MIN_PROFILE_SAMPLES) {
    return getWorkspaceEngagementProfile(db, workspaceId, options);
  }
  return finalizeProfile(hours, samples, "contact");
}

/**
 * Softmax-ish pick over the hour histogram with a mild exploration floor,
 * so a profile that has only ever seen 21:00 can still discover 08:00.
 * Deterministic when `seed` is provided (same seed → same hour) so
 * tests and materialization stay reproducible.
 */
export function pickBestHour(profile: EngagementProfile, seed?: number): number {
  const temps = profile.hours.map((mass) => Math.max(mass, 0) + 0.05);
  const total = temps.reduce((a, b) => a + b, 0);
  if (total <= 0) return profile.bestHour;

  // Deterministic weighted pick.
  const r =
    seed === undefined
      ? Math.random()
      : ((Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  let acc = 0;
  for (let h = 0; h < 24; h++) {
    acc += temps[h]! / total;
    if (r <= acc) return h;
  }
  return profile.bestHour;
}

/**
 * Next Date at which the UTC hour matches `hour`, strictly after `after`.
 * Profiles are bucketed in UTC (see getWorkspaceEngagementProfile), so
 * scheduling must use the same clock or the "best hour" would drift.
 */
export function nextHourOccurrence(after: Date, hour: number): Date {
  const target = ((Math.trunc(hour) % 24) + 24) % 24;
  const out = new Date(after.getTime());
  out.setUTCHours(target, after.getUTCMinutes(), after.getUTCSeconds(), after.getUTCMilliseconds());
  if (out.getTime() <= after.getTime()) {
    out.setUTCDate(out.getUTCDate() + 1);
  }
  return out;
}

/**
 * The Date at which a contact should next receive a send. Used by campaign
 * materialization (`campaign_recipient.sendAt`) and by the journey delay
 * node's `bestTime` mode.
 *
 * `maxDelayMs` caps how far into the future we will push a send — a
 * 22:00 best hour must not park a time-sensitive receipt until tomorrow
 * night if the operator asked for "within 4 hours".
 */
export function nextBestSendTime(
  profile: EngagementProfile,
  options: { from?: Date; maxDelayMs?: number; seed?: number } = {},
): Date {
  const from = options.from ?? new Date();
  const maxDelayMs = options.maxDelayMs;
  const hour = pickBestHour(profile, options.seed);
  const at = nextHourOccurrence(from, hour);
  if (maxDelayMs !== undefined && at.getTime() - from.getTime() > maxDelayMs) {
    return new Date(from.getTime() + maxDelayMs);
  }
  return at;
}

/**
 * Batch helper for campaign materialization: one workspace profile query,
 * then a cheap per-contact override only for contacts that have history.
 */
export async function planCampaignSendTimes(
  db: Db,
  workspaceId: string,
  contactIds: string[],
  options: { from?: Date; maxDelayMs?: number } = {},
): Promise<Map<string, Date>> {
  const from = options.from ?? new Date();
  const workspaceProfile = await getWorkspaceEngagementProfile(db, workspaceId);
  const out = new Map<string, Date>();

  // Query contact-level hits in one pass when the list is small enough;
  // otherwise fall through per contact (materialization chunks at 500).
  if (contactIds.length > 0) {
    const since = new Date(Date.now() - 180 * 86_400_000);
    const chunks: string[][] = [];
    for (let i = 0; i < contactIds.length; i += 500) chunks.push(contactIds.slice(i, i + 500));
    const perContactHours = new Map<string, number[]>();
    const perContactSamples = new Map<string, number>();

    for (const chunk of chunks) {
      const rows = await db
        .select({
          contactId: emailSendTable.contactId,
          hour: sql<number>`extract(hour from ${emailDeliveryTable.occurredAt} at time zone 'UTC')::int`,
          type: emailDeliveryTable.type,
          n: sql<number>`count(*)::int`,
        })
        .from(emailDeliveryTable)
        .innerJoin(emailSendTable, eq(emailDeliveryTable.sendId, emailSendTable.id))
        .where(
          and(
            eq(emailSendTable.workspaceId, workspaceId),
            sql`${emailSendTable.contactId} in ${chunk}`,
            gte(emailDeliveryTable.occurredAt, since),
            sql`${emailDeliveryTable.type} in ('opened','clicked')`,
          ),
        )
        .groupBy(
          emailSendTable.contactId,
          sql<number>`extract(hour from ${emailDeliveryTable.occurredAt} at time zone 'UTC')::int`,
          emailDeliveryTable.type,
        );

      for (const row of rows) {
        const hours = perContactHours.get(row.contactId) ?? emptyHours();
        const weight = row.type === "clicked" ? CLICK_WEIGHT : OPEN_WEIGHT;
        const hour = ((row.hour % 24) + 24) % 24;
        hours[hour] = (hours[hour] ?? 0) + weight * row.n;
        perContactHours.set(row.contactId, hours);
        perContactSamples.set(row.contactId, (perContactSamples.get(row.contactId) ?? 0) + row.n);
      }
    }

    for (const contactId of contactIds) {
      const samples = perContactSamples.get(contactId) ?? 0;
      const hours = perContactHours.get(contactId);
      const profile =
        samples >= MIN_PROFILE_SAMPLES && hours
          ? finalizeProfile(hours, samples, "contact")
          : workspaceProfile;
      out.set(
        contactId,
        nextBestSendTime(profile, {
          from,
          maxDelayMs: options.maxDelayMs,
          seed: hashSeed(contactId),
        }),
      );
    }
  }

  return out;
}

/** Stable seed so one contact's STO slot does not shuffle between retries. */
export function hashSeed(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
