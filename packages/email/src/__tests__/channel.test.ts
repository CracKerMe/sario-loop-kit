import { addSuppression } from "@loopkit/core";
import {
  campaign,
  contact,
  emailSend,
  emailTemplate,
  journey,
  journeyRun,
  workspace,
} from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createEmailNotificationChannel, type EmailNodeData } from "../channel";
import { FakeEmailProvider } from "./fakeProvider";
import { resetTables, testDb } from "./testDb";

const db = testDb();

/**
 * Seeds a real journey_run row for "run-1" — email_send.journey_run_id
 * has a real FK to journey_run (it's load-bearing for idempotency, see
 * channel.ts's doc comment, so the schema keeps it a genuine foreign
 * key rather than a loose correlation string). In production this row
 * always exists by the time the channel runs — @loopkit/core's
 * startJourneyRun() creates it before engine.start() is ever called.
 */
async function seedWorkspaceContactAndTemplate() {
  await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "test-ws" });
  await db.insert(contact).values({
    id: "contact-1",
    workspaceId: "ws-1",
    email: "sam@example.com",
    properties: { firstName: "Sam" },
  });
  await db.insert(emailTemplate).values({
    id: "tpl-1",
    workspaceId: "ws-1",
    name: "welcome",
    subject: "Welcome!",
    html: "<p>Hi {{firstName}}!</p>",
    fromEmail: "hello@loopkit.dev",
    fromName: "Loopkit",
  });
  await db.insert(journey).values({
    id: "journey-1",
    workspaceId: "ws-1",
    name: "test journey",
    workflowId: "wf-journey-1",
    trigger: { kind: "manual" },
  });
  await db.insert(journeyRun).values({
    id: "run-1",
    workspaceId: "ws-1",
    journeyId: "journey-1",
    journeyVersion: 1,
    contactId: "contact-1",
    instanceId: "inst-run-1",
    status: "running",
  });
}

function nodeData(overrides: Partial<EmailNodeData> = {}): EmailNodeData {
  return {
    workspaceId: "ws-1",
    contactId: "contact-1",
    templateId: "tpl-1",
    journeyRunId: "run-1",
    nodeId: "node-1",
    ...overrides,
  };
}

describe("createEmailNotificationChannel", () => {
  let provider: FakeEmailProvider;

  beforeEach(async () => {
    await resetTables(db);
    await seedWorkspaceContactAndTemplate();
    provider = new FakeEmailProvider();
  });

  it("sends the rendered template and records email_send as sent", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    const result = await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    expect(result.ok).toBe(true);
    expect(provider.sends).toHaveLength(1);
    expect(provider.sends[0]?.html).toBe("<p>Hi Sam!</p>");
    expect(provider.sends[0]?.from).toBe("Loopkit <hello@loopkit.dev>");
    expect(provider.sends[0]?.to).toBe("sam@example.com");

    const [row] = await db.select().from(emailSend).where(eq(emailSend.journeyRunId, "run-1"));
    expect(row?.status).toBe("sent");
    expect(row?.providerMessageId).toBe("fake_msg_0");
  });

  it("falls back to the template's own subject when the journey node didn't set one", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    // No `subject` on the message — NotificationNodeConfig.subject was
    // left unset on the journey's email node.
    await channel.send({ target: "sam@example.com", body: "template:tpl-1", data: nodeData() });

    expect(provider.sends[0]?.subject).toBe("Welcome!"); // tpl-1's own subject
  });

  it("prefers the journey node's own subject over the template's when both are set", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    await channel.send({
      target: "sam@example.com",
      subject: "Custom subject!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    expect(provider.sends[0]?.subject).toBe("Custom subject!");
  });

  it("resolves {{firstName}} from the contact's own properties, not from node data", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    // nodeData() carries no firstName at all — it comes from the
    // contact row loaded at send time.
    await channel.send({ target: "sam@example.com", body: "template:tpl-1", data: nodeData() });

    expect(provider.sends[0]?.html).toBe("<p>Hi Sam!</p>");
  });

  it("is idempotent: a retry with the same journeyRunId:nodeId sends exactly once", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });
    const message = {
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    };

    const first = await channel.send(message);
    const second = await channel.send(message); // simulates the engine retrying the notification node

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.detail).toBe("duplicate-suppressed");
    expect(provider.sends).toHaveLength(1); // the provider was called exactly once

    const rows = await db.select().from(emailSend).where(eq(emailSend.journeyRunId, "run-1"));
    expect(rows).toHaveLength(1); // exactly one email_send row, not two
  });

  it("returns ok:true without calling the provider for an unsubscribed contact", async () => {
    await db.update(contact).set({ subscribed: false }).where(eq(contact.id, "contact-1"));
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    const result = await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    expect(result.ok).toBe(true); // suppression is NOT an engine failure — no DLQ noise
    expect(result.detail).toBe("unsubscribed");
    expect(provider.sends).toHaveLength(0);

    const [row] = await db.select().from(emailSend).where(eq(emailSend.journeyRunId, "run-1"));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("contact unsubscribed");
  });

  /**
   * P1.1's stated verification gate: "对已进抑制表的地址发信，断言零发送".
   *
   * Note the contact here is still `subscribed = true` — that is the whole
   * point. Address-level suppression has to hold independently of the
   * contact's own opt-out flag, because it is what survives the contact row
   * being deleted and re-imported.
   */
  it("never sends to a suppressed address, even when the contact is still subscribed", async () => {
    await addSuppression(db, {
      workspaceId: "ws-1",
      email: "sam@example.com",
      reason: "hard_bounce",
      source: "test",
    });
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    const result = await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    expect(result.ok).toBe(true); // a deliberate non-send is not a failure
    expect(result.detail).toBe("suppressed");
    expect(provider.sends).toHaveLength(0);

    const [row] = await db.select().from(emailSend).where(eq(emailSend.journeyRunId, "run-1"));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("address suppressed (hard_bounce)");
  });

  it("matches the suppression case-insensitively and ignores surrounding whitespace", async () => {
    await addSuppression(db, {
      workspaceId: "ws-1",
      email: "  SAM@Example.COM ",
      reason: "complaint",
      source: "test",
    });
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    const result = await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    expect(result.detail).toBe("suppressed");
    expect(provider.sends).toHaveLength(0);
  });

  it("scopes suppression to the workspace that recorded it", async () => {
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "other-ws" });
    await addSuppression(db, {
      workspaceId: "ws-2",
      email: "sam@example.com",
      reason: "hard_bounce",
      source: "test",
    });
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    const result = await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    expect(result.ok).toBe(true);
    expect(result.detail).not.toBe("suppressed");
    expect(provider.sends).toHaveLength(1);
  });

  it("sets RFC 8058 one-click List-Unsubscribe headers when a builder is wired", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
      buildUnsubscribe: (payload) => ({
        oneClickUrl: `https://api.example.com/v1/public/unsubscribe?token=${payload.contactId}`,
        mailtoUrl: "mailto:unsubscribe@example.com",
      }),
    });

    await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    const headers = provider.sends[0]?.headers ?? {};
    expect(headers["List-Unsubscribe"]).toBe(
      "<https://api.example.com/v1/public/unsubscribe?token=contact-1>, <mailto:unsubscribe@example.com>",
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("omits List-Unsubscribe entirely when no builder is wired", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    const headers = provider.sends[0]?.headers ?? {};
    // A header pointing at a 404 is worse than no header.
    expect(headers["List-Unsubscribe"]).toBeUndefined();
    expect(headers["List-Unsubscribe-Post"]).toBeUndefined();
    expect(headers["X-Loopkit-Send-Id"]).toBeTruthy();
  });

  it("keys a campaign send on (campaignId, nodeId) with no journeyRunId present", async () => {
    // email_send.campaign_id is a real FK, so the campaign must exist —
    // the same thing the campaign fan-out guarantees before it ever starts
    // a recipient's instance.
    await db.insert(campaign).values({
      id: "campaign-1",
      workspaceId: "ws-1",
      name: "September newsletter",
      templateId: "tpl-1",
    });

    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    // A campaign send carries campaignId and the recipient id as nodeId —
    // there is no journey_run row, and email_send.journey_run_id stays null.
    const campaignData: EmailNodeData = {
      workspaceId: "ws-1",
      contactId: "contact-1",
      templateId: "tpl-1",
      campaignId: "campaign-1",
      nodeId: "recipient-1",
    };
    const message = {
      target: "sam@example.com",
      subject: "Newsletter",
      body: "template:tpl-1",
      data: campaignData,
    };

    const first = await channel.send(message);
    const second = await channel.send(message); // a resumed drain, or a replay

    expect(first.ok).toBe(true);
    expect(first.detail).not.toBe("duplicate-suppressed");
    expect(second.detail).toBe("duplicate-suppressed");
    expect(provider.sends).toHaveLength(1);

    const rows = await db.select().from(emailSend).where(eq(emailSend.campaignId, "campaign-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe("campaign-1:recipient-1");
    expect(rows[0]?.journeyRunId).toBeNull();
    expect(rows[0]?.nodeId).toBe("recipient-1");
  });

  it("rejects a send with neither journeyRunId nor campaignId", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    const result = await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      // No run discriminator → no idempotency basis. A loud config error is
      // strictly better than a silent duplicate on the retry.
      data: { workspaceId: "ws-1", contactId: "contact-1", templateId: "tpl-1", nodeId: "node-1" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("journeyRunId");
    expect(result.error).toContain("campaignId");
    expect(provider.sends).toHaveLength(0);
    const rows = await db.select().from(emailSend);
    expect(rows).toHaveLength(0);
  });

  it("returns ok:false on a provider error, so the engine's retry/DLQ machinery engages", async () => {
    provider.shouldFail = true;
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    const result = await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("fake provider send failure");

    const [row] = await db.select().from(emailSend).where(eq(emailSend.journeyRunId, "run-1"));
    expect(row?.status).toBe("failed");
  });

  it("returns ok:false when the referenced template does not exist", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    const result = await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:does-not-exist",
      data: nodeData({ templateId: "does-not-exist" }),
    });

    expect(result.ok).toBe(false);
    expect(provider.sends).toHaveLength(0);
  });

  it("falls back to defaultFrom when the template has no fromEmail", async () => {
    await db
      .update(emailTemplate)
      .set({ fromEmail: null, fromName: null })
      .where(eq(emailTemplate.id, "tpl-1"));
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: nodeData(),
    });

    expect(provider.sends[0]?.from).toBe("fallback@loopkit.dev");
  });

  it("returns ok:false when required node data fields are missing", async () => {
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "fallback@loopkit.dev",
    });

    const result = await channel.send({
      target: "sam@example.com",
      subject: "Welcome!",
      body: "template:tpl-1",
      data: { journeyRunId: "run-1" }, // missing nodeId/contactId/templateId/workspaceId
    });

    expect(result.ok).toBe(false);
    expect(provider.sends).toHaveLength(0);
  });
});
