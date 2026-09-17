import {
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
    expect(result.detail).toBe("suppressed");
    expect(provider.sends).toHaveLength(0);

    const [row] = await db.select().from(emailSend).where(eq(emailSend.journeyRunId, "run-1"));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("contact unsubscribed");
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
