import { and, eq, sql } from "drizzle-orm";

import type { Db } from "@loopkit/db";
import {
  contact as contactTable,
  play as playTable,
  playContactState as playContactStateTable,
} from "@loopkit/db/schema";

export type PlayTrigger =
  | { kind: "contact_created" }
  | { kind: "event"; name: string; pathContains?: string }
  | { kind: "score_threshold"; min: number; max?: number };

export type PlayAction =
  | { type: "set_property"; key: string; value: unknown }
  | { type: "add_tag"; tag: string }
  | { type: "notify"; url: string; message?: string }
  | { type: "start_journey"; journeyId: string };

export type PlayInput = {
  name: string;
  active?: boolean;
  trigger: PlayTrigger;
  conditions?: unknown;
  actions: PlayAction[];
};

export type PlayRow = typeof playTable.$inferSelect;

/** Minimum gap between re-firing one play for one contact (ms). */
const REFIRE_COOLDOWN_MS = 60 * 60 * 1000;

export async function listPlays(db: Db, workspaceId: string) {
  return db
    .select()
    .from(playTable)
    .where(eq(playTable.workspaceId, workspaceId))
    .orderBy(playTable.createdAt);
}

export async function getPlay(db: Db, workspaceId: string, playId: string) {
  const [row] = await db
    .select()
    .from(playTable)
    .where(and(eq(playTable.workspaceId, workspaceId), eq(playTable.id, playId)))
    .limit(1);
  return row ?? null;
}

export async function createPlay(db: Db, workspaceId: string, input: PlayInput) {
  const [row] = await db
    .insert(playTable)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      name: input.name,
      active: input.active ?? true,
      trigger: input.trigger as Record<string, unknown>,
      conditions: input.conditions ?? null,
      actions: input.actions,
    })
    .returning();
  return row;
}

export async function updatePlay(
  db: Db,
  workspaceId: string,
  playId: string,
  input: Partial<PlayInput>,
) {
  const [row] = await db
    .update(playTable)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger as Record<string, unknown> } : {}),
      ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
      ...(input.actions !== undefined ? { actions: input.actions } : {}),
    })
    .where(and(eq(playTable.workspaceId, workspaceId), eq(playTable.id, playId)))
    .returning();
  return row;
}

export async function deletePlay(db: Db, workspaceId: string, playId: string): Promise<boolean> {
  const rows = await db
    .delete(playTable)
    .where(and(eq(playTable.workspaceId, workspaceId), eq(playTable.id, playId)))
    .returning({ id: playTable.id });
  return rows.length > 0;
}

export type PlaySignal =
  | {
      kind: "contact_created";
      contactId: string;
      email: string;
      properties: Record<string, unknown>;
    }
  | {
      kind: "event";
      contactId: string;
      email: string;
      eventName: string;
      eventProperties: Record<string, unknown>;
      properties: Record<string, unknown>;
      leadScore?: number;
    }
  | {
      kind: "score_changed";
      contactId: string;
      email: string;
      leadScore: number;
      previousScore: number;
      properties: Record<string, unknown>;
    };

function triggerMatches(trigger: PlayTrigger, signal: PlaySignal): boolean {
  if (trigger.kind === "contact_created") return signal.kind === "contact_created";
  if (trigger.kind === "event") {
    if (signal.kind !== "event") return false;
    if (trigger.name !== signal.eventName) return false;
    if (trigger.pathContains) {
      const path = String(signal.eventProperties?.path ?? "");
      if (!path.toLowerCase().includes(trigger.pathContains.toLowerCase())) return false;
    }
    return true;
  }
  if (trigger.kind === "score_threshold") {
    if (signal.kind === "score_changed") {
      const crossed = signal.previousScore < trigger.min && signal.leadScore >= trigger.min;
      const inBand = trigger.max == null || signal.leadScore <= trigger.max;
      return crossed && inBand;
    }
    if (signal.kind === "event" && signal.leadScore != null) {
      const inBand = trigger.max == null || signal.leadScore <= trigger.max;
      return signal.leadScore >= trigger.min && inBand;
    }
  }
  return false;
}

async function shouldFire(db: Db, playId: string, contactId: string): Promise<boolean> {
  const [state] = await db
    .select()
    .from(playContactStateTable)
    .where(
      and(eq(playContactStateTable.playId, playId), eq(playContactStateTable.contactId, contactId)),
    )
    .limit(1);
  if (!state) return true;
  return Date.now() - state.lastFiredAt.getTime() > REFIRE_COOLDOWN_MS;
}

async function markFired(db: Db, playId: string, contactId: string) {
  await db
    .insert(playContactStateTable)
    .values({ playId, contactId, lastFiredAt: new Date(), fireCount: 1 })
    .onConflictDoUpdate({
      target: [playContactStateTable.playId, playContactStateTable.contactId],
      set: {
        lastFiredAt: new Date(),
        fireCount: sql`${playContactStateTable.fireCount} + 1`,
      },
    });
  await db
    .update(playTable)
    .set({
      runCount: sql`${playTable.runCount} + 1`,
      lastRunAt: new Date(),
    })
    .where(eq(playTable.id, playId));
}

async function applyAction(db: Db, action: PlayAction, signal: PlaySignal): Promise<void> {
  const contactId = signal.contactId;

  if (action.type === "set_property") {
    const [row] = await db
      .select({ properties: contactTable.properties })
      .from(contactTable)
      .where(eq(contactTable.id, contactId))
      .limit(1);
    await db
      .update(contactTable)
      .set({
        properties: {
          ...row?.properties,
          [action.key]: action.value,
        },
      })
      .where(eq(contactTable.id, contactId));
    return;
  }

  if (action.type === "add_tag") {
    const [row] = await db
      .select({ properties: contactTable.properties })
      .from(contactTable)
      .where(eq(contactTable.id, contactId))
      .limit(1);
    const existing = Array.isArray(row?.properties?.tags)
      ? [...(row.properties.tags as string[])]
      : [];
    if (!existing.includes(action.tag)) existing.push(action.tag);
    await db
      .update(contactTable)
      .set({ properties: { ...row?.properties, tags: existing } })
      .where(eq(contactTable.id, contactId));
    return;
  }

  if (action.type === "notify") {
    const message =
      action.message ?? `Loopkit play fired for ${signal.email || contactId} (${signal.kind})`;
    // Best-effort team notify; never block scoring/play evaluation on network.
    try {
      await fetch(action.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: message,
          contactId,
          email: signal.email,
          signal:
            signal.kind === "event"
              ? { name: signal.eventName, properties: signal.eventProperties }
              : { kind: signal.kind },
        }),
      });
    } catch {
      // intentionally swallowed — notify is fire-and-forget
    }
    return;
  }

  if (action.type === "start_journey") {
    // Soft-reference: callers that hold the engine should start journeys
    // themselves after evaluatePlays returns the requested starts.
    return;
  }
}

export type PlayEvaluationResult = {
  fired: Array<{ playId: string; playName: string; actions: PlayAction[] }>;
  journeyStarts: Array<{ playId: string; journeyId: string; contactId: string }>;
};

/**
 * Evaluates active plays against a signal and applies their actions.
 * `start_journey` actions are collected (not executed) so the route can
 * start engine runs with its WorkflowEngine handle.
 */
export async function evaluatePlays(
  db: Db,
  workspaceId: string,
  signal: PlaySignal,
): Promise<PlayEvaluationResult> {
  const result: PlayEvaluationResult = { fired: [], journeyStarts: [] };

  const plays = await db
    .select()
    .from(playTable)
    .where(and(eq(playTable.workspaceId, workspaceId), eq(playTable.active, true)));

  for (const play of plays) {
    const trigger = play.trigger as unknown as PlayTrigger;
    if (!trigger || !triggerMatches(trigger, signal)) continue;
    if (!(await shouldFire(db, play.id, signal.contactId))) continue;

    const actions = (play.actions as PlayAction[]) ?? [];
    for (const action of actions) {
      if (action.type === "start_journey") {
        result.journeyStarts.push({
          playId: play.id,
          journeyId: action.journeyId,
          contactId: signal.contactId,
        });
        continue;
      }
      await applyAction(db, action, signal);
    }

    await markFired(db, play.id, signal.contactId);
    result.fired.push({
      playId: play.id,
      playName: play.name,
      actions,
    });
  }

  return result;
}

export { REFIRE_COOLDOWN_MS };
