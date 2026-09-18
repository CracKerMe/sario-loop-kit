import type { Db } from "@loopkit/db";
import { journeyRun } from "@loopkit/db/schema";
import { DrizzleStorageProvider } from "@loopkit/engine-storage";
import { eq } from "drizzle-orm";
import type { EventWaitingState, WorkflowInstance } from "ts-workflow-engine-lite";

import type { EventWaitIndex } from "./eventWaitIndex";

const TERMINAL_ENGINE_STATUSES = new Set(["completed", "failed", "cancelled", "exited"]);

function mapRunStatus(engineStatus: string): "completed" | "failed" | "cancelled" | "exited" {
  if (engineStatus === "completed") return "completed";
  if (engineStatus === "failed") return "failed";
  if (engineStatus === "cancelled") return "cancelled";
  return "exited";
}

/**
 * DrizzleStorageProvider that keeps product-side indexes in sync with the
 * engine:
 * 1. EventWaitIndex — so POST /v1/events can wake waiters without a full scan
 * 2. journey_run.status — engine terminal states must release the
 *    once_at_a_time partial unique index and stop looking "running" to
 *    wake filters. Extending (rather than wrapping) avoids re-delegating
 *    ~30 StorageProvider methods.
 */
export class EventIndexedStorageProvider extends DrizzleStorageProvider {
  // Parent stores `db` as a TS-private constructor property; the child
  // cannot read `this.db`, so keep its own reference for run-status sync.
  constructor(
    private readonly loopkitDb: Db,
    private readonly index: EventWaitIndex,
  ) {
    super(loopkitDb);
  }

  override saveEventWaitingState(state: EventWaitingState): Promise<void> {
    this.index.add(state);
    return super.saveEventWaitingState(state);
  }

  override deleteEventWaitingState(instanceId: string, nodeId: string): Promise<void> {
    this.index.remove(instanceId, nodeId);
    return super.deleteEventWaitingState(instanceId, nodeId);
  }

  override async saveInstance(instance: WorkflowInstance): Promise<void> {
    await super.saveInstance(instance);
    await this.#syncJourneyRun(instance);
  }

  override async casUpdateInstance(instance: WorkflowInstance): Promise<boolean> {
    const ok = await super.casUpdateInstance(instance);
    if (ok) await this.#syncJourneyRun(instance);
    return ok;
  }

  async #syncJourneyRun(instance: WorkflowInstance): Promise<void> {
    if (!TERMINAL_ENGINE_STATUSES.has(instance.status)) return;
    await this.loopkitDb
      .update(journeyRun)
      .set({
        status: mapRunStatus(instance.status),
        exitedAt: new Date(),
      })
      .where(eq(journeyRun.instanceId, instance.instanceId));
  }
}
