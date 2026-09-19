/**
 * P2.6 history compaction — real database, real engine boot.
 *
 * What this proves: a parked journey instance (wf_instance status waiting,
 * journey_run status running) whose execution log outgrew the cap is
 * compacted to the most recent entries through the SAME CAS path the engine
 * uses, with the in-memory copy the engine booted with kept in sync
 * (version bumped, history truncated on the shared object) — so the next
 * engine transition does not silently resurrect the blob. Everything that
 * must not be touched stays untouched: below-threshold instances, instances
 * of terminal runs, non-parked instances, and the load-bearing execution
 * state (currentNodes / context / per-node outputs).
 */
import { createDb, type Db } from "@loopkit/db";
import { contact, journey, journeyRun, workspace, wfInstance } from "@loopkit/db/schema";
import {
  compactParkedJourneyHistory,
  createLoopkitEngine,
  journeyHistoryLimitsFromEnv,
  type LoopkitEngine,
} from "@loopkit/engine";
import { ConsoleEmailProvider } from "@loopkit/email";
import { resolveTestConnectionString } from "@loopkit/db/testSupport";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const db: Db = createDb(resolveTestConnectionString("server"));

const TABLES = [journeyRun, journey, contact, workspace, wfInstance] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

const KEEP = 100;
const MAX = 300;

function historyEntries(count: number, prefix = "n") {
  return Array.from({ length: count }, (_, i) => ({
    nodeId: `${prefix}${i}`,
    timestamp: new Date(Date.now() - (count - i) * 1000),
    status: "success",
    data: { note: `step ${i} of a very long nurture journey` },
  }));
}

/** Shape mirrors what InstanceManager.createInstance persists via save(). */
function instanceData(input: {
  instanceId: string;
  workflowId: string;
  status: string;
  historyCount: number;
  currentNodes?: string[];
  version?: number;
}) {
  return {
    instanceId: input.instanceId,
    workflowId: input.workflowId,
    status: input.status,
    currentNodes: input.currentNodes ?? ["d2"],
    context: { contactId: "c-1", journeyRunId: "run-1" },
    history: historyEntries(input.historyCount),
    retries: {},
    createdAt: new Date(Date.now() - 86_400_000),
    updatedAt: new Date(),
    version: input.version ?? 3,
  };
}

async function seedWorld(): Promise<void> {
  await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  await db.insert(contact).values({
    id: "c-1",
    workspaceId: "ws-1",
    email: "nurture@example.com",
  });
  await db.insert(journey).values({
    id: "j-1",
    workspaceId: "ws-1",
    name: "Annual nurture",
    workflowId: "journey-j-1",
    status: "published",
    publishedVersion: 1,
    trigger: { kind: "manual" },
  });
  // One live run whose instance is parked mid-journey with an oversized log…
  await db.insert(journeyRun).values({
    id: "run-1",
    workspaceId: "ws-1",
    journeyId: "j-1",
    journeyVersion: 1,
    contactId: "c-1",
    instanceId: "inst-parked",
    status: "running",
  });
  await db.insert(wfInstance).values({
    instanceId: "inst-parked",
    workflowId: "journey-j-1",
    status: "waiting",
    version: 3,
    createdAt: new Date(Date.now() - 86_400_000),
    updatedAt: new Date(),
    data: instanceData({
      instanceId: "inst-parked",
      workflowId: "journey-j-1",
      status: "waiting",
      historyCount: 400,
    }),
  });
}

describe("parked journey history compaction end to end", () => {
  let engine: LoopkitEngine;

  // Fresh world AND fresh engine per test: the engine loads every stored
  // instance into its in-memory map at boot, so seeding before boot makes
  // the sweep exercise the shared-object path (in-memory truncation +
  // version bump) rather than a DB-side rewrite the engine would later
  // clobber. A per-test boot keeps that memory/DB pairing exact.
  beforeEach(async () => {
    await resetTables();
    await seedWorld();
    engine = await createLoopkitEngine({
      db,
      emailProvider: new ConsoleEmailProvider(),
      defaultFromEmail: "news@loopkit.dev",
    });
  });

  afterEach(async () => {
    if (engine) await engine.stop();
  });

  it("compacts an oversized parked journey instance and keeps memory in sync", async () => {
    const stats = await compactParkedJourneyHistory(
      db,
      engine.ctx.engine,
      engine.ctx.container.storage,
      { maxHistory: MAX, keepHistory: KEEP },
    );

    expect(stats.candidates).toBe(1);
    expect(stats.compacted).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.entriesFreed).toBe(400 - KEEP);

    // DB row: history trimmed to the most recent entries, version advanced.
    const [row] = await db
      .select()
      .from(wfInstance)
      .where(eq(wfInstance.instanceId, "inst-parked"));
    const data = row!.data as {
      history: unknown[];
      currentNodes: string[];
      context: Record<string, unknown>;
      version: number;
    };
    expect(data.history).toHaveLength(KEEP);
    // Most recent entries survive (tail kept, head dropped).
    expect((data.history[0] as { nodeId: string }).nodeId).toBe(`n${400 - KEEP}`);
    expect(data.version).toBe(4);
    expect(row!.version).toBe(4);

    // Engine memory: same object the sweep truncated, version bookkept so
    // the next engine CAS does not burn a retry.
    const inMemory = engine.ctx.engine.getInstance("inst-parked")!;
    expect(inMemory.history).toHaveLength(KEEP);
    expect(inMemory.version).toBe(4);

    // Load-bearing execution state untouched.
    expect(data.currentNodes).toEqual(["d2"]);
    expect(data.context).toMatchObject({ contactId: "c-1", journeyRunId: "run-1" });
  });

  it("leaves below-threshold, terminal-run and non-parked instances alone", async () => {
    // Below threshold (waiting, live run).
    await db.insert(journeyRun).values({
      id: "run-2",
      workspaceId: "ws-1",
      journeyId: "j-1",
      journeyVersion: 1,
      contactId: "c-1",
      instanceId: "inst-small",
      status: "running",
    });
    await db.insert(wfInstance).values({
      instanceId: "inst-small",
      workflowId: "journey-j-1",
      status: "waiting",
      version: 1,
      createdAt: new Date(Date.now() - 86_400_000),
      updatedAt: new Date(),
      data: instanceData({
        instanceId: "inst-small",
        workflowId: "journey-j-1",
        status: "waiting",
        historyCount: 50,
        version: 1,
      }),
    });

    // Oversized log but its run already finished — the terminal trail is
    // exactly what operators read when auditing a finished journey.
    await db.insert(journeyRun).values({
      id: "run-3",
      workspaceId: "ws-1",
      journeyId: "j-1",
      journeyVersion: 1,
      contactId: "c-1",
      instanceId: "inst-done",
      status: "completed",
    });
    await db.insert(wfInstance).values({
      instanceId: "inst-done",
      workflowId: "journey-j-1",
      status: "completed",
      version: 9,
      createdAt: new Date(Date.now() - 86_400_000),
      updatedAt: new Date(),
      data: instanceData({
        instanceId: "inst-done",
        workflowId: "journey-j-1",
        status: "completed",
        historyCount: 400,
        version: 9,
      }),
    });

    // Oversized log, live run, but the instance is mid-batch (running) —
    // the sweep only touches parked instances.
    await db.insert(journeyRun).values({
      id: "run-4",
      workspaceId: "ws-1",
      journeyId: "j-1",
      journeyVersion: 1,
      contactId: "c-1",
      instanceId: "inst-active",
      status: "running",
    });
    await db.insert(wfInstance).values({
      instanceId: "inst-active",
      workflowId: "journey-j-1",
      status: "running",
      version: 5,
      createdAt: new Date(Date.now() - 86_400_000),
      updatedAt: new Date(),
      data: instanceData({
        instanceId: "inst-active",
        workflowId: "journey-j-1",
        status: "running",
        historyCount: 400,
        currentNodes: ["e1"],
        version: 5,
      }),
    });

    const stats = await compactParkedJourneyHistory(
      db,
      engine.ctx.engine,
      engine.ctx.container.storage,
      { maxHistory: MAX, keepHistory: KEEP },
    );

    expect(stats.candidates).toBe(1); // only inst-parked
    expect(stats.compacted).toBe(1);

    // inst-small was seeded with 50 entries; the oversized pair with 400.
    for (const [id, expected] of [
      ["inst-small", 50],
      ["inst-done", 400],
      ["inst-active", 400],
    ] as const) {
      const [row] = await db.select().from(wfInstance).where(eq(wfInstance.instanceId, id));
      expect((row!.data as { history: unknown[] }).history.length).toBe(expected);
    }
  });

  it("parses sweeper env with clamping", () => {
    expect(journeyHistoryLimitsFromEnv({})).toEqual({
      maxHistory: 300,
      keepHistory: 100,
    });
    expect(
      journeyHistoryLimitsFromEnv({ JOURNEY_HISTORY_MAX: "500", JOURNEY_HISTORY_KEEP: "120" }),
    ).toEqual({ maxHistory: 500, keepHistory: 120 });
    // keep >= max would make every sweep a no-op → clamped to half.
    expect(
      journeyHistoryLimitsFromEnv({ JOURNEY_HISTORY_MAX: "100", JOURNEY_HISTORY_KEEP: "200" }),
    ).toEqual({ maxHistory: 100, keepHistory: 50 });
    // Garbage falls back to defaults.
    expect(
      journeyHistoryLimitsFromEnv({ JOURNEY_HISTORY_MAX: "abc", JOURNEY_HISTORY_KEEP: "-3" }),
    ).toEqual({ maxHistory: 300, keepHistory: 100 });
  });
});
