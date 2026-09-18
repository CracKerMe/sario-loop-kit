/**
 * End-to-end campaign fan-out against a **real** engine, a real database and
 * the real `loopkit-email` channel. Only the SMTP provider is faked.
 *
 * This closes the gap the unit tests deliberately leave open: @loopkit/core's
 * campaign suite injects a fake `startSend`, so it proves the *bookkeeping*
 * (materialize once, drain only pending, idempotent resume) but says nothing
 * about whether the campaign workflow's `{{ recipientId }}` interpolation
 * actually resolves inside the engine, or whether the channel derives the
 * intended `(campaignId, recipientId)` idempotency key from it. Those two are
 * the load-bearing assumptions of the whole design, and a typo in either
 * would pass every fake-starter test while double-sending in production.
 */
import {
  createAudience,
  createCampaign,
  drainCampaign,
  getCampaignStats,
  launchCampaign,
  listCampaignRecipients,
  requeuePausedCampaign,
  setCampaignStatus,
  syncCampaignRecipientStatuses,
  upsertContact,
} from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import {
  campaign,
  campaignRecipient,
  contact,
  emailSend,
  emailTemplate,
  suppression,
  workspace,
} from "@loopkit/db/schema";
import {
  createLoopkitEngine,
  buildCampaignWorkflow,
  campaignSendContext,
  campaignWorkflowId,
} from "@loopkit/engine";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "@loopkit/email";
import { resolveTestConnectionString } from "@loopkit/db/testSupport";
import { getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const db: Db = createDb(resolveTestConnectionString("server"));

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
  campaignRecipient,
  campaign,
  emailSend,
  emailTemplate,
  suppression,
  contact,
  workspace,
] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

/** Polls until the channel has written terminal rows, or the budget runs out. */
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

describe("campaign fan-out end to end", () => {
  let engine: Awaited<ReturnType<typeof createLoopkitEngine>>;
  let provider: RecordingProvider;

  beforeAll(async () => {
    provider = new RecordingProvider();
    engine = await createLoopkitEngine({
      db,
      emailProvider: provider,
      defaultFromEmail: "news@loopkit.dev",
      pollIntervalMs: 200,
    });
  });

  afterAll(async () => {
    await engine.stop();
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
      html: "<p>Hello {{firstName}}, your plan is {{plan}}.</p>",
      fromEmail: "news@loopkit.dev",
      fromName: "Acme",
    });
  });

  it("sends exactly one email per mailable recipient and no duplicates on a re-drain", async () => {
    const alice = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "alice@example.com",
      properties: { firstName: "Alice", plan: "pro" },
    });
    await upsertContact(db, {
      workspaceId: "ws-1",
      email: "bob@example.com",
      properties: { firstName: "Bob", plan: "free" },
    });
    // Excluded at materialization: unsubscribed, and address-suppressed.
    const optedOut = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "carol@example.com",
      properties: { firstName: "Carol" },
    });
    await db
      .update(contact)
      .set({ subscribed: false })
      .where(sql`${contact.id} = ${optedOut.id}`);
    await upsertContact(db, { workspaceId: "ws-1", email: "dave@example.com" });
    await db.insert(suppression).values({
      id: "sup-1",
      workspaceId: "ws-1",
      email: "dave@example.com",
      reason: "hard_bounce",
    });

    const { audience } = await createAudience(db, {
      workspaceId: "ws-1",
      name: "everyone",
      filter: {
        op: "and",
        children: [{ kind: "condition", field: "subscribed", operator: "exists" }],
      },
    });
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "September update",
      templateId: "tpl-1",
      audienceId: audience.id,
    });

    const launched = await launchCampaign(db, "ws-1", created.id);
    expect(launched.campaign.audienceMemberCount).toBe(4);
    expect(launched.campaign.audienceSendableCount).toBe(2);
    expect(launched.recipients).toBe(2);

    // The real wiring the server performs (apps/server's campaignRunner).
    await engine.ctx.engine.register(
      buildCampaignWorkflow({
        campaignId: created.id,
        name: created.name,
        templateId: "tpl-1",
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

    const first = await drainCampaign(db, created.id, starter, { batchSize: 10 });
    expect(first.queued).toBe(2);
    expect(first.remaining).toBe(0);

    await waitForSends(2);

    // Interpolation actually resolved: the channel got a real address, and
    // the idempotency key is (campaignId, recipientId) — not a literal
    // "{{ recipientId }}" or an empty string.
    const rows = await db.select().from(emailSend);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.toEmail).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    for (const row of rows) {
      expect(row.campaignId).toBe(created.id);
      expect(row.journeyRunId).toBeNull();
      expect(row.idempotencyKey.startsWith(`${created.id}:`)).toBe(true);
      expect(row.idempotencyKey).not.toContain("{{");
      expect(row.idempotencyKey.split(":")[1]).not.toBe("");
      expect(row.status).toBe("sent");
    }

    // Per-recipient personalisation came from the contact row, not the
    // campaign — Alice's plan is hers, not Bob's.
    const aliceSend = provider.sends.find((s) => s.to === "alice@example.com")!;
    expect(aliceSend.subject).toBe("Hi Alice");
    expect(aliceSend.html).toContain("your plan is pro");
    expect(aliceSend.from).toBe("Acme <news@loopkit.dev>");

    // A resumed drain must not send anything a second time.
    const second = await drainCampaign(db, created.id, starter, { batchSize: 10 });
    expect(second.queued).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(provider.sends).toHaveLength(2);

    await syncCampaignRecipientStatuses(db, created.id);
    const stats = await getCampaignStats(db, created.id);
    expect(stats.recipients).toBe(2);
    expect(stats.providerAccepted).toBe(2);
    expect(stats.failed).toBe(0);

    const recipients = await listCampaignRecipients(db, { campaignId: created.id, pageSize: 10 });
    expect(recipients.recipients.map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(recipients.recipients.find((r) => r.contactId === alice.id)?.sentAt).not.toBeNull();
  }, 40_000);

  it("recovers an interrupted campaign without re-sending what already went out", async () => {
    for (const name of ["eve", "frank", "grace"]) {
      await upsertContact(db, {
        workspaceId: "ws-1",
        email: `${name}@example.com`,
        properties: { firstName: name },
      });
    }

    const { audience } = await createAudience(db, {
      workspaceId: "ws-1",
      name: "everyone",
      filter: {
        op: "and",
        children: [{ kind: "condition", field: "subscribed", operator: "exists" }],
      },
    });
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Interrupted",
      templateId: "tpl-1",
      audienceId: audience.id,
    });
    await launchCampaign(db, "ws-1", created.id);
    await engine.ctx.engine.register(
      buildCampaignWorkflow({ campaignId: created.id, name: created.name, templateId: "tpl-1" }),
    );

    let startedRecipients = 0;
    const starter = async (input: {
      campaignId: string;
      recipientId: string;
      contactId: string;
      email: string;
      workspaceId: string;
    }) => {
      const instanceId = await engine.ctx.engine.start(
        campaignWorkflowId(input.campaignId),
        campaignSendContext(input),
      );
      startedRecipients += 1;
      // Pause the campaign right after the first recipient is queued. This
      // is what `drainCampaign` actually checks between batches, so it
      // reproduces a real interruption (a kill -9 looks the same to the
      // drain: rows already started stay started, the rest stay pending).
      // A small batchSize alone would NOT interrupt anything — the drain
      // loops until nothing is pending by design.
      if (startedRecipients === 1) {
        await setCampaignStatus(db, "ws-1", input.campaignId, "paused");
      }
      return { instanceId };
    };

    const partial = await drainCampaign(db, created.id, starter, { batchSize: 1 });
    expect(partial.status).toBe("paused");
    expect(partial.remaining).toBe(2);

    // Resume: flip the campaign back to queued and drain the remainder. The
    // recipient already started must not be started a second time.
    await requeuePausedCampaign(db, "ws-1", created.id);
    let resumedStarts = 0;
    const resumeStarter = async (input: {
      campaignId: string;
      recipientId: string;
      contactId: string;
      email: string;
      workspaceId: string;
    }) => {
      resumedStarts += 1;
      return {
        instanceId: await engine.ctx.engine.start(
          campaignWorkflowId(input.campaignId),
          campaignSendContext(input),
        ),
      };
    };
    const resumed = await drainCampaign(db, created.id, resumeStarter, { batchSize: 10 });
    expect(resumed.remaining).toBe(0);
    expect(resumedStarts).toBe(2); // only the two that had never been started
    await waitForSends(3);

    const rows = await db.select().from(emailSend);
    expect(rows).toHaveLength(3); // three recipients, three sends
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(3);
    expect(provider.sends).toHaveLength(3);
  }, 40_000);
});
