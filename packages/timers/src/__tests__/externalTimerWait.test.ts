/**
 * Phase 3 gate. Proves the durable-delay path end to end against a real
 * bootstrap()'d engine, not just the poller in isolation:
 *
 *  1. a `wait` node with `externalTimer.enabled: true` produces a `timer`
 *     row with the correct trigger_at (not an in-process setTimeout);
 *  2. killing the engine process mid-wait and "restarting" it (a fresh
 *     bootstrap against the same storage) still completes the instance —
 *     at the original deadline, not a newly-computed one — and does NOT
 *     produce a second timer row (the #1 silent-failure risk flagged in
 *     the plan: timerKey embeds the deadline, so a re-derived deadline on
 *     resume would silently mint a duplicate);
 *  3. the orchestrator's externalTimer branch was actually taken, proven
 *     by spying on adapter.schedule() — not the engine's in-process
 *     setTimeout fallback, which would produce no timer row at all and
 *     evaporate on restart with no error.
 *
 * Timeouts here are deliberately generous (60s on waitForCompletion,
 * 90s per test). The assertions are about durability semantics, not
 * latency, and the poller's own wait is only 2s — but this file shares
 * one Postgres with every other package's tests, so under `pnpm -r test`
 * (all packages' vitest workers running concurrently) the poller's next
 * query can be starved for many seconds. A 10s inner timeout failed
 * intermittently for exactly that reason while passing reliably in
 * isolation.
 */
import { and, eq, isNull } from "drizzle-orm";
import { timer } from "@loopkit/db/schema";
import { DrizzleStorageProvider } from "@loopkit/engine-storage";
import {
  bootstrap,
  destroyContainer,
  setExternalTimerAdapter,
  type AppContext,
  type WorkflowDefinition,
} from "ts-workflow-engine-lite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PgTimerAdapter } from "../PgTimerAdapter";
import { TimerPoller } from "../TimerPoller";
import { resetTables, testDb } from "./testDb";

const db = testDb();

const WORKFLOW: WorkflowDefinition = {
  id: "durable-drip",
  name: "durable drip",
  startNode: "welcome",
  nodes: {
    welcome: {
      id: "welcome",
      type: "action",
      action: async () => ({ sent: "welcome" }),
      next: ["delay"],
    },
    delay: {
      id: "delay",
      type: "wait",
      config: { durationMs: 2000, externalTimer: { enabled: true } },
      next: ["followUp"],
    },
    followUp: {
      id: "followUp",
      type: "action",
      action: async () => ({ sent: "followUp" }),
      next: [],
    },
  },
};

async function bootstrapWithPoller(): Promise<{
  ctx: AppContext;
  poller: TimerPoller;
  adapter: PgTimerAdapter;
}> {
  const storage = new DrizzleStorageProvider(db);
  const adapter = new PgTimerAdapter(db);
  const ctx = await bootstrap({
    storage,
    externalTimerAdapter: adapter,
    skipValidation: true,
    skipGracefulShutdown: true,
    resumeRunningInstances: false,
  });
  const poller = new TimerPoller(db, ctx.container.eventBus, ctx.container.storage, {
    pollIntervalMs: 200,
  });
  return { ctx, poller, adapter };
}

describe("durable external-timer wait: restart-across-deadline", () => {
  beforeEach(async () => {
    await resetTables(db);
  });

  afterEach(() => {
    setExternalTimerAdapter(null);
  });

  it("produces a timer row (not setTimeout) with the correct trigger_at", async () => {
    const { ctx, poller, adapter } = await bootstrapWithPoller();
    const scheduleSpy = vi.spyOn(adapter, "schedule");

    try {
      await ctx.engine.register(WORKFLOW);
      const before = Date.now();
      const instanceId = await ctx.engine.start("durable-drip", {});

      // Give the orchestrator a moment to run the welcome action and enter
      // the wait node — it's async but should settle almost immediately.
      await new Promise((r) => setTimeout(r, 200));

      // The orchestrator branch was taken — not the in-process setTimeout
      // fallback (ExecutionOrchestrator.ts:507's `eventCoordinator &&
      // externalTimer.enabled` guard). If this spy was never called, the
      // wait silently fell through to setTimeout with no timer row and no
      // error — exactly the plan's #1 flagged risk.
      expect(scheduleSpy).toHaveBeenCalledTimes(1);

      const rows = await db.select().from(timer).where(eq(timer.instanceId, instanceId));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe("pending");
      expect(row.triggerAt.getTime()).toBeGreaterThanOrEqual(before + 2000 - 50);
      expect(row.triggerAt.getTime()).toBeLessThan(before + 2000 + 2000);

      poller.start();
      const instance = await ctx.engine.waitForCompletion(instanceId, { timeoutMs: 60_000 });
      expect(instance.status).toBe("completed");
    } finally {
      poller.stop();
      ctx.engine.destroy();
      await destroyContainer(ctx.container);
    }
  }, 90_000);

  it("survives a full process restart mid-wait, completing at the original deadline with no duplicate timer row", async () => {
    // --- "process 1": start the instance, let it enter the wait, then
    // tear the whole engine down (no poller ever runs — nothing fires).
    const first = await bootstrapWithPoller();
    let instanceId: string;
    let originalTriggerAt: Date;
    try {
      await first.ctx.engine.register(WORKFLOW);
      instanceId = await first.ctx.engine.start("durable-drip", {});
      await new Promise((r) => setTimeout(r, 200));

      const [row] = await db.select().from(timer).where(eq(timer.instanceId, instanceId));
      expect(row).toBeDefined();
      originalTriggerAt = row!.triggerAt;
    } finally {
      // Simulates the process dying: destroy the container without ever
      // starting the poller, so the wait node's deadline has not fired.
      first.ctx.engine.destroy();
      await destroyContainer(first.ctx.container);
    }

    // --- "process 2": fresh bootstrap against the SAME storage, resuming
    // the still-running instance. Re-registering the workflow definition
    // is required (function-valued nodes aren't persisted) before
    // resumeRunningInstancesFromStorage — see the engine's restart
    // checklist.
    const second = await bootstrapWithPoller();
    const scheduleSpy = vi.spyOn(second.adapter, "schedule");
    try {
      await second.ctx.engine.register(WORKFLOW);
      await second.ctx.engine.resumeRunningInstancesFromStorage();

      // Re-entering the wait node on resume must NOT schedule a second
      // timer: shouldSchedule is false because the persisted
      // externalTimer.timerKey already matches (deadline is read back
      // from instance.state, not recomputed). If the deadline were
      // recomputed instead, timerKey would differ and this would fire.
      await new Promise((r) => setTimeout(r, 200));
      expect(scheduleSpy).not.toHaveBeenCalled();

      const rows = await db.select().from(timer).where(eq(timer.instanceId, instanceId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.triggerAt.getTime()).toBe(originalTriggerAt.getTime());

      second.poller.start();
      const instance = await second.ctx.engine.waitForCompletion(instanceId, { timeoutMs: 60_000 });
      expect(instance.status).toBe("completed");

      // waitForCompletion() returns the moment InstanceManager's in-memory
      // status flips to terminal, which can be a beat ahead of the last
      // node's output being visible on that exact snapshot (the same
      // in-memory-vs-storage gap observed during Phase 2 verification).
      // Read the persisted instance directly instead of trusting the
      // returned reference's state tree.
      const persisted = await second.ctx.container.storage.loadInstance(instanceId);
      expect(persisted?.state?.nodes?.followUp?.output).toMatchObject({ sent: "followUp" });

      // Still exactly one timer row for this instance, now fired.
      const finalRows = await db.select().from(timer).where(eq(timer.instanceId, instanceId));
      expect(finalRows).toHaveLength(1);
      expect(finalRows[0]!.status).toBe("fired");
    } finally {
      second.poller.stop();
      second.ctx.engine.destroy();
      await destroyContainer(second.ctx.container);
    }
  }, 90_000);

  it("cancelling a pending timer stops it from ever emitting", async () => {
    const { ctx, poller, adapter } = await bootstrapWithPoller();
    try {
      await ctx.engine.register(WORKFLOW);
      const instanceId = await ctx.engine.start("durable-drip", {});
      await new Promise((r) => setTimeout(r, 200));

      const [row] = await db.select().from(timer).where(eq(timer.instanceId, instanceId));
      await adapter.cancel(row!.timerKey);

      poller.start();
      await new Promise((r) => setTimeout(r, 500));

      const [after] = await db
        .select()
        .from(timer)
        .where(and(eq(timer.instanceId, instanceId), isNull(timer.firedAt)));
      expect(after?.status).toBe("cancelled");
    } finally {
      poller.stop();
      ctx.engine.destroy();
      await destroyContainer(ctx.container);
    }
  }, 20_000);
});
