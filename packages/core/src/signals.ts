import { and, desc, eq } from "drizzle-orm";

import type { Db } from "@loopkit/db";
import {
  contact as contactTable,
  contactEvent as contactEventTable,
  signalSettings as signalSettingsTable,
} from "@loopkit/db/schema";

import { recordContactEvent } from "./contacts";
import { createTask, syncContactCompany } from "./gtm";
import { recomputeLeadScore } from "./leadScoring";
import { evaluatePlays, type PlayEvaluationResult } from "./plays";

export type PageViewInput = {
  /** Prefer email when known; anonymousId maps to a synthesized contact. */
  email?: string;
  anonymousId?: string;
  userId?: string;
  path: string;
  title?: string;
  referrer?: string;
  /** Arbitrary extra properties stored on the page.viewed event. */
  properties?: Record<string, unknown>;
};

function randomKey(): string {
  return `sig_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export async function getOrCreateSignalSettings(db: Db, workspaceId: string) {
  const [existing] = await db
    .select()
    .from(signalSettingsTable)
    .where(eq(signalSettingsTable.workspaceId, workspaceId))
    .limit(1);
  if (existing) return existing;

  const [row] = await db
    .insert(signalSettingsTable)
    .values({
      workspaceId,
      trackingKey: randomKey(),
      highIntentPaths: ["/pricing", "/demo", "/checkout", "/upgrade"],
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;

  const [again] = await db
    .select()
    .from(signalSettingsTable)
    .where(eq(signalSettingsTable.workspaceId, workspaceId))
    .limit(1);
  return again;
}

export async function updateSignalSettings(
  db: Db,
  workspaceId: string,
  input: {
    highIntentPaths?: string[];
    intentWebhookUrl?: string | null;
  },
) {
  await getOrCreateSignalSettings(db, workspaceId);
  const [row] = await db
    .update(signalSettingsTable)
    .set({
      ...(input.highIntentPaths !== undefined ? { highIntentPaths: input.highIntentPaths } : {}),
      ...(input.intentWebhookUrl !== undefined ? { intentWebhookUrl: input.intentWebhookUrl } : {}),
    })
    .where(eq(signalSettingsTable.workspaceId, workspaceId))
    .returning();
  return row;
}

export async function listRecentPageViews(db: Db, workspaceId: string, limit = 50) {
  return db
    .select({
      id: contactEventTable.id,
      contactId: contactEventTable.contactId,
      email: contactTable.email,
      path: contactEventTable.properties,
      occurredAt: contactEventTable.occurredAt,
    })
    .from(contactEventTable)
    .innerJoin(contactTable, eq(contactTable.id, contactEventTable.contactId))
    .where(
      and(
        eq(contactEventTable.workspaceId, workspaceId),
        eq(contactEventTable.name, "page.viewed"),
      ),
    )
    .orderBy(desc(contactEventTable.occurredAt))
    .limit(limit);
}

export type IntelligenceHookResult = {
  leadScore?: number;
  leadTier?: "hot" | "warm" | "cold";
  plays: PlayEvaluationResult;
};

/**
 * Post-write intelligence hook: recompute lead score, then evaluate plays
 * against the originating signal. Called after contact upserts and events.
 */
export async function runIntelligenceHook(
  db: Db,
  input: {
    workspaceId: string;
    contactId: string;
    email: string;
    /** What happened, for play matching. */
    signal:
      | { kind: "contact_created" }
      | {
          kind: "event";
          eventName: string;
          eventProperties: Record<string, unknown>;
        }
      | { kind: "score_changed"; previousScore: number; leadScore: number };
  },
): Promise<IntelligenceHookResult> {
  const scored = await recomputeLeadScore(db, input.workspaceId, input.contactId);
  const leadScore = scored?.score;
  const leadTier = scored?.tier;

  const [contact] = await db
    .select()
    .from(contactTable)
    .where(eq(contactTable.id, input.contactId))
    .limit(1);
  const properties = contact?.properties ?? {};

  // Keep company rollup linked on every intelligence pass.
  if (contact?.email) {
    await syncContactCompany(db, input.workspaceId, input.contactId, contact.email).catch(
      () => null,
    );
  }

  // Auto-queue a follow-up when a lead becomes hot (score >= 50).
  if (leadTier === "hot") {
    await createTask(db, input.workspaceId, {
      contactId: input.contactId,
      title: `Follow up with hot lead ${input.email}`,
      body: `Lead score reached ${leadScore ?? 0}. Review intent and reach out.`,
      kind: "call",
      priority: 10,
      source: "score",
      sourceId: "hot",
      dueAt: new Date(Date.now() + 24 * 3600_000),
    }).catch(() => null);
  }

  // Auto-queue a review task on high-intent website visits.
  if (input.signal.kind === "event" && input.signal.eventName === "page.viewed") {
    const path = String(input.signal.eventProperties?.path ?? "");
    const highIntent = /pricing|demo|checkout|upgrade|contact/i.test(path);
    if (highIntent) {
      await createTask(db, input.workspaceId, {
        contactId: input.contactId,
        title: `High-intent visit: ${path}`,
        body: `${input.email} visited ${path}. Consider a personal outreach.`,
        kind: "email",
        priority: 5,
        source: "intent",
        sourceId: path.split("?")[0] || path,
        dueAt: new Date(Date.now() + 4 * 3600_000),
      }).catch(() => null);
    }
  }

  let playSignal;
  if (input.signal.kind === "contact_created") {
    playSignal = {
      kind: "contact_created" as const,
      contactId: input.contactId,
      email: input.email,
      properties,
    };
  } else if (input.signal.kind === "event") {
    playSignal = {
      kind: "event" as const,
      contactId: input.contactId,
      email: input.email,
      eventName: input.signal.eventName,
      eventProperties: input.signal.eventProperties,
      properties,
      leadScore,
    };
  } else {
    playSignal = {
      kind: "score_changed" as const,
      contactId: input.contactId,
      email: input.email,
      leadScore: input.signal.leadScore,
      previousScore: input.signal.previousScore,
      properties,
    };
  }

  // Also fire score_threshold plays when the score crossed a boundary this hook.
  const plays = await evaluatePlays(db, input.workspaceId, playSignal);

  if (
    input.signal.kind === "event" &&
    leadScore != null &&
    typeof properties.leadScore === "number" &&
    properties.leadScore !== leadScore
  ) {
    // Score moved as a result of this event — evaluate threshold crossings too.
    const cross = await evaluatePlays(db, input.workspaceId, {
      kind: "score_changed",
      contactId: input.contactId,
      email: input.email,
      leadScore,
      previousScore: Number(properties.leadScore),
      properties,
    });
    plays.fired.push(...cross.fired);
    plays.journeyStarts.push(...cross.journeyStarts);
  }

  return { leadScore, leadTier, plays };
}

/**
 * Ingest a website page view as a first-class `page.viewed` event, then run
 * the intelligence hook. Anonymous visitors are keyed by `anonymousId` in
 * contact.userId so repeat visits collapse onto one contact.
 */
export async function ingestPageView(
  db: Db,
  workspaceId: string,
  input: PageViewInput,
): Promise<{
  contactId: string;
  eventId: string | null;
  intelligence: IntelligenceHookResult;
}> {
  const email =
    input.email?.trim().toLowerCase() ||
    (input.anonymousId ? `${input.anonymousId}@anon.local` : "");
  if (!email) {
    throw new Error("email or anonymousId is required");
  }

  const properties = {
    path: input.path,
    ...(input.title ? { title: input.title } : {}),
    ...(input.referrer ? { referrer: input.referrer } : {}),
    ...input.properties,
  };

  // Ensure the contact exists (anonymous → synthesized email).
  const [existing] = await db
    .select()
    .from(contactTable)
    .where(and(eq(contactTable.workspaceId, workspaceId), eq(contactTable.email, email)))
    .limit(1);

  let contactId = existing?.id;
  if (!contactId) {
    const [created] = await db
      .insert(contactTable)
      .values({
        id: crypto.randomUUID(),
        workspaceId,
        email,
        userId: input.userId ?? input.anonymousId ?? null,
        properties: input.anonymousId && !input.email ? { anonymousId: input.anonymousId } : {},
        subscribed: true,
      })
      .returning();
    contactId = created!.id;
    const intelligence = await runIntelligenceHook(db, {
      workspaceId,
      contactId,
      email,
      signal: { kind: "contact_created" },
    });
    // Fall through to record the page view on this new contact.
    const recorded = await recordContactEvent(db, {
      workspaceId,
      contactId,
      name: "page.viewed",
      properties,
    });
    const after = await runIntelligenceHook(db, {
      workspaceId,
      contactId,
      email,
      signal: { kind: "event", eventName: "page.viewed", eventProperties: properties },
    });
    return {
      contactId,
      eventId: recorded?.id ?? null,
      intelligence: {
        leadScore: after.leadScore ?? intelligence.leadScore,
        leadTier: after.leadTier ?? intelligence.leadTier,
        plays: {
          fired: [...intelligence.plays.fired, ...after.plays.fired],
          journeyStarts: [...intelligence.plays.journeyStarts, ...after.plays.journeyStarts],
        },
      },
    };
  }

  const recorded = await recordContactEvent(db, {
    workspaceId,
    contactId,
    name: "page.viewed",
    properties,
  });

  const intelligence = await runIntelligenceHook(db, {
    workspaceId,
    contactId,
    email,
    signal: { kind: "event", eventName: "page.viewed", eventProperties: properties },
  });

  // High-intent webhook (settings.intentWebhookUrl) — best effort.
  const settings = await getOrCreateSignalSettings(db, workspaceId);
  const isHighIntent = (settings?.highIntentPaths ?? []).some((p) =>
    input.path.toLowerCase().includes(String(p).toLowerCase()),
  );
  if (isHighIntent && settings?.intentWebhookUrl) {
    try {
      await fetch(settings.intentWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `High-intent visit: ${email} → ${input.path}`,
          contactId,
          email,
          path: input.path,
        }),
      });
    } catch {
      // best-effort
    }
  }

  return { contactId, eventId: recorded?.id ?? null, intelligence };
}
