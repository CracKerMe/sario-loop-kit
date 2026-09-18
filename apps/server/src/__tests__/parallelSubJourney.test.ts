/**
 * P2.4 parallel / join / subJourney — real database, real engine, real
 * publish + run path.
 *
 * What this proves:
 *  - a parallel node fans out and BOTH branches execute on the same run;
 *  - a mode-"all" join gate opens once every branch has arrived, including
 *    the staggered case where one branch parks on a waitEvent and the gate
 *    only opens when the event wakes it (the premature arrival dead-ends
 *    instead of failing the run);
 *  - a subJourney node spawns a real child engine instance (parentInstanceId
 *    link), the child's compiled nodes run with the parent's contact
 *    context, and the parent continues on its own path;
 *  - publish refuses subJourney references that are missing, unpublished,
 *    or cyclic — before any engine instance exists.
 */
import {
  publishJourney,
  startJourneyRun,
  SubJourneyReferenceError,
  upsertContact,
} from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import {
  contact,
  journey,
  journeyRun,
  journeyVersion,
  wfEventWait,
  wfInstance,
  workspace,
} from "@loopkit/db/schema";
import { createLoopkitEngine, type LoopkitEngine } from "@loopkit/engine";
import type { JourneyGraph } from "@loopkit/journey";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "@loopkit/email";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { testDbUrl, originalDatabaseUrl } = vi.hoisted(() => {
  const fallback = "postgresql://postgres:password@localhost:5432/loopkit";
  const base = process.env.DATABASE_URL ?? fallback;
  const url = new URL(base);
  url.pathname = "/loopkit_test_server";
  process.env.DATABASE_URL = url.toString();
  return { testDbUrl: url.toString(), originalDatabaseUrl: base };
});

const db: Db = createDb(testDbUrl);

const TABLES = [
  journeyRun,
  journeyVersion,
  journey,
  contact,
  workspace,
  wfInstance,
  wfEventWait,
] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

class SilentProvider implements EmailProvider {
  readonly name = "silent";
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    return { messageId: `msg-${input.to}` };
  }
  async parseWebhook(): Promise<never[]> {
    return [];
  }
}

function graph(
  nodes: { id: string; type: string; data?: object }[],
  edges: [string, string][],
): JourneyGraph {
  return {
    nodes: nodes.map((n) => ({ ...n, data: n.data ?? {}, position: { x: 0, y: 0 } })),
    edges: edges.map(([source, target], i) => ({ id: `e${i}`, source, target })),
  } as unknown as JourneyGraph;
}

const trigger = { id: "t", type: "trigger", data: { trigger: { kind: "manual" } } };

async function seedWorkspace(): Promise<void> {
  await db
    .insert(workspace)
    .values({ id: "ws-1", name: "Test", slug: "test" })
    .onConflictDoNothing();
  await db
    .insert(workspace)
    .values({ id: "ws-2", name: "Other", slug: "other" })
    .onConflictDoNothing();
}

async function seedJourney(id: string, name: string, workspaceId = "ws-1"): Promise<void> {
  await db.insert(journey).values({
    id,
    workspaceId,
    name,
    workflowId: `journey-${id}`,
    status: "draft",
    trigger: { kind: "manual" },
  });
}

async function saveVersion(journeyId: string, version: number, g: JourneyGraph): Promise<void> {
  await db
    .insert(journeyVersion)
    .values({ journeyId, version, graph: g, compiled: {} })
    .onConflictDoUpdate({
      target: [journeyVersion.journeyId, journeyVersion.version],
      set: { graph: g },
    });
}

const contactIds = new Map<string, string>();

async function createContact(label: string, workspaceId = "ws-1"): Promise<string> {
  const row = await upsertContact(db, {
    workspaceId,
    email: `${label}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    properties: {},
  });
  contactIds.set(label, row.id);
  return row.id;
}

async function startRun(
  engine: LoopkitEngine,
  journeyId: string,
  contactId: string,
): Promise<{ runId: string; instanceId: string }> {
  const res = await startJourneyRun(
    db,
    engine.ctx.engine,
    {
      workspaceId: "ws-1",
      journeyId,
      contactId,
      workflowId: `journey-${journeyId}`,
      journeyVersion: 1,
      context: {
        workspaceId: "ws-1",
        journeyId,
        contactId,
        journeyRunId: "ctx",
        contact: { id: contactId },
        trigger: { kind: "manual" },
      },
    },
    "always",
  );
  if (!res.started || !res.runId || !res.instanceId) throw new Error("run did not start");
  return { runId: res.runId, instanceId: res.instanceId };
}

async function contactProps(contactId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ properties: contact.properties })
    .from(contact)
    .where(eq(contact.id, contactId))
    .limit(1);
  return (row?.properties ?? {}) as Record<string, unknown>;
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

describe("parallel / join / subJourney", () => {
  let engine: Awaited<ReturnType<typeof createLoopkitEngine>>;

  beforeAll(async () => {
    engine = (await createLoopkitEngine({
      db,
      emailProvider: new SilentProvider(),
      defaultFromEmail: "news@loopkit.dev",
      pollIntervalMs: 10_000, // wake paths under test are event-driven, not the poller
    })) as LoopkitEngine;
  });

  beforeEach(async () => {
    await resetTables();
    await seedWorkspace();
    contactIds.clear();
  });

  afterAll(async () => {
    await engine.stop();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("runs both parallel branches and converges at a mode-all join in the same batch", async () => {
    await seedJourney("j-par", "Parallel");
    await saveVersion(
      "j-par",
      1,
      graph(
        [
          trigger,
          { id: "p", type: "parallel" },
          { id: "a", type: "updateContact", data: { set: { branch: "a-side" } } },
          { id: "b", type: "updateContact", data: { set: { other: "b-side" } } },
          { id: "j", type: "join", data: { mode: "all" } },
          { id: "after", type: "updateContact", data: { set: { joined: "yes" } } },
          { id: "x", type: "exit", data: { reason: "done" } },
        ],
        [
          ["t", "p"],
          ["p", "a"],
          ["p", "b"],
          ["a", "j"],
          ["b", "j"],
          ["j", "after"],
          ["after", "x"],
        ],
      ),
    );
    await publishJourney(db, engine.ctx.engine, "ws-1", "j-par");

    const contactId = await createContact("par");
    await startRun(engine, "j-par", contactId);

    await waitFor("post-join node to run", async () =>
      Boolean((await contactProps(contactId)).joined),
    );
    const props = await contactProps(contactId);
    expect(props.branch).toBe("a-side");
    expect(props.other).toBe("b-side");
    expect(props.joined).toBe("yes");
  });

  it("opens a staggered mode-all join only when a parked waitEvent branch wakes", async () => {
    await seedJourney("j-stag", "Staggered");
    await saveVersion(
      "j-stag",
      1,
      graph(
        [
          trigger,
          { id: "p", type: "parallel" },
          // branch a parks on an event; branch b completes immediately
          { id: "a", type: "waitEvent", data: { eventName: "test.ping" } },
          { id: "b", type: "updateContact", data: { set: { branchB: "done" } } },
          { id: "j", type: "join", data: { mode: "all" } },
          { id: "after", type: "updateContact", data: { set: { joined: "yes" } } },
          { id: "x", type: "exit", data: { reason: "done" } },
        ],
        [
          ["t", "p"],
          ["p", "a"],
          ["p", "b"],
          ["a", "j"],
          ["b", "j"],
          ["j", "after"],
          ["after", "x"],
        ],
      ),
    );
    await publishJourney(db, engine.ctx.engine, "ws-1", "j-stag");

    const contactId = await createContact("stag");
    const { instanceId } = await startRun(engine, "j-stag", contactId);

    // Engine batch semantics: a PARKED node (waitEvent) blocks the rest of
    // its batch, so branch b is postponed until a wakes — and the premature
    // join arrival (branch b's, once it runs) dead-ends instead of failing
    // the run. Nothing post-join may execute before the wake either way.
    await new Promise((r) => setTimeout(r, 500));
    expect((await contactProps(contactId)).joined).toBeUndefined();
    const [parkedRun] = await db
      .select({ status: journeyRun.status })
      .from(journeyRun)
      .where(eq(journeyRun.instanceId, instanceId));
    expect(parkedRun?.status).toBe("running");

    await engine.wakeForContactEvent({ eventName: "test.ping", contactId });

    await waitFor("both branches and the post-join node to run after the wake", async () => {
      const props = await contactProps(contactId);
      return props.branchB === "done" && props.joined === "yes";
    });
  });

  it("spawns a subJourney child instance that shares the parent's contact context", async () => {
    // Child: the reusable sequence — runs when referenced.
    await seedJourney("j-child", "Child sequence");
    await saveVersion(
      "j-child",
      1,
      graph(
        [
          {
            id: "t",
            type: "trigger",
            data: { trigger: { kind: "contact_created" } },
          },
          { id: "c1", type: "updateContact", data: { set: { childRan: "yes" } } },
          { id: "x", type: "exit", data: { reason: "child-done" } },
        ],
        [
          ["t", "c1"],
          ["c1", "x"],
        ],
      ),
    );
    await publishJourney(db, engine.ctx.engine, "ws-1", "j-child");

    // Parent: kick off the child, then continue on its own path.
    await seedJourney("j-parent", "Parent");
    await saveVersion(
      "j-parent",
      1,
      graph(
        [
          trigger,
          { id: "s", type: "subJourney", data: { journeyId: "j-child" } },
          { id: "p1", type: "updateContact", data: { set: { parentContinued: "yes" } } },
          { id: "x", type: "exit", data: { reason: "done" } },
        ],
        [
          ["t", "s"],
          ["s", "p1"],
          ["p1", "x"],
        ],
      ),
    );
    await publishJourney(db, engine.ctx.engine, "ws-1", "j-parent");

    const contactId = await createContact("sub");
    const { instanceId } = await startRun(engine, "j-parent", contactId);

    await waitFor("child node to run", async () =>
      Boolean((await contactProps(contactId)).childRan),
    );
    await waitFor("parent continuation to run", async () =>
      Boolean((await contactProps(contactId)).parentContinued),
    );

    const [childInstance] = await db
      .select({ instanceId: wfInstance.instanceId })
      .from(wfInstance)
      .where(eq(wfInstance.parentInstanceId, instanceId));
    expect(childInstance).toBeDefined();
  });

  it("refuses to publish when a subJourney child does not exist", async () => {
    await seedJourney("j-ref", "Refs");
    await saveVersion(
      "j-ref",
      1,
      graph(
        [
          trigger,
          { id: "s", type: "subJourney", data: { journeyId: "j-missing" } },
          { id: "x", type: "exit", data: {} },
        ],
        [
          ["t", "s"],
          ["s", "x"],
        ],
      ),
    );
    await expect(publishJourney(db, engine.ctx.engine, "ws-1", "j-ref")).rejects.toBeInstanceOf(
      SubJourneyReferenceError,
    );
  });

  it("refuses to publish when a subJourney child is still a draft", async () => {
    await seedJourney("j-draft-child", "Draft child");
    await seedJourney("j-ref", "Refs");
    await saveVersion(
      "j-ref",
      1,
      graph(
        [
          trigger,
          { id: "s", type: "subJourney", data: { journeyId: "j-draft-child" } },
          { id: "x", type: "exit", data: {} },
        ],
        [
          ["t", "s"],
          ["s", "x"],
        ],
      ),
    );
    await expect(publishJourney(db, engine.ctx.engine, "ws-1", "j-ref")).rejects.toThrow(
      /no published version/,
    );
  });

  it("refuses to publish when a subJourney child lives in another workspace", async () => {
    await seedJourney("j-foreign", "Foreign child", "ws-2");
    await saveVersion(
      "j-foreign",
      1,
      graph(
        [
          {
            id: "t",
            type: "trigger",
            data: { trigger: { kind: "contact_created" } },
          },
          { id: "x", type: "exit", data: {} },
        ],
        [["t", "x"]],
      ),
    );
    // published in ws-2, but referenced from ws-1
    await db
      .update(journey)
      .set({ status: "published", publishedVersion: 1 })
      .where(eq(journey.id, "j-foreign"));
    await saveVersion(
      "j-foreign",
      1,
      graph([trigger, { id: "x", type: "exit", data: {} }], [["t", "x"]]),
    );
    await publishJourney(db, engine.ctx.engine, "ws-2", "j-foreign");

    await seedJourney("j-ref", "Refs");
    await saveVersion(
      "j-ref",
      1,
      graph(
        [
          trigger,
          { id: "s", type: "subJourney", data: { journeyId: "j-foreign" } },
          { id: "x", type: "exit", data: {} },
        ],
        [
          ["t", "s"],
          ["s", "x"],
        ],
      ),
    );
    await expect(publishJourney(db, engine.ctx.engine, "ws-1", "j-ref")).rejects.toThrow(
      /does not exist in this workspace/,
    );
  });

  it("refuses to publish a cyclic subJourney reference chain", async () => {
    // Seed an already-published child that references the parent-to-be —
    // impossible through the publish gate alone, which is exactly the
    // stale-state scenario this guard exists for.
    await seedJourney("j-cyc-parent", "Cyc parent");
    await seedJourney("j-cyc-child", "Cyc child");
    await db
      .update(journey)
      .set({ status: "published", publishedVersion: 1 })
      .where(eq(journey.id, "j-cyc-child"));
    await saveVersion(
      "j-cyc-child",
      1,
      graph(
        [
          trigger,
          { id: "s", type: "subJourney", data: { journeyId: "j-cyc-parent" } },
          { id: "x", type: "exit", data: {} },
        ],
        [
          ["t", "s"],
          ["s", "x"],
        ],
      ),
    );

    await saveVersion(
      "j-cyc-parent",
      1,
      graph(
        [
          trigger,
          { id: "s", type: "subJourney", data: { journeyId: "j-cyc-child" } },
          { id: "x", type: "exit", data: {} },
        ],
        [
          ["t", "s"],
          ["s", "x"],
        ],
      ),
    );
    await expect(publishJourney(db, engine.ctx.engine, "ws-1", "j-cyc-parent")).rejects.toThrow(
      /cycle/,
    );
  });
});
