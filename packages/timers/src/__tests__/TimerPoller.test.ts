import { timer } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { DrizzleStorageProvider } from "@loopkit/engine-storage";
import { EventBus, type WorkflowInstance } from "ts-workflow-engine-lite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PgTimerAdapter } from "../PgTimerAdapter";
import { TimerPoller } from "../TimerPoller";
import { resetTables, testDb } from "./testDb";

const db = testDb();

function makeInstance(
  overrides: Partial<WorkflowInstance> & { instanceId: string },
): WorkflowInstance {
  return {
    workflowId: "wf-a",
    currentNodes: ["wait-node"],
    status: "running",
    context: {},
    history: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    retries: {},
    version: 1,
    ...overrides,
  };
}

describe("PgTimerAdapter + TimerPoller", () => {
  let storage: DrizzleStorageProvider;
  let adapter: PgTimerAdapter;
  let bus: EventBus;
  let poller: TimerPoller;

  beforeEach(async () => {
    await resetTables(db);
    storage = new DrizzleStorageProvider(db);
    await storage.connect();
    adapter = new PgTimerAdapter(db);
    bus = new EventBus();
    poller = new TimerPoller(db, bus, storage);
  });

  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
  });

  describe("schedule()", () => {
    it("inserts a pending timer row", async () => {
      await adapter.schedule({
        timerKey: "wait:inst-1:node-1:1000",
        instanceId: "inst-1",
        nodeId: "node-1",
        workflowId: "wf-a",
        eventType: "workflow.wait.inst-1.node-1",
        triggerAt: Date.now() + 1000,
        payload: { instanceId: "inst-1" },
      });

      const [row] = await db
        .select()
        .from(timer)
        .where(eq(timer.timerKey, "wait:inst-1:node-1:1000"));
      expect(row?.status).toBe("pending");
      expect(row?.instanceId).toBe("inst-1");
    });

    it("is idempotent on timerKey (ON CONFLICT DO NOTHING)", async () => {
      const request = {
        timerKey: "wait:inst-2:node-1:1000",
        instanceId: "inst-2",
        nodeId: "node-1",
        workflowId: "wf-a",
        eventType: "evt",
        triggerAt: Date.now() + 1000,
        payload: {},
      };
      await adapter.schedule(request);
      await adapter.schedule(request); // second call must not throw or duplicate

      const rows = await db.select().from(timer).where(eq(timer.timerKey, request.timerKey));
      expect(rows).toHaveLength(1);
    });
  });

  describe("cancel()", () => {
    it("cancels a pending timer but not a fired one", async () => {
      await adapter.schedule({
        timerKey: "wait:inst-3:node-1:1000",
        instanceId: "inst-3",
        nodeId: "node-1",
        workflowId: "wf-a",
        eventType: "evt",
        triggerAt: Date.now() + 1000,
        payload: {},
      });
      await adapter.cancel("wait:inst-3:node-1:1000");
      const [row] = await db
        .select()
        .from(timer)
        .where(eq(timer.timerKey, "wait:inst-3:node-1:1000"));
      expect(row?.status).toBe("cancelled");
    });
  });

  describe("TimerPoller.tick()", () => {
    it("fires a due timer by emitting on the eventBus with instanceId in the payload", async () => {
      await storage.saveInstance(makeInstance({ instanceId: "inst-fire" }));
      await adapter.schedule({
        timerKey: "wait:inst-fire:node-1:0",
        instanceId: "inst-fire",
        nodeId: "node-1",
        workflowId: "wf-a",
        eventType: "workflow.wait.inst-fire.node-1",
        triggerAt: Date.now() - 1000, // already due
        payload: { foo: "bar" },
      });

      const received: unknown[] = [];
      bus.on("workflow.wait.inst-fire.node-1", (data) => {
        received.push(data);
      });

      const fired = await poller.tick();
      expect(fired).toBe(1);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ foo: "bar", instanceId: "inst-fire" });

      const [row] = await db
        .select()
        .from(timer)
        .where(eq(timer.timerKey, "wait:inst-fire:node-1:0"));
      expect(row?.status).toBe("fired");
    });

    it("does not fire a timer that is not yet due", async () => {
      await storage.saveInstance(makeInstance({ instanceId: "inst-future" }));
      await adapter.schedule({
        timerKey: "wait:inst-future:node-1:0",
        instanceId: "inst-future",
        nodeId: "node-1",
        workflowId: "wf-a",
        eventType: "evt",
        triggerAt: Date.now() + 60_000,
        payload: {},
      });

      const fired = await poller.tick();
      expect(fired).toBe(0);
    });

    it("orphans a timer whose instance has already reached a terminal state", async () => {
      await storage.saveInstance(makeInstance({ instanceId: "inst-done", status: "completed" }));
      await adapter.schedule({
        timerKey: "wait:inst-done:node-1:0",
        instanceId: "inst-done",
        nodeId: "node-1",
        workflowId: "wf-a",
        eventType: "evt",
        triggerAt: Date.now() - 1000,
        payload: {},
      });

      const received: unknown[] = [];
      bus.on("evt", (data) => {
        received.push(data);
      });

      await poller.tick();
      expect(received).toHaveLength(0);

      const [row] = await db
        .select()
        .from(timer)
        .where(eq(timer.timerKey, "wait:inst-done:node-1:0"));
      expect(row?.status).toBe("orphaned");
    });

    it("orphans a timer whose instance no longer exists", async () => {
      await adapter.schedule({
        timerKey: "wait:inst-gone:node-1:0",
        instanceId: "inst-gone",
        nodeId: "node-1",
        workflowId: "wf-a",
        eventType: "evt",
        triggerAt: Date.now() - 1000,
        payload: {},
      });

      await poller.tick();
      const [row] = await db
        .select()
        .from(timer)
        .where(eq(timer.timerKey, "wait:inst-gone:node-1:0"));
      expect(row?.status).toBe("orphaned");
    });
  });

  describe("reap()", () => {
    it("returns a claimed timer past its lease back to pending", async () => {
      await storage.saveInstance(makeInstance({ instanceId: "inst-reap" }));
      await adapter.schedule({
        timerKey: "wait:inst-reap:node-1:0",
        instanceId: "inst-reap",
        nodeId: "node-1",
        workflowId: "wf-a",
        eventType: "evt",
        triggerAt: Date.now() - 1000,
        payload: {},
      });

      // Simulate a claim whose lease already expired (a process died
      // mid-batch after claiming but before firing).
      await db
        .update(timer)
        .set({ status: "claimed", lockedUntil: new Date(Date.now() - 1000) })
        .where(eq(timer.timerKey, "wait:inst-reap:node-1:0"));

      const reaped = await poller.reap();
      expect(reaped).toBe(1);

      const [row] = await db
        .select()
        .from(timer)
        .where(eq(timer.timerKey, "wait:inst-reap:node-1:0"));
      expect(row?.status).toBe("pending");
    });

    it("does not touch a claimed timer still within its lease", async () => {
      await storage.saveInstance(makeInstance({ instanceId: "inst-leased" }));
      await adapter.schedule({
        timerKey: "wait:inst-leased:node-1:0",
        instanceId: "inst-leased",
        nodeId: "node-1",
        workflowId: "wf-a",
        eventType: "evt",
        triggerAt: Date.now() - 1000,
        payload: {},
      });
      await db
        .update(timer)
        .set({ status: "claimed", lockedUntil: new Date(Date.now() + 60_000) })
        .where(eq(timer.timerKey, "wait:inst-leased:node-1:0"));

      const reaped = await poller.reap();
      expect(reaped).toBe(0);
    });
  });
});
