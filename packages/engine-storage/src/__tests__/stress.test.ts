/**
 * Phase 2 gate: bulk instance load against DrizzleStorageProvider. Not a
 * substitute for the real 10k/100k concurrent-instance memory-ceiling
 * investigation the plan flags as an open risk (InstanceManager holds
 * every instance in memory regardless of storage backend — that's an
 * engine-level constraint no storage adapter can fix) — this only proves
 * the *storage layer itself* behaves correctly at that volume: writes
 * don't silently drop rows, queryInstances stays correct and reasonably
 * fast under pagination, and CAS holds up under concurrent writers.
 */
import type { WorkflowInstance } from "ts-workflow-engine-lite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleStorageProvider } from "../DrizzleStorageProvider";
import { resetEngineTables, testDb } from "./testDb";

const INSTANCE_COUNT = 10_000;
const db = testDb();
const storage = new DrizzleStorageProvider(db);

function makeInstance(index: number): WorkflowInstance {
  return {
    instanceId: `stress-${index}`,
    workflowId: index % 3 === 0 ? "wf-drip-a" : "wf-drip-b",
    currentNodes: ["wait-node"],
    status: index % 5 === 0 ? "completed" : "running",
    context: { contactId: `contact-${index}` },
    history: [],
    createdAt: new Date(1_700_000_000_000 + index),
    updatedAt: new Date(1_700_000_000_000 + index),
    retries: {},
    version: 1,
  };
}

describe("DrizzleStorageProvider bulk load", () => {
  beforeAll(async () => {
    await resetEngineTables(db);
    await storage.connect();
  }, 30_000);

  afterAll(async () => {
    await resetEngineTables(db);
  });

  it(`writes and reads back ${INSTANCE_COUNT} instances without loss`, async () => {
    const start = Date.now();

    // Concurrency-limited batches — 10k sequential round trips would make
    // this test itself the bottleneck, not the thing under test.
    const BATCH = 200;
    for (let i = 0; i < INSTANCE_COUNT; i += BATCH) {
      const batch = Array.from({ length: Math.min(BATCH, INSTANCE_COUNT - i) }, (_, j) =>
        makeInstance(i + j),
      );
      await Promise.all(batch.map((instance) => storage.saveInstance(instance)));
    }

    const writeMs = Date.now() - start;
    console.log(`wrote ${INSTANCE_COUNT} instances in ${writeMs}ms`);

    const ids = await storage.listInstances();
    expect(ids).toHaveLength(INSTANCE_COUNT);
  }, 120_000);

  it("queryInstances stays correct and fast across pages at this volume", async () => {
    const pageSize = 100;
    const seen = new Set<string>();
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    const start = Date.now();

    while (seen.size < total) {
      const result = await storage.queryInstances({
        workflowId: "wf-drip-a",
        page,
        pageSize,
        sortBy: "createdAt",
        sortOrder: "asc",
      });
      total = result.total;
      for (const instance of result.instances) seen.add(instance.instanceId);
      if (result.instances.length === 0) break;
      page++;
    }

    const queryMs = Date.now() - start;
    console.log(`paginated ${total} wf-drip-a instances across ${page} pages in ${queryMs}ms`);

    // Every third instance (index % 3 === 0) belongs to wf-drip-a.
    expect(total).toBe(Math.ceil(INSTANCE_COUNT / 3));
    expect(seen.size).toBe(total);
  }, 60_000);

  it("holds CAS correctness under concurrent writers on the same instance", async () => {
    const instance = makeInstance(999_999);
    await storage.saveInstance(instance);

    // 20 concurrent CAS attempts all starting from version 1 — exactly one
    // should win.
    const attempts = Array.from({ length: 20 }, () =>
      storage.casUpdateInstance({ ...instance, version: 1 }),
    );
    const results = await Promise.all(attempts);
    const successCount = results.filter(Boolean).length;

    expect(successCount).toBe(1);

    const loaded = await storage.loadInstance(instance.instanceId);
    expect(loaded?.version).toBe(2);
  }, 30_000);
});
