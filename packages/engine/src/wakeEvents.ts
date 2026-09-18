import type { Db } from "@loopkit/db";
import { journeyRun } from "@loopkit/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { EventBus } from "ts-workflow-engine-lite";

import type { EventWaitIndex } from "./eventWaitIndex";

export const LOOPKIT_EVENT_PREFIX = "loopkit.event.";

export interface WakeEventInput {
  /** Contact-event name without the loopkit.event. prefix, e.g. order.placed */
  eventName: string;
  contactId: string;
  properties?: Record<string, unknown>;
}

/**
 * Wakes engine instances that are sitting on a waitEvent node for this
 * contact's event. requireInstanceIdMatch is hardcoded true for event
 * nodes, so we emit once per waiting instance with that instanceId in the
 * payload — a single broadcast without instanceId would be a silent no-op.
 *
 * Cross-checks the wait index against journey_run rows for this contact:
 * waking an unrelated instance that happens to wait on the same event type
 * would deliver the wrong contact's event data into that journey.
 */
export async function wakeWaitingInstancesForContactEvent(
  db: Db,
  eventBus: EventBus,
  index: EventWaitIndex,
  input: WakeEventInput,
): Promise<number> {
  const eventType = `${LOOPKIT_EVENT_PREFIX}${input.eventName}`;
  const candidates = index.instancesWaitingFor(eventType);
  if (candidates.length === 0) return 0;

  const runs = await db
    .select({ instanceId: journeyRun.instanceId })
    .from(journeyRun)
    .where(and(eq(journeyRun.contactId, input.contactId), eq(journeyRun.status, "running")));
  if (runs.length === 0) return 0;

  const contactInstances = new Set(runs.map((r) => r.instanceId));
  const targets = candidates.filter((id) => contactInstances.has(id));
  if (targets.length === 0) return 0;

  // Confirm the contact still has these as running journey runs that are
  // also present in the wait index (already filtered). Emit per instance.
  for (const instanceId of targets) {
    eventBus.emit(eventType, {
      ...input.properties,
      instanceId,
      eventName: input.eventName,
      contactId: input.contactId,
    });
  }
  return targets.length;
}

/** Loads contact for a set of instanceIds via journey_run (debug helper). */
export async function contactIdsForInstances(
  db: Db,
  instanceIds: string[],
): Promise<Map<string, string>> {
  if (instanceIds.length === 0) return new Map();
  const rows = await db
    .select({ instanceId: journeyRun.instanceId, contactId: journeyRun.contactId })
    .from(journeyRun)
    .where(inArray(journeyRun.instanceId, instanceIds));
  return new Map(rows.map((r) => [r.instanceId, r.contactId]));
}
