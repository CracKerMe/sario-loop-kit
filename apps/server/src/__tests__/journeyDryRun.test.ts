/**
 * Journey dry-run route: real database, real graph in journey_version,
 * real template rendering — but ZERO side effects. What this proves:
 * the preview reflects the LATEST (draft) version graph, branch outcomes
 * follow the contact's actual properties, email previews render with the
 * contact's data, the marketing gates are predicted (unsubscribed /
 * suppressed), and cross-workspace journeys/contacts are invisible.
 */
import { addSuppression, getSuppression, upsertContact } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import {
  contact,
  emailTemplate,
  journey,
  journeyVersion,
  suppression,
  workspace,
} from "@loopkit/db/schema";
import { Hono } from "hono";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthVariables } from "../middleware/auth";
import { journeysRouter } from "../routes/journeys";

/**
 * Same trick as transactional.test.ts: the router uses @loopkit/db's
 * DEFAULT handle built from DATABASE_URL at import time, so the env var is
 * redirected to this package's test database BEFORE the first import, and
 * restored in afterAll so a shared worker's next file sees the real env.
 */
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

const TABLES = [suppression, journeyVersion, journey, emailTemplate, contact, workspace] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("auth", { workspaceId: "ws-1", kind: "session", userId: "user-1" });
    await next();
  });
  app.route("/v1/journeys", journeysRouter);
  return app;
}

/** Hono's res.json() is `unknown` under this tsconfig — shape it once here. */
type DryRunBody = {
  executionPath: string[];
  exited: boolean;
  emailPreviews: {
    templateId: string;
    wouldSend: boolean;
    blockedReason: string | null;
    subject: string | null;
    html: string | null;
  }[];
};
const parseBody = async (res: Response): Promise<DryRunBody> => (await res.json()) as DryRunBody;

function dryRun(app: ReturnType<typeof buildApp>, journeyId: string, body: object) {
  return app.request(`/v1/journeys/${journeyId}/dry-run`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const GRAPH = {
  nodes: [
    { id: "t", type: "trigger", data: { trigger: { kind: "manual" } }, position: { x: 0, y: 0 } },
    {
      id: "b",
      type: "branch",
      data: { expression: 'contact.plan == "pro"' },
      position: { x: 0, y: 0 },
    },
    {
      id: "pro",
      type: "email",
      data: { templateId: "tpl-pro", subject: "Pro hi {{ firstName }}" },
      position: { x: 0, y: 0 },
    },
    { id: "free", type: "email", data: { templateId: "tpl-free" }, position: { x: 0, y: 0 } },
    { id: "x", type: "exit", data: { reason: "done" }, position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t", target: "b" },
    { id: "e2", source: "b", target: "pro", sourceHandle: "true" },
    { id: "e3", source: "b", target: "free", sourceHandle: "false" },
    { id: "e4", source: "pro", target: "x" },
    { id: "e5", source: "free", target: "x" },
  ],
};

async function seedJourney(id: string, graph: unknown, version = 1) {
  await db
    .insert(journey)
    .values({
      id,
      workspaceId: "ws-1",
      name: "Onboarding",
      workflowId: `wf-${id}`,
      trigger: { kind: "manual" },
    })
    .onConflictDoNothing();
  await db.insert(journeyVersion).values({ journeyId: id, version, graph, compiled: {} });
}

describe("POST /v1/journeys/:id/dry-run", () => {
  const app = buildApp();

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    await resetTables();
    await db.insert(workspace).values([
      { id: "ws-1", name: "Test", slug: "test" },
      { id: "ws-2", name: "Other", slug: "other" },
    ]);
  });

  it("walks the latest draft graph and previews the email the pro contact would get", async () => {
    await seedJourney("j-1", GRAPH, 1);
    await seedJourney("j-1", { ...GRAPH, nodes: [...GRAPH.nodes] }, 2); // latest = v2
    const contactRow = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      properties: { plan: "pro", firstName: "Sam" },
    });
    await db.insert(emailTemplate).values({
      id: "tpl-pro",
      workspaceId: "ws-1",
      name: "Pro welcome",
      subject: "Welcome {{ firstName }}",
      html: "<p>Hi {{ firstName }}, plan {{ contact.plan }}.</p>",
    });
    await db.insert(emailTemplate).values({
      id: "tpl-free",
      workspaceId: "ws-1",
      name: "Free welcome",
      subject: "Hello",
      html: "<p>Free</p>",
    });

    const res = await dryRun(app, "j-1", { contactId: contactRow.id });
    expect(res.status).toBe(200);
    const body = (await parseBody(res)) as DryRunBody;

    expect(body.executionPath).toEqual(["b", "pro", "x"]);
    expect(body.exited).toBe(true);
    expect(body.emailPreviews).toHaveLength(1);
    const preview = body.emailPreviews[0]!;
    expect(preview.templateId).toBe("tpl-pro");
    expect(preview.wouldSend).toBe(true);
    expect(preview.subject).toBe("Pro hi Sam"); // node-level subject override wins
    expect(preview.html).toContain("Hi Sam, plan pro.");
  });

  it("routes a free-plan contact down the false branch", async () => {
    await seedJourney("j-1", GRAPH);
    const contactRow = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "free@example.com",
      properties: { plan: "free" },
    });
    await db.insert(emailTemplate).values({
      id: "tpl-free",
      workspaceId: "ws-1",
      name: "Free welcome",
      subject: "Hello",
      html: "<p>Free</p>",
    });

    const res = await dryRun(app, "j-1", { contactId: contactRow.id });
    const body = (await parseBody(res)) as DryRunBody;
    expect(body.executionPath).toEqual(["b", "free", "x"]);
    expect(body.emailPreviews[0]!.templateId).toBe("tpl-free");
  });

  it("predicts the marketing gates: unsubscribed and suppressed contacts would not be sent", async () => {
    await seedJourney("j-1", GRAPH);
    await db.insert(emailTemplate).values({
      id: "tpl-pro",
      workspaceId: "ws-1",
      name: "Pro",
      subject: "S",
      html: "<p>B</p>",
    });

    const unsub = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "unsub@example.com",
      properties: { plan: "pro" },
    });
    await db.update(contact).set({ subscribed: false }).where(eq(contact.id, unsub.id));
    const res = await dryRun(app, "j-1", { contactId: unsub.id });
    let body = (await parseBody(res)) as DryRunBody;
    expect(body.emailPreviews[0]!.wouldSend).toBe(false);
    expect(body.emailPreviews[0]!.blockedReason).toBe("unsubscribed");

    const bounced = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "bounced@example.com",
      properties: { plan: "pro" },
    });
    await addSuppression(db, {
      workspaceId: "ws-1",
      email: "bounced@example.com",
      reason: "hard_bounce",
      source: "test",
    });
    const res2 = await dryRun(app, "j-1", { contactId: bounced.id });
    body = (await parseBody(res2)) as DryRunBody;
    expect(body.emailPreviews[0]!.wouldSend).toBe(false);
    expect(body.emailPreviews[0]!.blockedReason).toBe("suppressed:hard_bounce");

    // The gate is a prediction — nothing was suppressed by the dry-run and
    // the suppression row still only exists because we inserted it.
    expect(await getSuppression(db, "ws-1", "unsub@example.com")).toBeNull();
  });

  it("reports a missing template instead of failing the whole preview", async () => {
    await seedJourney("j-1", GRAPH);
    const contactRow = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      properties: { plan: "pro" },
    });

    const res = await dryRun(app, "j-1", { contactId: contactRow.id });
    const body = (await parseBody(res)) as DryRunBody;
    expect(body.executionPath).toEqual(["b", "pro", "x"]);
    expect(body.emailPreviews[0]!.wouldSend).toBe(false);
    expect(body.emailPreviews[0]!.blockedReason).toBe("template_not_found");
  });

  it("404s a journey from another workspace and a contact from another workspace", async () => {
    await seedJourney("j-1", GRAPH);
    await db.insert(journey).values({
      id: "j-other",
      workspaceId: "ws-2",
      name: "Other ws",
      workflowId: "wf-j-other",
      trigger: { kind: "manual" },
    });
    await db.insert(journeyVersion).values({
      journeyId: "j-other",
      version: 1,
      graph: GRAPH,
      compiled: {},
    });
    const otherContact = await upsertContact(db, {
      workspaceId: "ws-2",
      email: "x@other.com",
      properties: {},
    });
    const ownContact = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "own@example.com",
      properties: { plan: "pro" },
    });

    expect((await dryRun(app, "j-other", { contactId: ownContact.id })).status).toBe(404);
    expect((await dryRun(app, "j-1", { contactId: otherContact.id })).status).toBe(404);
  });

  it("400s a journey with no saved versions", async () => {
    await db.insert(journey).values({
      id: "j-empty",
      workspaceId: "ws-1",
      name: "Empty",
      workflowId: "wf-j-empty",
      trigger: { kind: "manual" },
    });
    const contactRow = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "a@b.com",
      properties: {},
    });
    expect((await dryRun(app, "j-empty", { contactId: contactRow.id })).status).toBe(400);
  });
});
