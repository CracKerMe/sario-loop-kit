import type { Db } from "@loopkit/db";
import { journeyRun } from "@loopkit/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
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
 *
 * SubJourney children (P2.4) run as their OWN engine instances linked via
 * wf_instance.parent_instance_id — they have no journey_run row of their
 * own, so the journey_run set below misses them. The recursive CTE in
 * descendantInstanceIds() pulls the descendant tree of the contact's run
 * instances (depth is bounded by the engine's MAX_SUBWORKFLOW_DEPTH of 10;
 * the LIMIT guards against pathological graphs). A child's context carries
 * the same contactId (mapped in by compile()), so a child waiting on
 * "order.placed" is exactly as entitled to the wake as its parent.
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

  const runInstanceIds = runs.map((r) => r.instanceId);
  const contactInstances = new Set(runInstanceIds);
  for (const descendantId of await descendantInstanceIds(db, runInstanceIds)) {
    contactInstances.add(descendantId);
  }
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

/**
 * All engine sub-workflow instances descending from the given run instances
 * (one parent_instance_id hop per subJourney nesting level, recursive).
 * Raw db.execute() returns snake_case column names — read .instance_id.
 */
async function descendantInstanceIds(db: Db, roots: string[]): Promise<string[]> {
  if (roots.length === 0) return [];
  const rootList = sql.join(
    roots.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute<{ instance_id: string }>(sql`
    WITH RECURSIVE tree AS (
      SELECT i.instance_id
      FROM wf_instance i
      WHERE i.parent_instance_id IN (${rootList})
      UNION ALL
      SELECT c.instance_id
      FROM wf_instance c
      JOIN tree t ON c.parent_instance_id = t.instance_id
    )
    SELECT instance_id FROM tree LIMIT 1000
  `);
  return result.rows.map((r) => r.instance_id);
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
