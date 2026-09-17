import { contact, emailSend, emailTemplate, workspace } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createEmailNotificationChannel, type EmailNodeData } from "../channel";
import { FakeEmailProvider } from "./fakeProvider";
import { resetTables, testDb } from "./testDb";

const db = testDb();

async function seedWorkspaceContactAndTemplate() {
  await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "test-ws" });
  await db
    .insert(contact)
    .values({ id: "contact-1", workspaceId: "ws-1", email: "sam@example.com" });
  await db.insert(emailTemplate).values({
    id: "tpl-1",
    workspaceId: "ws-1",
    name: "welcome",
    subject: "Welcome!",
    html: "<p>Hi {{firstName}}!</p>",
    fromEmail: "hello@loopkit.dev",
    fromName: "Loopkit",
  });
}

function nodeData(overrides: Partial<EmailNodeData> = {}): EmailNodeData {
  return {
    workspaceId: "ws-1",
    contactId: "contact-1",
    templateId: "tpl-1",
    instanceId: "inst-1",
    nodeId: "node-1",
    firstName: "Sam",
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

    const [row] = await db.select().from(emailSend).where(eq(emailSend.instanceId, "inst-1"));
    expect(row?.status).toBe("sent");
    expect(row?.providerMessageId).toBe("fake_msg_0");
  });

  it("is idempotent: a retry with the same instanceId:nodeId sends exactly once", async () => {
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

    const rows = await db.select().from(emailSend).where(eq(emailSend.instanceId, "inst-1"));
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

    const [row] = await db.select().from(emailSend).where(eq(emailSend.instanceId, "inst-1"));
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

    const [row] = await db.select().from(emailSend).where(eq(emailSend.instanceId, "inst-1"));
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
      data: { instanceId: "inst-1" }, // missing nodeId/contactId/templateId/workspaceId
    });

    expect(result.ok).toBe(false);
    expect(provider.sends).toHaveLength(0);
  });
});
