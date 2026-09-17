import type { Db } from "@loopkit/db";
import { timer } from "@loopkit/db/schema";
import { and, eq } from "drizzle-orm";
import type { ExternalTimerAdapter, ExternalTimerScheduleRequest } from "ts-workflow-engine-lite";

/**
 * Postgres-backed ExternalTimerAdapter: makes multi-day `wait` nodes
 * durable across restarts instead of relying on the engine's in-process
 * setTimeout, which evaporates when the process exits mid-wait.
 *
 * schedule() is called by the engine's orchestrator only when
 * `shouldSchedule` is true (the persisted timerKey/eventType on the
 * instance doesn't already match) — see ExecutionOrchestrator.ts. The
 * timerKey itself (`wait:{instanceId}:{nodeId}:{deadline}`) is already
 * engine-side idempotent, so ON CONFLICT DO NOTHING here is a second,
 * cheap layer of the same guarantee, not a workaround for a gap.
 */
export class PgTimerAdapter implements ExternalTimerAdapter {
  readonly name = "loopkit-pg";

  constructor(private readonly db: Db) {}

  async schedule(request: ExternalTimerScheduleRequest): Promise<void> {
    await this.db
      .insert(timer)
      .values({
        timerKey: request.timerKey,
        instanceId: request.instanceId,
        nodeId: request.nodeId,
        workflowId: request.workflowId,
        eventType: request.eventType,
        triggerAt: new Date(request.triggerAt),
        payload: request.payload,
        status: "pending",
      })
      .onConflictDoNothing({ target: timer.timerKey });
  }

  async cancel(timerKey: string): Promise<void> {
    await this.db
      .update(timer)
      .set({ status: "cancelled" })
      .where(and(eq(timer.timerKey, timerKey), eq(timer.status, "pending")));
  }
}
