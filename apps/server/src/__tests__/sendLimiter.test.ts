/**
 * End-to-end proof of the P2.5 per-workspace send limiter: a real engine,
 * real database, real `loopkit-email` channel and the REAL wiring (two
 * campaign drains fanned out concurrently), with only the provider faked.
 *
 * The unit tests in @loopkit/email prove the limiter's semaphore and
 * bucket in isolation. What they cannot prove — and what would silently
 * regress here — is that the campaign fan-out path (engine.start per
 * recipient, async notification nodes) actually passes THROUGH the
 * limiter, and that two workspaces draining at the same time are
 * throttled independently according to their own limits.
 */
import {
  createAudience,
  createCampaign,
  drainCampaign,
  launchCampaign,
  upsertContact,
} from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import {
  buildCampaignWorkflow,
  campaignSendContext,
  campaignWorkflowId,
  createLoopkitEngine,
} from "@loopkit/engine";
import { createWorkspaceSendLimiter } from "@loopkit/email";
import type {
  EmailProvider,
  SendEmailInput,
  SendEmailResult,
  WebhookRequest,
} from "@loopkit/email";
import { resolveTestConnectionString } from "@loopkit/db/testSupport";
import {
  campaign,
  campaignRecipient,
  contact,
  emailSend,
  emailTemplate,
  workspace,
} from "@loopkit/db/schema";
import { getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const db: Db = createDb(resolveTestConnectionString("server"));

/**
 * Provider double that holds each send open long enough for concurrent
 * fan-out to pile up, and records the high-water mark of in-flight calls
 * PER WORKSPACE (attributed via the contact address domain).
 */
class WorkspaceTrackingProvider implements EmailProvider {
  readonly name = "tracking";
  sends: SendEmailInput[] = [];
  private inFlight: Record<"ws1" | "ws2", number> = { ws1: 0, ws2: 0 };
  maxInFlight: Record<"ws1" | "ws2", number> = { ws1: 0, ws2: 0 };

  constructor(private readonly delayMs: number) {}

  private tag(to: string): "ws1" | "ws2" {
    return to.endsWith("@ws1.test") ? "ws1" : "ws2";
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const tag = this.tag(input.to);
    this.inFlight[tag] += 1;
    this.maxInFlight[tag] = Math.max(this.maxInFlight[tag], this.inFlight[tag]);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      this.sends.push(input);
      return { messageId: `msg-${this.sends.length}` };
    } finally {
      this.inFlight[tag] -= 1;
    }
  }

  async parseWebhook(_request: WebhookRequest): Promise<never[]> {
    return [];
  }
}

const TABLES = [campaignRecipient, campaign, emailSend, emailTemplate, contact, workspace] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

async function waitForSends(count: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.select({ status: emailSend.status }).from(emailSend);
    const terminal = rows.filter((r) => r.status !== "queued").length;
    if (terminal >= count) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} terminal email_send rows; saw ${terminal} of ${rows.length}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("per-workspace send limiter end to end", () => {
  let engine: Awaited<ReturnType<typeof createLoopkitEngine>>;
  let provider: WorkspaceTrackingProvider;
  let limiter: ReturnType<typeof createWorkspaceSendLimiter>;

  beforeAll(async () => {
    provider = new WorkspaceTrackingProvider(100);
    // ws-1 gets the default cap of 1; ws-2 overrides to 3.
    limiter = createWorkspaceSendLimiter({
      defaults: { concurrency: 1 },
      overrides: { "ws-2": { concurrency: 3 } },
    });
    engine = await createLoopkitEngine({
      db,
      emailProvider: provider,
      defaultFromEmail: "news@loopkit.dev",
      pollIntervalMs: 200,
      sendLimiter: limiter,
    });
  });

  afterAll(async () => {
    await engine.stop();
  });

  beforeEach(async () => {
    await resetTables();
    provider.sends = [];
    provider.maxInFlight = { ws1: 0, ws2: 0 };

    await db.insert(workspace).values([
      { id: "ws-1", name: "One", slug: "one" },
      { id: "ws-2", name: "Two", slug: "two" },
    ]);
    await db.insert(emailTemplate).values([
      {
        id: "tpl-ws1",
        workspaceId: "ws-1",
        name: "n1",
        subject: "Hi",
        html: "<p>Hi</p>",
        fromEmail: "news@loopkit.dev",
      },
      {
        id: "tpl-ws2",
        workspaceId: "ws-2",
        name: "n2",
        subject: "Hi",
        html: "<p>Hi</p>",
        fromEmail: "news@loopkit.dev",
      },
    ]);
  });

  async function seedAndLaunch(workspaceId: "ws-1" | "ws-2", domain: "ws1.test" | "ws2.test") {
    for (let i = 1; i <= 3; i++) {
      await upsertContact(db, { workspaceId, email: `u${i}@${domain}` });
    }
    const { audience } = await createAudience(db, {
      workspaceId,
      name: "all",
      filter: {
        op: "and",
        children: [{ kind: "condition", field: "subscribed", operator: "exists" }],
      },
    });
    const created = await createCampaign(db, {
      workspaceId,
      name: `campaign-${workspaceId}`,
      templateId: workspaceId === "ws-1" ? "tpl-ws1" : "tpl-ws2",
      audienceId: audience.id,
    });
    await launchCampaign(db, workspaceId, created.id);
    await engine.ctx.engine.register(
      buildCampaignWorkflow({
        campaignId: created.id,
        name: created.name,
        templateId: created.templateId!,
      }),
    );
    const starter = async (input: {
      campaignId: string;
      recipientId: string;
      contactId: string;
      email: string;
      workspaceId: string;
    }) => ({
      instanceId: await engine.ctx.engine.start(
        campaignWorkflowId(input.campaignId),
        campaignSendContext(input),
      ),
    });
    return { created, starter };
  }

  it("throttles each workspace independently while two campaigns drain concurrently", async () => {
    expect(engine.sendLimiter).toBe(limiter);

    const one = await seedAndLaunch("ws-1", "ws1.test");
    const two = await seedAndLaunch("ws-2", "ws2.test");

    // Both drains fan out at the same time — this is the scenario the
    // limiter exists for: without it, six provider calls would race in.
    const [r1, r2] = await Promise.all([
      drainCampaign(db, one.created.id, one.starter, { batchSize: 10 }),
      drainCampaign(db, two.created.id, two.starter, { batchSize: 10 }),
    ]);
    expect(r1.queued).toBe(3);
    expect(r2.queued).toBe(3);

    await waitForSends(6);
    expect(provider.sends).toHaveLength(6);

    // The default workspace (ws-1, cap 1) never had two sends on the wire.
    expect(provider.maxInFlight.ws1).toBe(1);
    // The overridden workspace (ws-2, cap 3) ran its three sends in
    // parallel — proving overrides flow through the engine wiring.
    expect(provider.maxInFlight.ws2).toBe(3);
  });
});
