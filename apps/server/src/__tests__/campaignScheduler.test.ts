/**
 * Campaign scheduling end to end: `scheduleCampaign` materializes and
 * freezes the audience, and `campaignSchedulerTick` — the same poller
 * `startCampaignScheduler` runs on an interval in production — fires a due
 * campaign through the real engine and a real (recording) provider.
 *
 * The important assertions are the ones a fake-drain unit test cannot make:
 * that firing a schedule actually reaches the provider, and that a
 * scheduled-but-not-yet-due campaign is left completely alone by the poller.
 */
import { createCampaign, createAudience, scheduleCampaign, upsertContact } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import {
  campaign,
  campaignRecipient,
  contact,
  emailSend,
  emailTemplate,
  workspace,
} from "@loopkit/db/schema";
import { createLoopkitEngine, type LoopkitEngine } from "@loopkit/engine";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "@loopkit/email";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Same DB redirect as goldenPath/journeyDryRun: the router uses @loopkit/db's default handle. */
const { testDbUrl } = vi.hoisted(() => {
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

const TABLES = [campaignRecipient, campaign, emailSend, emailTemplate, contact, workspace] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out waiting for condition");
}

describe("campaign scheduler", () => {
  let engine: LoopkitEngine;
  let provider: RecordingProvider;
  // Imported dynamically after the DATABASE_URL redirect above has taken
  // effect — campaignRunner.ts's `db` import must resolve to the test db.
  let campaignSchedulerTick: (typeof import("../campaignRunner"))["campaignSchedulerTick"];
  let setEngineForTesting: (typeof import("../loopkitRuntime"))["setEngineForTesting"];

  beforeAll(async () => {
    ({ setEngineForTesting } = await import("../loopkitRuntime"));
    ({ campaignSchedulerTick } = await import("../campaignRunner"));

    provider = new RecordingProvider();
    engine = (await createLoopkitEngine({
      db,
      emailProvider: provider,
      defaultFromEmail: "news@loopkit.dev",
      pollIntervalMs: 100,
    })) as LoopkitEngine;
    setEngineForTesting(engine);
  });

  afterAll(async () => {
    await engine.stop();
    setEngineForTesting(null);
  });

  beforeEach(async () => {
    await resetTables();
    provider.sends = [];
    await db.insert(workspace).values({ id: "ws-1", name: "Acme", slug: "acme" });
    await db.insert(emailTemplate).values({
      id: "tpl-1",
      workspaceId: "ws-1",
      name: "newsletter",
      subject: "Hi {{firstName}}",
      html: "<p>Hello {{firstName}}.</p>",
      fromEmail: "news@loopkit.dev",
      fromName: "Acme",
    });
  });

  async function seedAudienceAndContact() {
    await upsertContact(db, {
      workspaceId: "ws-1",
      email: "alice@example.com",
      properties: { firstName: "Alice" },
    });
    const { audience } = await createAudience(db, {
      workspaceId: "ws-1",
      name: "everyone",
      filter: {
        op: "and",
        children: [{ kind: "condition", field: "subscribed", operator: "exists" }],
      },
    });
    return audience;
  }

  it("fires a due campaign through the real engine and provider", async () => {
    const audience = await seedAudienceAndContact();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Due now",
      templateId: "tpl-1",
      audienceId: audience.id,
    });

    // scheduleCampaign refuses a past time (by design — see its doc
    // comment), so schedule slightly in the future, then simulate the
    // clock having moved on, exactly like listDueCampaigns's own test.
    await scheduleCampaign(db, "ws-1", created.id, new Date(Date.now() + 60_000));
    await db
      .update(campaign)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(campaign.id, created.id));

    const fired = await campaignSchedulerTick(10);
    expect(fired).toBe(1);

    await waitFor(async () => {
      const [row] = await db.select().from(campaign).where(eq(campaign.id, created.id));
      return row?.status === "sending" || row?.status === "sent";
    });
    await waitFor(async () => provider.sends.length >= 1);

    expect(provider.sends[0]?.to).toBe("alice@example.com");

    const [row] = await db.select().from(campaign).where(eq(campaign.id, created.id));
    expect(row?.scheduledAt).toBeNull();
  });

  it("leaves a scheduled campaign alone before its time arrives", async () => {
    const audience = await seedAudienceAndContact();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Not yet",
      templateId: "tpl-1",
      audienceId: audience.id,
    });
    await scheduleCampaign(db, "ws-1", created.id, new Date(Date.now() + 3_600_000));

    const fired = await campaignSchedulerTick(10);
    expect(fired).toBe(0);

    const [row] = await db.select().from(campaign).where(eq(campaign.id, created.id));
    expect(row?.status).toBe("scheduled");
    expect(provider.sends).toHaveLength(0);
  });
});
