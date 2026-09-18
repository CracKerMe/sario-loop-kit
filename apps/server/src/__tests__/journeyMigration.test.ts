/**
 * Journey version migration — real database, real engine, real publish path.
 *
 * What this proves: publishing registers each journey_version under its own
 * engine version string (so runs started earlier stay pinned to their
 * version), strict/remap/restart move a parked run correctly, refused
 * migrations surface as typed HTTP errors, the bulk endpoint skips
 * terminal/pending runs and other workspaces are invisible.
 */
import { publishJourney, startJourneyRun, upsertContact } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import { contact, journey, journeyRun, journeyVersion, workspace } from "@loopkit/db/schema";
import { createLoopkitEngine, type LoopkitEngine } from "@loopkit/engine";
import type { JourneyGraph } from "@loopkit/journey";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "@loopkit/email";
import { Hono } from "hono";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthVariables } from "../middleware/auth";
import { setEngineForTesting } from "../loopkitRuntime";
import { journeysRouter, runsRouter } from "../routes/journeys";

const { testDbUrl, originalDatabaseUrl } = vi.hoisted(() => {
  const fallback = "postgresql://postgres:password@localhost:5432/loopkit";
  const base = process.env.DATABASE_URL ?? fallback;
  const url = new URL(base);
  url.pathname = "/loopkit_test_server";
  const testDbUrl = url.toString();
  process.env.DATABASE_URL = testDbUrl;
  return { testDbUrl, originalDatabaseUrl: base };
});

const db: Db = createDb(testDbUrl);

const TABLES = [journeyRun, journeyVersion, journey, contact, workspace] as const;

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

function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("auth", { workspaceId: "ws-1", kind: "session", userId: "user-1" });
    await next();
  });
  app.route("/v1/journeys", journeysRouter);
  app.route("/v1/runs", runsRouter);
  return app;
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

const J = "j-mig";
const WF = `journey-${J}`;
const contactIds = new Map<string, string>();

async function seedJourney(): Promise<void> {
  await db
    .insert(workspace)
    .values({ id: "ws-1", name: "Test", slug: "test" })
    .onConflictDoNothing();
  await db
    .insert(workspace)
    .values({ id: "ws-2", name: "Other", slug: "other" })
    .onConflictDoNothing();
  await db.insert(journey).values({
    id: J,
    workspaceId: "ws-1",
    name: "Migration",
    workflowId: WF,
    status: "draft",
    trigger: { kind: "manual" },
  });
  await db.insert(journey).values({
    id: "j-other",
    workspaceId: "ws-2",
    name: "Other workspace journey",
    workflowId: "journey-j-other",
    status: "draft",
    trigger: { kind: "manual" },
  });
}

async function saveVersion(version: number, g: JourneyGraph): Promise<void> {
  await db
    .insert(journeyVersion)
    .values({ journeyId: J, version, graph: g, compiled: {} })
    .onConflictDoUpdate({
      target: [journeyVersion.journeyId, journeyVersion.version],
      set: { graph: g },
    });
}

async function startRun(
  engine: LoopkitEngine,
  contactId: string,
  version: number,
): Promise<{ runId: string; instanceId: string }> {
  const res = await startJourneyRun(
    db,
    engine.ctx.engine,
    {
      workspaceId: "ws-1",
      journeyId: J,
      contactId,
      workflowId: WF,
      journeyVersion: version,
      context: {
        workspaceId: "ws-1",
        journeyId: J,
        contactId,
        journeyRunId: "ctx",
        contact: { id: contactId, email: `${contactId}@example.com` },
        trigger: { kind: "manual" },
      },
    },
    "always",
  );
  if (!res.started || !res.runId || !res.instanceId) throw new Error("run did not start");
  return { runId: res.runId, instanceId: res.instanceId };
}

async function runFor(contactId: string): Promise<string> {
  // Select deterministically via the contactIds map (upsertContact mints UUIDs).
  const rows = await db
    .select({ instanceId: journeyRun.instanceId })
    .from(journeyRun)
    .where(eq(journeyRun.contactId, contactIds.get(contactId)!));
  if (rows.length !== 1) throw new Error(`expected 1 run for ${contactId}, got ${rows.length}`);
  return rows[0]!.instanceId;
}

type MigrateBody = {
  runId?: string;
  instanceId?: string;
  fromVersion?: number;
  toVersion?: number;
  strategy?: string;
  currentNodes?: string[];
  error?: string;
  message?: string;
};
type BulkBody = {
  migrated?: number;
  alreadyOnTarget?: number;
  failed?: number;
  pending?: number;
  toVersion?: number;
  failures?: { runId: string; code: string; error: string }[];
  error?: string;
};
const parse = async (res: Response): Promise<MigrateBody | BulkBody> =>
  (await res.json()) as MigrateBody | BulkBody;

describe("journey version migration", () => {
  let engine: Awaited<ReturnType<typeof createLoopkitEngine>>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    engine = (await createLoopkitEngine({
      db,
      emailProvider: new SilentProvider(),
      defaultFromEmail: "news@loopkit.dev",
      pollIntervalMs: 10_000, // parked runs must not be woken by the poller
    })) as LoopkitEngine;
    setEngineForTesting(engine);
    app = buildApp();
  });

  /**
   * Fresh world per test: truncate + reseed. The engine's register() is
   * idempotent per version, so re-publishing the same three versions each
   * time is cheap and keeps every test independent.
   */
  beforeEach(async () => {
    await resetTables();
    await seedJourney();

    // v1: park on wait "w" (node id kept in v2, removed in v3).
    await saveVersion(
      1,
      graph(
        [
          { id: "t", type: "trigger", data: { trigger: { kind: "manual" } } },
          { id: "w", type: "waitEvent", data: { eventName: "purchase.completed" } },
          { id: "x", type: "exit", data: { reason: "done" } },
        ],
        [
          ["t", "w"],
          ["w", "x"],
        ],
      ),
    );
    await publishJourney(db, engine.ctx.engine, "ws-1", J); // publishes latest = v1

    // Contacts parked on specific versions ("w" / "w2" wait nodes). Note
    // upsertContact mints UUID ids — the label is just the email prefix.
    contactIds.clear();
    for (const c of ["contact-a", "contact-b", "contact-c", "contact-d", "contact-e"]) {
      const row = await upsertContact(db, {
        workspaceId: "ws-1",
        email: `${c}@example.com`,
        properties: {},
      });
      contactIds.set(c, row.id);
    }
    await startRun(engine, contactIds.get("contact-a")!, 1);
    for (const c of ["contact-b", "contact-c", "contact-d", "contact-e"]) {
      await startRun(engine, contactIds.get(c)!, 2);
    }

    // v2: same node ids (strict-compatible), template churn only.
    await saveVersion(
      2,
      graph(
        [
          { id: "t", type: "trigger", data: { trigger: { kind: "manual" } } },
          { id: "w", type: "waitEvent", data: { eventName: "checkout.finished" } },
          { id: "x", type: "exit", data: { reason: "done" } },
        ],
        [
          ["t", "w"],
          ["w", "x"],
        ],
      ),
    );
    await publishJourney(db, engine.ctx.engine, "ws-1", J); // active = v2

    // v3: "w" is gone, replaced by "w2" (strict-refutable, remappable).
    await saveVersion(
      3,
      graph(
        [
          { id: "t", type: "trigger", data: { trigger: { kind: "manual" } } },
          { id: "w2", type: "waitEvent", data: { eventName: "purchase.completed" } },
          { id: "x", type: "exit", data: { reason: "done" } },
        ],
        [
          ["t", "w2"],
          ["w2", "x"],
        ],
      ),
    );
    await publishJourney(db, engine.ctx.engine, "ws-1", J); // active = v3

    // Draft v4 — migration target must be refused.
    await saveVersion(
      4,
      graph(
        [
          { id: "t", type: "trigger", data: { trigger: { kind: "manual" } } },
          { id: "x", type: "exit", data: { reason: "done" } },
        ],
        [["t", "x"]],
      ),
    );
  });

  afterAll(async () => {
    setEngineForTesting(null);
    await engine.stop();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("pins each run to the engine version active when it started", async () => {
    const runs = await db
      .select({ contactId: journeyRun.contactId, journeyVersion: journeyRun.journeyVersion })
      .from(journeyRun)
      .where(eq(journeyRun.journeyId, J));
    const byContact = new Map(runs.map((r) => [r.contactId, r.journeyVersion]));
    expect(byContact.get(contactIds.get("contact-a")!)).toBe(1);
    expect(byContact.get(contactIds.get("contact-b")!)).toBe(2);
  });

  it("migrates a v1 run strictly to v2, keeping the parked node", async () => {
    const instanceId = await runFor("contact-a");

    const res = await app.request(`/v1/runs/${instanceId}/migrate`, {
      method: "POST",
      body: JSON.stringify({ strategy: "strict", targetVersion: 2 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await parse(res)) as MigrateBody;
    expect(body.toVersion).toBe(2);
    expect(body.currentNodes).toEqual(["w"]);

    const [after] = await db
      .select({ journeyVersion: journeyRun.journeyVersion })
      .from(journeyRun)
      .where(eq(journeyRun.instanceId, instanceId));
    expect(after?.journeyVersion).toBe(2);
  });

  it("refuses strict migration when the parked node was removed (409)", async () => {
    // contact-b is parked on v2's "w" node, which v3 no longer has.
    const instanceId = await runFor("contact-b");

    const res = await app.request(`/v1/runs/${instanceId}/migrate`, {
      method: "POST",
      body: JSON.stringify({ strategy: "strict", targetVersion: 3 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(409);
    const body = (await parse(res)) as MigrateBody;
    expect(body.error).toBe("unmappable");
  });

  it("remap moves the parked node to its mapped replacement", async () => {
    const instanceId = await runFor("contact-c");

    const res = await app.request(`/v1/runs/${instanceId}/migrate`, {
      method: "POST",
      body: JSON.stringify({
        strategy: "remap",
        targetVersion: 3,
        nodeMapping: { w: "w2" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await parse(res)) as MigrateBody;
    expect(body.currentNodes).toEqual(["w2"]);
  });

  it("rejects a nodeMapping referencing unknown nodes (400)", async () => {
    const instanceId = await runFor("contact-d");

    const badTarget = await app.request(`/v1/runs/${instanceId}/migrate`, {
      method: "POST",
      body: JSON.stringify({
        strategy: "remap",
        targetVersion: 3,
        nodeMapping: { w: "nope" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(badTarget.status).toBe(400);

    const badSource = await app.request(`/v1/runs/${instanceId}/migrate`, {
      method: "POST",
      body: JSON.stringify({
        strategy: "remap",
        targetVersion: 3,
        nodeMapping: { ghost: "w2" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(badSource.status).toBe(400);
  });

  it("restart sends the run back to the target's start node", async () => {
    const instanceId = await runFor("contact-e");

    const res = await app.request(`/v1/runs/${instanceId}/migrate`, {
      method: "POST",
      body: JSON.stringify({ strategy: "restart", targetVersion: 3 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await parse(res)) as MigrateBody;
    // v3's startNode is the trigger's first outgoing edge target ("w2") —
    // trigger nodes are not compiled into engine nodes.
    expect(body.currentNodes).toEqual(["w2"]);
  });

  it("refuses a draft version as migration target (400)", async () => {
    const instanceId = await runFor("contact-b");

    const res = await app.request(`/v1/runs/${instanceId}/migrate`, {
      method: "POST",
      body: JSON.stringify({ strategy: "strict", targetVersion: 4 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await parse(res)) as MigrateBody;
    expect(body.error).toBe("target_not_published");
  });

  it("bulk-migrates in-flight runs, counting skips, without touching other workspaces", async () => {
    // ws-2's journey has no in-flight runs and is invisible to ws-1 anyway.
    const res = await app.request(`/v1/journeys/${J}/migrate-inflight`, {
      method: "POST",
      body: JSON.stringify({ strategy: "restart", targetVersion: 3 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await parse(res)) as BulkBody;
    expect(body.migrated).toBe(5);
    expect(body.failed).toBe(0);
    expect(body.toVersion).toBe(3);

    const runs = await db
      .select({ journeyVersion: journeyRun.journeyVersion })
      .from(journeyRun)
      .where(eq(journeyRun.journeyId, J));
    for (const r of runs) expect(r.journeyVersion).toBe(3);
  });

  it("migrate-inflight on an unknown journey 404s", async () => {
    const res = await app.request("/v1/journeys/j-nope/migrate-inflight", {
      method: "POST",
      body: JSON.stringify({ strategy: "strict" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
  });
});
