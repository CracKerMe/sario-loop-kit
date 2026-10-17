import { startJourneyRun, type PlayEvaluationResult } from "@loopkit/core";
import type { Db } from "@loopkit/db";
import type { WorkflowEngine } from "ts-workflow-engine-lite";

/**
 * Starts journeys requested by play `start_journey` actions. Requires the
 * engine handle from the route context; no-ops when the engine is offline.
 */
export async function applyPlayJourneyStarts(
  db: Db,
  engine: WorkflowEngine | undefined,
  starts: PlayEvaluationResult["journeyStarts"],
): Promise<number> {
  if (!engine || starts.length === 0) return 0;

  const { journey: journeyTable } = await import("@loopkit/db/schema");
  const { eq } = await import("drizzle-orm");

  let started = 0;
  for (const start of starts) {
    const [j] = await db
      .select()
      .from(journeyTable)
      .where(eq(journeyTable.id, start.journeyId))
      .limit(1);
    if (!j || j.status !== "published" || j.publishedVersion == null) continue;
    try {
      await startJourneyRun(
        db,
        engine,
        {
          workspaceId: j.workspaceId,
          journeyId: j.id,
          contactId: start.contactId,
          workflowId: j.workflowId,
          journeyVersion: j.publishedVersion,
          context: {},
        },
        j.reentry,
      );
      started += 1;
    } catch {
      // Play-driven starts are best-effort; a single failure should not
      // reject the originating contact/event request.
    }
  }
  return started;
}
