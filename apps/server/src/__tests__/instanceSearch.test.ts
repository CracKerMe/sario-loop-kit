/**
 * Instance search route (GET /v1/runs): real database rows in journey_run,
 * wf_instance and wf_event_wait. What this proves: search by contact email
 * resolves through the contacts table, "stuck at" comes from the engine's
 * currentNodes inside the wf_instance blob, waitingEvent filters through
 * wf_event_wait, and everything is workspace-scoped.
 */
import { upsertContact } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import {
  contact,
  journey,
  journeyRun,
  wfEventWait,
  wfInstance,
  workspace,
} from "@loopkit/db/schema";
import { Hono } from "hono";
import { getTableName, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthVariables } from "../middleware/auth";
import { runsRouter } from "../routes/journeys";

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

const TABLES = [wfEventWait, wfInstance, journeyRun, journey, contact, workspace] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

function buildApp(workspaceId = "ws-1") {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("auth", { workspaceId, kind: "session", userId: "user-1" });
    await next();
  });
  app.route("/v1/runs", runsRouter);
  return app;
}

type SearchBody = {
  runs: {
    run: { id: string; instanceId: string; status: string; journeyVersion: number };
    journey: { id: string; name: string };
    contact: { id: string; email: string | null };
    currentNodes: string[] | null;
    engineStatus: string | null;
    waitingFor: { nodeId: string; eventType: string }[];
  }[];
};

async function seedJourney(id: string, workspaceId: string): Promise<void> {
  await db
    .insert(journey)
    .values({
      id,
      workspaceId,
      name: `Journey ${id}`,
      workflowId: `wf-${id}`,
      trigger: { kind: "manual" },
    })
    .onConflictDoNothing();
}

async function seedRun(input: {
  id: string;
  workspaceId: string;
  journeyId: string;
  contactId: string;
  status: "running" | "completed" | "failed";
  engineStatus?: string;
  currentNodes?: string[];
  waitingEvent?: { nodeId: string; eventType: string };
}): Promise<void> {
  const instanceId = `inst-${input.id}`;
  await db.insert(journeyRun).values({
    id: input.id,
    workspaceId: input.workspaceId,
    journeyId: input.journeyId,
    journeyVersion: 1,
    contactId: input.contactId,
    instanceId,
    status: input.status,
  });
  if (input.engineStatus) {
    await db.insert(wfInstance).values({
      instanceId,
      workflowId: `wf-${input.journeyId}`,
      status: input.engineStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
      data: { currentNodes: input.currentNodes ?? [] },
    });
  }
  if (input.waitingEvent) {
    await db.insert(wfEventWait).values({
      instanceId,
      nodeId: input.waitingEvent.nodeId,
      eventType: input.waitingEvent.eventType,
      data: { eventId: `evt-${input.id}` },
    });
  }
}

describe("GET /v1/runs (instance search)", () => {
  const app = buildApp();

  beforeEach(resetTables);

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("searches by email and enriches with currentNodes and journey name", async () => {
    await seedFixtures();
    const res = await app.request("/v1/runs?email=SAM@example.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.runs).toHaveLength(1);
    const row = body.runs[0]!;
    expect(row.contact.email).toBe("sam@example.com");
    expect(row.journey.name).toBe("Journey j-onboard");
    expect(row.currentNodes).toEqual(["wait-purchase"]);
    expect(row.engineStatus).toBe("running");
    expect(row.waitingFor).toEqual([{ nodeId: "wait-purchase", eventType: "purchase.completed" }]);
  });

  it("filters by waitingEvent — only runs currently parked on that event", async () => {
    await seedFixtures();
    const res = await app.request("/v1/runs?waitingEvent=purchase.completed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.runs.map((r) => r.run.id)).toEqual(["run-sam"]);
  });

  it("filters by journey and status", async () => {
    await seedFixtures();
    const res = await app.request("/v1/runs?journeyId=j-onboard&status=completed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.runs.map((r) => r.run.id)).toEqual(["run-alex"]);
  });

  it("is workspace-scoped — another workspace's runs are invisible", async () => {
    await seedFixtures();
    const res = await app.request("/v1/runs?email=outsider@example.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.runs).toEqual([]);

    const all = await app.request("/v1/runs");
    const allBody = (await all.json()) as SearchBody;
    expect(allBody.runs.map((r) => r.run.id).sort()).toEqual(["run-alex", "run-sam"]);
  });

  it("returns an empty list for an unknown email without touching engine tables", async () => {
    await seedFixtures();
    const res = await app.request("/v1/runs?email=nobody@example.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.runs).toEqual([]);
  });
});

/** Re-seed per test (beforeEach truncates everything). */
async function seedFixtures(): Promise<void> {
  await db
    .insert(workspace)
    .values({ id: "ws-1", name: "Test", slug: "test" })
    .onConflictDoNothing();
  await db
    .insert(workspace)
    .values({ id: "ws-2", name: "Other", slug: "other" })
    .onConflictDoNothing();
  await seedJourney("j-onboard", "ws-1");
  await seedJourney("j-other", "ws-2");

  const sam = await upsertContact(db, {
    workspaceId: "ws-1",
    email: "sam@example.com",
    properties: {},
  });
  const alex = await upsertContact(db, {
    workspaceId: "ws-1",
    email: "alex@example.com",
    properties: {},
  });
  const outsider = await upsertContact(db, {
    workspaceId: "ws-2",
    email: "outsider@example.com",
    properties: {},
  });

  await seedRun({
    id: "run-sam",
    workspaceId: "ws-1",
    journeyId: "j-onboard",
    contactId: sam.id,
    status: "running",
    engineStatus: "running",
    currentNodes: ["wait-purchase"],
    waitingEvent: { nodeId: "wait-purchase", eventType: "purchase.completed" },
  });
  await seedRun({
    id: "run-alex",
    workspaceId: "ws-1",
    journeyId: "j-onboard",
    contactId: alex.id,
    status: "completed",
  });
  await seedRun({
    id: "run-out",
    workspaceId: "ws-2",
    journeyId: "j-other",
    contactId: outsider.id,
    status: "running",
    engineStatus: "running",
    currentNodes: ["n1"],
  });
}
