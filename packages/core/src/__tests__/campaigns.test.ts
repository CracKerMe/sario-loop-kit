import { campaign, contact, emailSend, emailTemplate, workspace } from "@loopkit/db/schema";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createAudience, updateAudience } from "../audiences";
import {
  CampaignStateError,
  createCampaign,
  deleteCampaign,
  drainCampaign,
  duplicateCampaign,
  finalizeCampaign,
  fireCampaignSchedule,
  getCampaign,
  getCampaignStats,
  launchCampaign,
  listCampaignRecipients,
  listDueCampaigns,
  refreshCampaignCounters,
  requeuePausedCampaign,
  scheduleCampaign,
  setCampaignStatus,
  syncCampaignRecipientStatuses,
  unscheduleCampaign,
  updateCampaign,
  type StartCampaignSend,
} from "../campaigns";
import { upsertContact } from "../contacts";
import { addSuppression } from "../suppressions";
import { resetTables, testDb } from "./testDb";

const db = testDb();

const EVERYONE = {
  op: "and" as const,
  children: [{ kind: "condition" as const, field: "subscribed", operator: "exists" as const }],
};

/**
 * A stand-in for the real `engine.start()` seam. Recording calls is what
 * makes the fan-out's idempotency observable: "was this recipient started
 * twice?" is the question the whole design is answering.
 */
function fakeStarter() {
  const started: string[] = [];
  const failing = new Set<string>();
  const starter: StartCampaignSend = async (input) => {
    if (failing.has(input.contactId)) throw new Error("engine.start failed");
    started.push(input.recipientId);
    return { instanceId: `inst-${input.recipientId}` };
  };
  return { starter, started, failing };
}

/** Mirrors what the email channel writes for a campaign send. */
async function seedSend(params: {
  workspaceId: string;
  campaignId: string;
  recipientId: string;
  contactId: string;
  status: "queued" | "sent" | "delivered" | "bounced" | "failed";
  error?: string;
}): Promise<void> {
  await db.insert(emailSend).values({
    id: crypto.randomUUID(),
    workspaceId: params.workspaceId,
    contactId: params.contactId,
    campaignId: params.campaignId,
    nodeId: params.recipientId,
    toEmail: `${params.contactId}@example.com`,
    subject: "Hello",
    provider: "fake",
    status: params.status,
    error: params.error,
    idempotencyKey: `${params.campaignId}:${params.recipientId}`,
    sentAt: params.status === "sent" ? new Date() : null,
  });
}

async function seedWorkspace(opts: { contacts?: number } = {}): Promise<void> {
  await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  await db.insert(emailTemplate).values({
    id: "tpl-1",
    workspaceId: "ws-1",
    name: "broadcast",
    subject: "Hello {{firstName}}",
    html: "<p>hi</p>",
  });
  const count = opts.contacts ?? 3;
  for (let i = 0; i < count; i++) {
    await upsertContact(db, {
      workspaceId: "ws-1",
      email: `user${i}@example.com`,
      properties: { firstName: `User${i}` },
    });
  }
}

async function seedAudience(filter: unknown = EVERYONE) {
  const { audience: created } = await createAudience(db, {
    workspaceId: "ws-1",
    name: "everyone",
    filter,
  });
  return created;
}

describe("campaign launch", () => {
  beforeEach(async () => {
    await resetTables(db);
    await seedWorkspace({ contacts: 5 });
  });

  it("materializes the audience once and freezes the filter", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Launch",
      templateId: "tpl-1",
      audienceId: aud.id,
    });

    const first = await launchCampaign(db, "ws-1", created.id);
    expect(first.campaign.status).toBe("queued");
    expect(first.recipients).toBe(5);
    expect(first.campaign.recipientCount).toBe(5);

    // Editing the saved segment AFTER launch must not change who this
    // campaign targets — that is the entire reason the filter is copied.
    await updateAudience(db, "ws-1", aud.id, {
      filter: { kind: "condition", field: "email", operator: "starts_with", value: "user0" },
    });

    const { recipients } = await listCampaignRecipients(db, { campaignId: created.id });
    expect(recipients).toHaveLength(5);
    expect(recipients.map((r) => r.email).sort()).toEqual([
      "user0@example.com",
      "user1@example.com",
      "user2@example.com",
      "user3@example.com",
      "user4@example.com",
    ]);
  });

  it("is idempotent — a double-clicked launch does not double-materialize", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Launch",
      templateId: "tpl-1",
      audienceId: aud.id,
    });

    await launchCampaign(db, "ws-1", created.id);
    const second = await launchCampaign(db, "ws-1", created.id);

    expect(second.recipients).toBe(0); // nothing new inserted
    expect(second.campaign.recipientCount).toBe(5);

    const { total } = await listCampaignRecipients(db, { campaignId: created.id });
    expect(total).toBe(5); // the unique (campaignId, contactId) index held
  });

  it("excludes unsubscribed and suppressed contacts, and reports the exclusion", async () => {
    const contacts = await db.select().from(contact).orderBy(contact.email);
    const optedOut = contacts[0]!;
    const bounced = contacts[1]!;

    await db.update(contact).set({ subscribed: false }).where(eq(contact.id, optedOut.id));
    await addSuppression(db, {
      workspaceId: "ws-1",
      email: bounced.email,
      reason: "hard_bounce",
    });

    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Launch",
      templateId: "tpl-1",
      audienceId: aud.id,
    });

    const result = await launchCampaign(db, "ws-1", created.id);
    expect(result.campaign.audienceMemberCount).toBe(5);
    expect(result.campaign.audienceSendableCount).toBe(3);
    expect(result.excludedUnsendable).toBe(2);
    expect(result.campaign.recipientCount).toBe(3);
  });

  it("refuses to launch without a template or an audience", async () => {
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "No audience",
      templateId: "tpl-1",
    });
    await expect(launchCampaign(db, "ws-1", created.id)).rejects.toThrow(CampaignStateError);

    const aud = await seedAudience();
    const noTemplate = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "No template",
      audienceId: aud.id,
    });
    await expect(launchCampaign(db, "ws-1", noTemplate.id)).rejects.toThrow(/no template/);
  });

  it("refuses to re-launch an already sent or cancelled campaign", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Launch",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await launchCampaign(db, "ws-1", created.id);
    await db.update(campaign).set({ status: "sent" }).where(eq(campaign.id, created.id));

    await expect(launchCampaign(db, "ws-1", created.id)).rejects.toThrow(/duplicate it/);
  });
});

describe("campaign scheduling", () => {
  beforeEach(async () => {
    await resetTables(db);
    await seedWorkspace({ contacts: 5 });
  });

  function future(ms = 60_000): Date {
    return new Date(Date.now() + ms);
  }

  it("materializes the audience and lands on scheduled, not queued", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Later",
      templateId: "tpl-1",
      audienceId: aud.id,
    });

    const result = await scheduleCampaign(db, "ws-1", created.id, future());
    expect(result.campaign.status).toBe("scheduled");
    expect(result.campaign.scheduledAt).not.toBeNull();
    expect(result.recipients).toBe(5);

    // Materialized like launchCampaign — filter frozen, recipients present —
    // just not drained yet.
    const { total } = await listCampaignRecipients(db, { campaignId: created.id });
    expect(total).toBe(5);
  });

  it("refuses a scheduledAt in the past", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Too late",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await expect(
      scheduleCampaign(db, "ws-1", created.id, new Date(Date.now() - 1000)),
    ).rejects.toThrow(CampaignStateError);
  });

  it("listDueCampaigns returns only scheduled campaigns whose time has come", async () => {
    const aud = await seedAudience();
    const due = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Due",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    const notYet = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Not yet",
      templateId: "tpl-1",
      audienceId: aud.id,
    });

    await scheduleCampaign(db, "ws-1", due.id, future(60_000));
    await scheduleCampaign(db, "ws-1", notYet.id, future(3_600_000));
    // Force the "due" one's scheduledAt into the past, as if time had
    // elapsed since scheduling — scheduleCampaign itself refuses a past
    // time, so the poller's exact query is exercised by mutating directly.
    await db
      .update(campaign)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(campaign.id, due.id));

    const result = await listDueCampaigns(db, 10);
    expect(result.map((c) => c.id)).toEqual([due.id]);
  });

  it("fireCampaignSchedule flips scheduled to queued without re-resolving the audience", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Later",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await scheduleCampaign(db, "ws-1", created.id, future());

    // Editing the saved segment after scheduling must not change who fires —
    // same freeze-at-commit guarantee as launchCampaign.
    await updateAudience(db, "ws-1", aud.id, {
      filter: { kind: "condition", field: "email", operator: "starts_with", value: "user0" },
    });

    const fired = await fireCampaignSchedule(db, created.id);
    expect(fired?.status).toBe("queued");
    expect(fired?.scheduledAt).toBeNull();

    const { total } = await listCampaignRecipients(db, { campaignId: created.id });
    expect(total).toBe(5); // unchanged by the audience edit
  });

  it("fireCampaignSchedule is a no-op for a campaign that is not scheduled", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Draft",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    const result = await fireCampaignSchedule(db, created.id);
    expect(result).toBeNull();
  });

  it("unscheduleCampaign reverts to draft and clears scheduledAt", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Later",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await scheduleCampaign(db, "ws-1", created.id, future());

    const reverted = await unscheduleCampaign(db, "ws-1", created.id);
    expect(reverted?.status).toBe("draft");
    expect(reverted?.scheduledAt).toBeNull();
  });

  it("unscheduleCampaign refuses a campaign that is not scheduled", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Draft",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await expect(unscheduleCampaign(db, "ws-1", created.id)).rejects.toThrow(CampaignStateError);
  });

  it("setCampaignStatus can cancel a scheduled campaign directly", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Later",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await scheduleCampaign(db, "ws-1", created.id, future());

    const cancelled = await setCampaignStatus(db, "ws-1", created.id, "cancelled");
    expect(cancelled?.status).toBe("cancelled");
  });

  it("setCampaignStatus refuses to pause a scheduled campaign (nothing is draining yet)", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Later",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await scheduleCampaign(db, "ws-1", created.id, future());

    await expect(setCampaignStatus(db, "ws-1", created.id, "paused")).rejects.toThrow(
      CampaignStateError,
    );
  });
});

describe("campaign drain", () => {
  beforeEach(async () => {
    await resetTables(db);
    await seedWorkspace({ contacts: 12 });
  });

  async function launch(contracts = 12) {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Blast",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await launchCampaign(db, "ws-1", created.id);
    const { recipients } = await listCampaignRecipients(db, {
      campaignId: created.id,
      pageSize: 100,
    });
    return { campaignId: created.id, recipients, expected: contracts };
  }

  it("starts exactly one instance per recipient", async () => {
    const { campaignId, recipients, expected } = await launch();
    const { starter, started } = fakeStarter();

    const result = await drainCampaign(db, campaignId, starter, { batchSize: 5 });

    expect(started).toHaveLength(expected);
    expect(new Set(started).size).toBe(expected); // no recipient started twice
    expect(result.queued).toBe(expected);
    expect(result.remaining).toBe(0);
    expect(result.failed).toBe(0);

    const rows = await listCampaignRecipients(db, { campaignId, pageSize: 100 });
    expect(rows.recipients.every((r) => r.status === "queued")).toBe(true);
    expect(rows.recipients.every((r) => r.instanceId?.startsWith("inst-"))).toBe(true);
    expect(recipients).toHaveLength(expected);
  });

  it("is resumable — a second drain over a drained campaign starts nothing", async () => {
    const { campaignId } = await launch();
    const first = fakeStarter();
    await drainCampaign(db, campaignId, first.starter, { batchSize: 5 });

    // Simulates the crash-recovery path: nothing is left pending, so a
    // resumed drain must be a no-op rather than a second broadcast.
    const second = fakeStarter();
    const result = await drainCampaign(db, campaignId, second.starter, { batchSize: 5 });

    expect(second.started).toHaveLength(0);
    expect(result.queued).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it("stops mid-drain on a pause and resumes exactly where it stopped", async () => {
    const { campaignId, recipients } = await launch();

    // Pausing from inside the starter is what an interrupted drain looks like
    // from the drain's perspective: the recipients already started stay
    // started, the rest stay pending. (A plain small batchSize would NOT test
    // this — drainCampaign loops until nothing is pending, which is why a
    // 12-recipient campaign drains fully even at batchSize 4.)
    const partial = fakeStarter();
    const pausingStarter: StartCampaignSend = async (input) => {
      const result = await partial.starter(input);
      if (partial.started.length === 4) {
        await setCampaignStatus(db, "ws-1", campaignId, "paused");
      }
      return result;
    };

    const first = await drainCampaign(db, campaignId, pausingStarter, { batchSize: 5 });
    expect(first.status).toBe("paused");
    expect(partial.started).toHaveLength(5); // the in-flight batch finished
    expect(first.remaining).toBe(recipients.length - 5);

    const midRows = await listCampaignRecipients(db, { campaignId, pageSize: 100 });
    expect(midRows.recipients.filter((r) => r.status === "queued")).toHaveLength(5);
    expect(midRows.recipients.filter((r) => r.status === "pending")).toHaveLength(7);

    await requeuePausedCampaign(db, "ws-1", campaignId);
    const rest = fakeStarter();
    const second = await drainCampaign(db, campaignId, rest.starter, { batchSize: 5 });

    expect(second.remaining).toBe(0);
    expect(rest.started).toHaveLength(recipients.length - 5);

    // Union of both passes covers every recipient exactly once.
    const all = [...partial.started, ...rest.started];
    expect(new Set(all).size).toBe(recipients.length);
    expect(all.sort()).toEqual(recipients.map((r) => r.id).sort());
  });

  it("isolates a per-recipient start failure instead of stranding the rest", async () => {
    const { campaignId, recipients } = await launch();
    const { starter, started, failing } = fakeStarter();
    const doomed = recipients[2]!;
    failing.add(doomed.contactId);

    const result = await drainCampaign(db, campaignId, starter, { batchSize: 5 });

    expect(result.failed).toBe(1);
    expect(result.queued).toBe(recipients.length - 1);
    expect(started).toHaveLength(recipients.length - 1);

    const rows = await listCampaignRecipients(db, { campaignId, pageSize: 100 });
    const failedRow = rows.recipients.find((r) => r.id === doomed.id);
    expect(failedRow?.status).toBe("failed");
    expect(failedRow?.error).toContain("engine.start failed");
  });

  it("stops draining when the campaign is paused", async () => {
    const { campaignId } = await launch();
    await setCampaignStatus(db, "ws-1", campaignId, "paused");

    const { starter, started } = fakeStarter();
    const result = await drainCampaign(db, campaignId, starter, { batchSize: 5 });

    expect(started).toHaveLength(0);
    expect(result.status).toBe("paused");
    expect(result.remaining).toBe(12);

    // Un-pausing makes the same recipients drainable — nothing was lost.
    await requeuePausedCampaign(db, "ws-1", campaignId);
    const resumed = fakeStarter();
    const after = await drainCampaign(db, campaignId, resumed.starter, { batchSize: 100 });
    expect(resumed.started).toHaveLength(12);
    expect(after.remaining).toBe(0);
  });
});

describe("campaign send reconciliation", () => {
  beforeEach(async () => {
    await resetTables(db);
    await seedWorkspace({ contacts: 4 });
  });

  async function launchWithRecipients() {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Blast",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await launchCampaign(db, "ws-1", created.id);
    const { recipients } = await listCampaignRecipients(db, {
      campaignId: created.id,
      pageSize: 100,
    });
    return { campaignId: created.id, recipients };
  }

  it("derives recipient status from the email_send row, not from assumption", async () => {
    const { campaignId, recipients } = await launchWithRecipients();
    const { starter } = fakeStarter();
    await drainCampaign(db, campaignId, starter, { batchSize: 10 });

    // The engine executes asynchronously, so the sends land after the drain.
    await seedSend({
      workspaceId: "ws-1",
      campaignId,
      recipientId: recipients[0]!.id,
      contactId: recipients[0]!.contactId,
      status: "sent",
    });
    await seedSend({
      workspaceId: "ws-1",
      campaignId,
      recipientId: recipients[1]!.id,
      contactId: recipients[1]!.contactId,
      status: "delivered",
    });
    await seedSend({
      workspaceId: "ws-1",
      campaignId,
      recipientId: recipients[2]!.id,
      contactId: recipients[2]!.contactId,
      status: "bounced",
    });
    await seedSend({
      workspaceId: "ws-1",
      campaignId,
      recipientId: recipients[3]!.id,
      contactId: recipients[3]!.contactId,
      status: "failed",
      error: "provider rejected",
    });

    await syncCampaignRecipientStatuses(db, campaignId);

    const rows = await listCampaignRecipients(db, { campaignId, pageSize: 100 });
    const byId = Object.fromEntries(rows.recipients.map((r) => [r.id, r]));
    expect(byId[recipients[0]!.id]?.status).toBe("sent");
    expect(byId[recipients[1]!.id]?.status).toBe("sent");
    expect(byId[recipients[2]!.id]?.status).toBe("failed");
    expect(byId[recipients[3]!.id]?.status).toBe("failed");
    expect(byId[recipients[3]!.id]?.error).toBe("provider rejected");
    expect(byId[recipients[0]!.id]?.emailSendId).not.toBeNull();
  });

  it("leaves a recipient queued while its send is still in flight", async () => {
    const { campaignId, recipients } = await launchWithRecipients();
    const { starter } = fakeStarter();
    await drainCampaign(db, campaignId, starter, { batchSize: 10 });

    await seedSend({
      workspaceId: "ws-1",
      campaignId,
      recipientId: recipients[0]!.id,
      contactId: recipients[0]!.contactId,
      status: "queued",
    });
    await syncCampaignRecipientStatuses(db, campaignId);

    const rows = await listCampaignRecipients(db, { campaignId, pageSize: 100 });
    expect(rows.recipients.find((r) => r.id === recipients[0]!.id)?.status).toBe("queued");
  });

  it("only marks the campaign sent once every recipient is terminal", async () => {
    const { campaignId, recipients } = await launchWithRecipients();
    const { starter } = fakeStarter();
    await drainCampaign(db, campaignId, starter, { batchSize: 10 });

    // Still one in flight → not sent.
    for (const recipient of recipients.slice(0, 3)) {
      await seedSend({
        workspaceId: "ws-1",
        campaignId,
        recipientId: recipient.id,
        contactId: recipient.contactId,
        status: "sent",
      });
    }
    await seedSend({
      workspaceId: "ws-1",
      campaignId,
      recipientId: recipients[3]!.id,
      contactId: recipients[3]!.contactId,
      status: "queued",
    });
    await syncCampaignRecipientStatuses(db, campaignId);
    expect(await finalizeCampaign(db, campaignId, 0)).toBe("sending");

    // Last one completes → sent, with a completedAt.
    await db
      .update(emailSend)
      .set({ status: "delivered" })
      .where(eq(emailSend.nodeId, recipients[3]!.id));
    await syncCampaignRecipientStatuses(db, campaignId);
    expect(await finalizeCampaign(db, campaignId, 0)).toBe("sent");

    const row = await getCampaign(db, "ws-1", campaignId);
    expect(row?.status).toBe("sent");
    expect(row?.completedAt).not.toBeNull();
  });

  it("rolls recipient states up into campaign counters", async () => {
    const { campaignId, recipients } = await launchWithRecipients();
    const { starter } = fakeStarter();
    await drainCampaign(db, campaignId, starter, { batchSize: 10 });
    for (const [index, recipient] of recipients.entries()) {
      await seedSend({
        workspaceId: "ws-1",
        campaignId,
        recipientId: recipient.id,
        contactId: recipient.contactId,
        status: index === 0 ? "failed" : "delivered",
      });
    }
    await syncCampaignRecipientStatuses(db, campaignId);
    await refreshCampaignCounters(db, campaignId);

    const row = await getCampaign(db, "ws-1", campaignId);
    expect(row?.sentCount).toBe(3);
    expect(row?.failedCount).toBe(1);
    expect(row?.queuedCount).toBe(0);
    expect(row?.recipientCount).toBe(4);
  });

  it("reports from both sources — intent (recipients) and outcome (sends)", async () => {
    const { campaignId, recipients } = await launchWithRecipients();
    const { starter } = fakeStarter();
    await drainCampaign(db, campaignId, starter, { batchSize: 10 });
    for (const recipient of recipients) {
      await seedSend({
        workspaceId: "ws-1",
        campaignId,
        recipientId: recipient.id,
        contactId: recipient.contactId,
        status: "delivered",
      });
    }

    const stats = await getCampaignStats(db, campaignId);
    expect(stats.recipients).toBe(4);
    expect(stats.delivered).toBe(0); // no email_delivery rows seeded
    expect(stats.providerAccepted).toBe(4);
    expect(stats.failed).toBe(0);
  });
});

describe("campaign state machine", () => {
  beforeEach(async () => {
    await resetTables(db);
    await seedWorkspace({ contacts: 3 });
  });

  it("only allows edits while the campaign is a draft", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Draft",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    const updated = await updateCampaign(db, "ws-1", created.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");

    await launchCampaign(db, "ws-1", created.id);
    await expect(updateCampaign(db, "ws-1", created.id, { name: "Nope" })).rejects.toThrow(
      /only a draft can be edited/,
    );
  });

  it("refuses to delete a sending campaign but allows a draft", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Draft",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    expect(await deleteCampaign(db, "ws-1", created.id)).toBe(true);

    const second = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Sending",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await launchCampaign(db, "ws-1", second.id);
    await db.update(campaign).set({ status: "sending" }).where(eq(campaign.id, second.id));
    await expect(deleteCampaign(db, "ws-1", second.id)).rejects.toThrow(CampaignStateError);
  });

  it("duplicates a sent campaign rather than re-running it", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Original",
      templateId: "tpl-1",
      audienceId: aud.id,
      subject: "Hi",
    });
    await launchCampaign(db, "ws-1", created.id);
    await db.update(campaign).set({ status: "sent" }).where(eq(campaign.id, created.id));

    const copy = await duplicateCampaign(db, "ws-1", created.id);
    expect(copy?.name).toBe("Original (copy)");
    expect(copy?.status).toBe("draft");
    expect(copy?.subject).toBe("Hi");
    // The copy must NOT inherit the frozen filter or the recipient list.
    expect(copy?.filter).toBeNull();
    const rows = await listCampaignRecipients(db, { campaignId: copy!.id });
    expect(rows.total).toBe(0);
  });

  it("scopes everything to the workspace", async () => {
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Mine",
      templateId: "tpl-1",
      audienceId: aud.id,
    });

    expect(await getCampaign(db, "ws-2", created.id)).toBeNull();
    // A foreign campaign id must read as "not found", never as a partial
    // success on someone else's row.
    await expect(setCampaignStatus(db, "ws-2", created.id, "paused")).resolves.toBeNull();
    expect(await deleteCampaign(db, "ws-2", created.id)).toBe(false);
  });

  it("cancels and clears completedAt only on cancel, not on pause", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Cancel me",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await launchCampaign(db, "ws-1", created.id);

    const paused = await setCampaignStatus(db, "ws-1", created.id, "paused");
    expect(paused?.status).toBe("paused");
    expect(paused?.completedAt).toBeNull();

    const cancelled = await setCampaignStatus(db, "ws-1", created.id, "cancelled");
    expect(cancelled?.status).toBe("cancelled");
  });
});

describe("campaign idempotency at the send layer", () => {
  beforeEach(async () => {
    await resetTables(db);
    await seedWorkspace({ contacts: 2 });
  });

  it("keys email_send on (campaignId, recipientId) so a duplicate start is a no-op", async () => {
    const aud = await seedAudience();
    const created = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "Blast",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    await launchCampaign(db, "ws-1", created.id);
    const { recipients } = await listCampaignRecipients(db, {
      campaignId: created.id,
      pageSize: 10,
    });
    const recipient = recipients[0]!;

    const insert = (id: string) =>
      db
        .insert(emailSend)
        .values({
          id,
          workspaceId: "ws-1",
          contactId: recipient.contactId,
          campaignId: created.id,
          nodeId: recipient.id,
          toEmail: recipient.email,
          subject: "Hi",
          provider: "fake",
          status: "queued",
          idempotencyKey: `${created.id}:${recipient.id}`,
        })
        .onConflictDoNothing({ target: [emailSend.workspaceId, emailSend.idempotencyKey] })
        .returning({ id: emailSend.id });

    const first = await insert(crypto.randomUUID());
    const second = await insert(crypto.randomUUID()); // a replayed drain

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // the unique index is the guard

    const rows = await db
      .select()
      .from(emailSend)
      .where(and(eq(emailSend.campaignId, created.id), eq(emailSend.nodeId, recipient.id)));
    expect(rows).toHaveLength(1);
  });

  it("keeps two campaigns to the same contact independent", async () => {
    const aud = await seedAudience();
    const a = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "A",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    const b = await createCampaign(db, {
      workspaceId: "ws-1",
      name: "B",
      templateId: "tpl-1",
      audienceId: aud.id,
    });
    for (const created of [a, b]) {
      await launchCampaign(db, "ws-1", created.id);
      const { recipients } = await listCampaignRecipients(db, {
        campaignId: created.id,
        pageSize: 10,
      });
      await seedSend({
        workspaceId: "ws-1",
        campaignId: created.id,
        recipientId: recipients[0]!.id,
        contactId: recipients[0]!.contactId,
        status: "sent",
      });
    }

    const rows = await db.select().from(emailSend);
    expect(rows).toHaveLength(2); // same contact, same workspace, both sent
    expect(new Set(rows.map((r) => r.campaignId)).size).toBe(2);
  });
});
