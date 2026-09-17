/**
 * Conformance suite: the same assertions run against both MemoryStorage
 * (the engine's own reference implementation) and DrizzleStorageProvider.
 * This is the Phase 2 gate — per the plan, nothing downstream proceeds
 * until this file is green against both.
 *
 * Covers, per the plan's explicit list: CAS success/conflict/missing-row;
 * queryInstances sorted-before-paginated across page boundaries with ties;
 * Date round-tripping (createdAt comes back as a Date, not a string);
 * loadInstance returning a deep-cloned object the caller may freely
 * mutate.
 */
import {
  MemoryStorage,
  type StorageProvider,
  type WorkflowInstance,
} from "ts-workflow-engine-lite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DrizzleStorageProvider } from "../DrizzleStorageProvider";
import { resetEngineTables, testDb } from "./testDb";

function makeInstance(
  overrides: Partial<WorkflowInstance> & { instanceId: string },
): WorkflowInstance {
  return {
    workflowId: "wf-a",
    currentNodes: ["node-1"],
    status: "running",
    context: {},
    history: [],
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_000_000),
    retries: {},
    version: 1,
    ...overrides,
  };
}

const drizzleDb = testDb();

interface ProviderUnderTest {
  name: string;
  create: () => Promise<StorageProvider>;
  reset: () => Promise<void>;
}

const providers: ProviderUnderTest[] = [
  {
    name: "MemoryStorage",
    create: async () => {
      const s = new MemoryStorage();
      await s.connect();
      return s;
    },
    reset: async () => {},
  },
  {
    name: "DrizzleStorageProvider",
    create: async () => {
      const s = new DrizzleStorageProvider(drizzleDb);
      await s.connect();
      return s;
    },
    reset: () => resetEngineTables(drizzleDb),
  },
];

afterAll(async () => {
  await resetEngineTables(drizzleDb);
});

describe.each(providers)("$name conformance", ({ create, reset }) => {
  let storage: StorageProvider;

  beforeEach(async () => {
    await reset();
    storage = await create();
  });

  describe("instance CAS", () => {
    it("succeeds when the expected version matches and increments the stored version", async () => {
      const instance = makeInstance({ instanceId: "inst-cas-1" });
      await storage.saveInstance(instance);

      const ok = await storage.casUpdateInstance({ ...instance, status: "completed", version: 1 });
      expect(ok).toBe(true);

      const loaded = await storage.loadInstance("inst-cas-1");
      expect(loaded?.status).toBe("completed");
      expect(loaded?.version).toBe(2);
    });

    it("fails on a version conflict and leaves the stored instance unchanged", async () => {
      const instance = makeInstance({ instanceId: "inst-cas-2" });
      await storage.saveInstance(instance);

      // First CAS succeeds and moves the stored version to 2.
      await storage.casUpdateInstance({ ...instance, version: 1 });

      // A second writer still holding version 1 loses the race.
      const ok = await storage.casUpdateInstance({ ...instance, status: "failed", version: 1 });
      expect(ok).toBe(false);

      const loaded = await storage.loadInstance("inst-cas-2");
      expect(loaded?.status).not.toBe("failed");
      expect(loaded?.version).toBe(2);
    });

    it("fails when the instance row does not exist", async () => {
      const ok = await storage.casUpdateInstance(
        makeInstance({ instanceId: "does-not-exist", version: 1 }),
      );
      expect(ok).toBe(false);
    });

    it("allows a second CAS attempt after a conflict, using the freshly-loaded version", async () => {
      const instance = makeInstance({ instanceId: "inst-cas-3" });
      await storage.saveInstance(instance);
      await storage.casUpdateInstance({ ...instance, version: 1 }); // -> version 2

      // Simulate InstanceManager's retry: reload, then CAS with the fresh version.
      const fresh = await storage.loadInstance("inst-cas-3");
      const ok = await storage.casUpdateInstance({
        ...fresh!,
        status: "completed",
        version: fresh!.version,
      });
      expect(ok).toBe(true);

      const loaded = await storage.loadInstance("inst-cas-3");
      expect(loaded?.status).toBe("completed");
      expect(loaded?.version).toBe(3);
    });
  });

  describe("queryInstances: sort-before-paginate", () => {
    beforeEach(async () => {
      // 5 instances with distinct createdAt, plus 2 with a TIED createdAt
      // to exercise the instanceId tie-breaker.
      for (let i = 0; i < 5; i++) {
        await storage.saveInstance(
          makeInstance({
            instanceId: `inst-${i}`,
            createdAt: new Date(1_700_000_000_000 + i * 1000),
            updatedAt: new Date(1_700_000_000_000 + i * 1000),
          }),
        );
      }
      await storage.saveInstance(
        makeInstance({
          instanceId: "inst-tie-a",
          createdAt: new Date(1_700_000_010_000),
          updatedAt: new Date(1_700_000_010_000),
        }),
      );
      await storage.saveInstance(
        makeInstance({
          instanceId: "inst-tie-b",
          createdAt: new Date(1_700_000_010_000),
          updatedAt: new Date(1_700_000_010_000),
        }),
      );
    });

    it("returns every row exactly once across sequential pages, in sorted order", async () => {
      const pageSize = 3;
      const seen: string[] = [];
      let page = 1;
      let total = Number.POSITIVE_INFINITY;

      while (seen.length < total) {
        const result = await storage.queryInstances({
          workflowId: "wf-a",
          page,
          pageSize,
          sortBy: "createdAt",
          sortOrder: "asc",
        });
        total = result.total;
        seen.push(...result.instances.map((i) => i.instanceId));
        if (result.instances.length === 0) break;
        page++;
      }

      // No duplicates, no gaps: sorting must happen before slicing.
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(7);

      // Ascending createdAt order preserved across the page boundary.
      const rows = await storage.queryInstances({
        workflowId: "wf-a",
        page: 1,
        pageSize: 100,
        sortBy: "createdAt",
        sortOrder: "asc",
      });
      const createdAtMs = rows.instances.map((i) => new Date(i.createdAt).getTime());
      expect(createdAtMs).toEqual([...createdAtMs].sort((a, b) => a - b));
    });

    it("filters by status and workflowId together", async () => {
      await storage.saveInstance(makeInstance({ instanceId: "inst-other-wf", workflowId: "wf-b" }));
      await storage.saveInstance(
        makeInstance({ instanceId: "inst-completed", status: "completed" }),
      );

      const result = await storage.queryInstances({
        workflowId: "wf-a",
        status: "running",
        pageSize: 100,
      });
      expect(result.instances.every((i) => i.workflowId === "wf-a" && i.status === "running")).toBe(
        true,
      );
      expect(result.instances.some((i) => i.instanceId === "inst-other-wf")).toBe(false);
      expect(result.instances.some((i) => i.instanceId === "inst-completed")).toBe(false);
    });
  });

  describe("Date round-tripping", () => {
    it("returns createdAt/updatedAt as real Date instances, not strings", async () => {
      const instance = makeInstance({ instanceId: "inst-dates" });
      await storage.saveInstance(instance);

      const loaded = await storage.loadInstance("inst-dates");
      expect(loaded?.createdAt).toBeInstanceOf(Date);
      expect(loaded?.updatedAt).toBeInstanceOf(Date);
      // A call site doing instance.createdAt.getTime() must not throw.
      expect(() => loaded!.createdAt.getTime()).not.toThrow();
    });

    it("returns history[].timestamp as a real Date instance", async () => {
      const instance = makeInstance({
        instanceId: "inst-history-dates",
        history: [{ nodeId: "n1", timestamp: new Date(1_700_000_000_000), status: "success" }],
      });
      await storage.saveInstance(instance);

      const loaded = await storage.loadInstance("inst-history-dates");
      expect(loaded?.history[0]?.timestamp).toBeInstanceOf(Date);
    });

    it("preserves createdAt/updatedAt through queryInstances as Dates", async () => {
      await storage.saveInstance(makeInstance({ instanceId: "inst-query-dates" }));
      const result = await storage.queryInstances({ workflowId: "wf-a", pageSize: 100 });
      const found = result.instances.find((i) => i.instanceId === "inst-query-dates");
      expect(found?.createdAt).toBeInstanceOf(Date);
    });
  });

  describe("loadInstance returns a mutation-safe copy", () => {
    it("does not let the caller corrupt stored state by mutating the returned object", async () => {
      await storage.saveInstance(
        makeInstance({ instanceId: "inst-mutate", context: { count: 1 } }),
      );

      const first = await storage.loadInstance("inst-mutate");
      first!.context.count = 999;
      first!.status = "failed";

      const second = await storage.loadInstance("inst-mutate");
      expect(second?.context.count).toBe(1);
      expect(second?.status).toBe("running");
    });
  });

  describe("workflow definitions", () => {
    it("round-trips a workflow definition", async () => {
      const def = {
        id: "wf-def-1",
        name: "test",
        startNode: "a",
        nodes: { a: { id: "a", type: "action" as const, next: [] } },
      };
      await storage.saveWorkflow(def);
      const loaded = await storage.loadWorkflow("wf-def-1");
      expect(loaded?.id).toBe("wf-def-1");
      expect(loaded?.startNode).toBe("a");
    });

    it("lists and deletes workflows", async () => {
      await storage.saveWorkflow({ id: "wf-del", name: "x", startNode: "a", nodes: {} });
      expect(await storage.listWorkflows()).toContain("wf-del");
      await storage.deleteWorkflow("wf-del");
      expect(await storage.listWorkflows()).not.toContain("wf-del");
    });
  });

  describe("event waiting state", () => {
    it("saves, loads, lists, and deletes by (instanceId, nodeId)", async () => {
      const state = {
        instanceId: "inst-wait-1",
        nodeId: "wait-node",
        eventType: "order.placed",
        requireInstanceIdMatch: true,
        createdAt: Date.now(),
      };
      await storage.saveEventWaitingState(state);

      const loaded = await storage.loadEventWaitingState("inst-wait-1", "wait-node");
      expect(loaded?.eventType).toBe("order.placed");

      const all = await storage.loadAllEventWaitingStates();
      expect(all.some((s) => s.instanceId === "inst-wait-1" && s.nodeId === "wait-node")).toBe(
        true,
      );

      await storage.deleteEventWaitingState("inst-wait-1", "wait-node");
      expect(await storage.loadEventWaitingState("inst-wait-1", "wait-node")).toBeNull();
    });
  });

  describe("instance metrics: per-node writes reassemble correctly", () => {
    it("accumulates updateNodeMetrics calls into one InstanceMetrics", async () => {
      await storage.saveInstance(makeInstance({ instanceId: "inst-metrics" }));
      await storage.updateNodeMetrics("inst-metrics", "node-a", {
        nodeId: "node-a",
        retryCount: 0,
        status: "completed",
      });
      await storage.updateNodeMetrics("inst-metrics", "node-b", {
        nodeId: "node-b",
        retryCount: 1,
        status: "completed",
      });

      const metrics = await storage.loadInstanceMetrics("inst-metrics");
      expect(metrics?.nodeMetrics["node-a"]?.status).toBe("completed");
      expect(metrics?.nodeMetrics["node-b"]?.retryCount).toBe(1);
    });

    it("overwrites a single node's metrics without disturbing siblings", async () => {
      await storage.saveInstance(makeInstance({ instanceId: "inst-metrics-2" }));
      await storage.updateNodeMetrics("inst-metrics-2", "node-a", {
        nodeId: "node-a",
        retryCount: 0,
        status: "running",
      });
      await storage.updateNodeMetrics("inst-metrics-2", "node-a", {
        nodeId: "node-a",
        retryCount: 2,
        status: "completed",
      });
      await storage.updateNodeMetrics("inst-metrics-2", "node-b", {
        nodeId: "node-b",
        retryCount: 0,
        status: "running",
      });

      const metrics = await storage.loadInstanceMetrics("inst-metrics-2");
      expect(metrics?.nodeMetrics["node-a"]?.retryCount).toBe(2);
      expect(metrics?.nodeMetrics["node-b"]?.status).toBe("running");
    });
  });

  describe("event history", () => {
    it("saves, loads, queries, and deletes events", async () => {
      await storage.saveEvent({
        id: "evt-1",
        instanceId: "inst-evt",
        workflowId: "wf-a",
        eventType: "order.placed",
        payload: { total: 100 },
        timestamp: 1_700_000_000_000,
      });

      expect((await storage.loadEvent("evt-1"))?.eventType).toBe("order.placed");

      const { events, total } = await storage.queryEvents({ instanceId: "inst-evt" });
      expect(total).toBe(1);
      expect(events[0]?.id).toBe("evt-1");

      await storage.deleteEvent("evt-1");
      expect(await storage.loadEvent("evt-1")).toBeNull();
    });
  });
});
