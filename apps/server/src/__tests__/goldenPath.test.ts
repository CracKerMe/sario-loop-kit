/**
 * Loops-style golden path against the real engine + DB:
 * publish a simple welcome drip → start a contact run → emails fire
 * through the short delay → run completes. Then publish the advanced
 * A/B+score+hours example and dry-run it through the journeys router.
 */
import { publishJourney, startJourneyRun, upsertContact } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import {
  contact,
  emailSend,
  emailTemplate,
  journey,
  journeyRun,
  journeyVersion,
  workspace,
} from "@loopkit/db/schema";
import { createLoopkitEngine, type LoopkitEngine } from "@loopkit/engine";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "@loopkit/email";
import type { JourneyGraph } from "@loopkit/journey";
import { welcomeAbScoreHoursGraph } from "@loopkit/journey/presets";
import { eq, getTableName, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthVariables } from "../middleware/auth";
import { setEngineForTesting } from "../loopkitRuntime";
import { journeysRouter } from "../routes/journeys";

/** Same DB redirect as journeyDryRun / journeyMigration — router uses @loopkit/db default handle. */
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

class RecordingProvider implements EmailProvider {
  readonly name = "recording";
  sends: SendEmailInput[] = [];
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sends.push(input);
    return { messageId: `msg-${this.sends.length}` };
  }
  async parseWebhook(): Promise<never[]> {
    return [];
  }
}

const TABLES = [
  emailSend,
  journeyRun,
  journeyVersion,
  journey,
  emailTemplate,
  contact,
  workspace,
] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

/** UI default welcome drip with templates filled + short delay for the test. */
function welcomeDrip(): JourneyGraph {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { trigger: { kind: "contact_created" } },
      },
      {
        id: "email_welcome",
        type: "email",
        position: { x: 0, y: 0 },
        data: { templateId: "tpl-welcome", subject: "Welcome aboard" },
      },
      {
        id: "delay_short",
        type: "delay",
        position: { x: 0, y: 0 },
        // ms only — value*unit wins in delayDataToMs and 1 minute is too long for tests.
        data: { mode: "duration", ms: 80 },
      },
      {
        id: "email_followup",
        type: "email",
        position: { x: 0, y: 0 },
        data: { templateId: "tpl-tips", subject: "Getting started tips" },
      },
      { id: "exit", type: "exit", position: { x: 0, y: 0 }, data: { reason: "completed" } },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "email_welcome" },
      { id: "e2", source: "email_welcome", target: "delay_short" },
      { id: "e3", source: "delay_short", target: "email_followup" },
      { id: "e4", source: "email_followup", target: "exit" },
    ],
  } as unknown as JourneyGraph;
}

async function seedJourney(id: string, name: string, graph: unknown, triggerKind = "manual") {
  await db.insert(journey).values({
    id,
    workspaceId: "ws-1",
    name,
    workflowId: `journey-${id}`,
    status: "draft",
    trigger: { kind: triggerKind },
  });
  await db.insert(journeyVersion).values({ journeyId: id, version: 1, graph, compiled: {} });
}

async function waitFor(description: string, predicate: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  const sends = await db.select().from(emailSend);
  throw new Error(
    `timed out waiting for ${description}${last ? `: ${String(last)}` : ""}; emailSend=${JSON.stringify(sends.map((s) => ({ status: s.status, error: s.error, to: s.toEmail, node: s.nodeId })))}`,
  );
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

describe("Phase 4 golden path", () => {
  let engine: LoopkitEngine;
  let provider: RecordingProvider;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    provider = new RecordingProvider();
    engine = (await createLoopkitEngine({
      db,
      emailProvider: provider,
      defaultFromEmail: "news@loopkit.dev",
      pollIntervalMs: 100,
    })) as LoopkitEngine;
    setEngineForTesting(engine);
    app = buildApp();
  });

  beforeEach(async () => {
    await resetTables();
    provider.sends = [];
    await db.insert(workspace).values({ id: "ws-1", name: "Acme", slug: "acme" });
    await db.insert(emailTemplate).values([
      {
        id: "tpl-welcome",
        workspaceId: "ws-1",
        name: "Welcome",
        subject: "Welcome aboard",
        html: "<p>Hi {{ firstName }}, welcome.</p>",
        fromEmail: "news@loopkit.dev",
        fromName: "Acme",
      },
      {
        id: "tpl-tips",
        workspaceId: "ws-1",
        name: "Tips",
        subject: "Getting started tips",
        html: "<p>Three things to try first.</p>",
        fromEmail: "news@loopkit.dev",
        fromName: "Acme",
      },
      {
        id: "welcome-template",
        workspaceId: "ws-1",
        name: "Adv welcome",
        subject: "Welcome aboard",
        html: "<p>Welcome</p>",
        fromEmail: "news@loopkit.dev",
      },
    ]);
  });

  afterAll(async () => {
    setEngineForTesting(null);
    await engine.stop();
    // Drop leftover published journeys so a later file's createLoopkitEngine
    // does not re-register and resume this suite's instances mid-race.
    await resetTables();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("publish welcome drip → start contact run → two emails → run completes", async () => {
    await seedJourney("j-welcome", "Welcome drip", welcomeDrip(), "contact_created");
    await publishJourney(db, engine.ctx.engine, "ws-1", "j-welcome");

    const [published] = await db.select().from(journey).where(eq(journey.id, "j-welcome")).limit(1);
    expect(published?.status).toBe("published");
    expect(published?.publishedVersion).toBe(1);

    const row = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "golden@example.com",
      properties: { firstName: "Golden" },
    });

    const res = await startJourneyRun(
      db,
      engine.ctx.engine,
      {
        workspaceId: "ws-1",
        journeyId: "j-welcome",
        contactId: row.id,
        workflowId: "journey-j-welcome",
        journeyVersion: 1,
        context: {
          workspaceId: "ws-1",
          journeyId: "j-welcome",
          contactId: row.id,
          contact: { id: row.id, email: "golden@example.com", firstName: "Golden" },
          trigger: { kind: "contact_created" },
        },
      },
      "always",
    );
    expect(res.started).toBe(true);

    await waitFor("both welcome-drip emails", async () => {
      if (provider.sends.length < 2) return false;
      const rows = await db.select().from(emailSend);
      return rows.filter((r) => r.status === "sent").length >= 2;
    });
    expect(provider.sends.every((s) => s.to === "golden@example.com")).toBe(true);

    const [run] = await db
      .select()
      .from(journeyRun)
      .where(eq(journeyRun.journeyId, "j-welcome"))
      .limit(1);
    expect(run).toBeTruthy();

    await waitFor("run to settle after exit", async () => {
      const [r] = await db.select().from(journeyRun).where(eq(journeyRun.id, run!.id)).limit(1);
      return Boolean(r?.exitedAt) || r?.status === "completed" || r?.status === "succeeded";
    });
  });

  it("advanced example graph still publishes and dry-runs without side effects", async () => {
    const graph = welcomeAbScoreHoursGraph();
    await seedJourney("j-adv", "Welcome AB", graph, "contact_created");
    await publishJourney(db, engine.ctx.engine, "ws-1", "j-adv");

    const [adv] = await db.select().from(journey).where(eq(journey.id, "j-adv")).limit(1);
    expect(adv?.status).toBe("published");

    const row = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "adv@example.com",
      properties: { firstName: "Adv" },
    });

    const before = provider.sends.length;
    const res = await app.request(`/v1/journeys/j-adv/dry-run`, {
      method: "POST",
      body: JSON.stringify({ contactId: row.id }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      executionPath: string[];
      emailPreviews: { templateId: string; wouldSend: boolean }[];
    };
    expect(body.executionPath[0]).toBe("email_welcome");
    expect(body.emailPreviews.length).toBeGreaterThan(0);
    expect(body.emailPreviews[0]?.templateId).toBe("welcome-template");
    expect(provider.sends.length).toBe(before);
  });
});
