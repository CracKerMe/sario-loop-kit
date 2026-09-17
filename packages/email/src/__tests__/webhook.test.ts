import { contact, contactEvent, emailDelivery, emailSend, workspace } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { processEmailWebhook } from "../webhook";
import { FakeEmailProvider } from "./fakeProvider";
import { resetTables, testDb } from "./testDb";

const db = testDb();

async function seedSend(overrides: Partial<typeof emailSend.$inferInsert> = {}) {
  await db
    .insert(workspace)
    .values({ id: "ws-1", name: "test", slug: "test-ws" })
    .onConflictDoNothing();
  await db
    .insert(contact)
    .values({ id: "contact-1", workspaceId: "ws-1", email: "sam@example.com" })
    .onConflictDoNothing();
  await db.insert(emailSend).values({
    id: "send-1",
    workspaceId: "ws-1",
    contactId: "contact-1",
    toEmail: "sam@example.com",
    subject: "Welcome",
    provider: "fake",
    status: "sent",
    providerMessageId: "msg-1",
    idempotencyKey: "inst-1:node-1",
    ...overrides,
  });
}

describe("processEmailWebhook", () => {
  let provider: FakeEmailProvider;

  beforeEach(async () => {
    await resetTables(db);
    provider = new FakeEmailProvider();
  });

  it("advances email_send status to delivered and emits a contact_event", async () => {
    await seedSend();
    provider.queueWebhookEvent({
      providerEventId: "evt-1",
      providerMessageId: "msg-1",
      type: "delivered",
      occurredAt: new Date(),
      raw: {},
    });

    await processEmailWebhook(db, provider, { body: "{}", headers: {} });

    const [send] = await db.select().from(emailSend).where(eq(emailSend.id, "send-1"));
    expect(send?.status).toBe("delivered");

    const events = await db
      .select()
      .from(contactEvent)
      .where(eq(contactEvent.contactId, "contact-1"));
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("email.delivered");
  });

  it("suppresses the contact on a hard bounce and sets email_send status to bounced", async () => {
    await seedSend();
    provider.queueWebhookEvent({
      providerEventId: "evt-bounce",
      providerMessageId: "msg-1",
      type: "bounced",
      occurredAt: new Date(),
      raw: {},
    });

    await processEmailWebhook(db, provider, { body: "{}", headers: {} });

    const [send] = await db.select().from(emailSend).where(eq(emailSend.id, "send-1"));
    expect(send?.status).toBe("bounced");

    const [c] = await db.select().from(contact).where(eq(contact.id, "contact-1"));
    expect(c?.subscribed).toBe(false);
  });

  it("does not regress a bounced status when a later 'delivered' event arrives out of order", async () => {
    await seedSend({ status: "bounced" });
    provider.queueWebhookEvent({
      providerEventId: "evt-late-delivered",
      providerMessageId: "msg-1",
      type: "delivered",
      occurredAt: new Date(),
      raw: {},
    });

    await processEmailWebhook(db, provider, { body: "{}", headers: {} });

    const [send] = await db.select().from(emailSend).where(eq(emailSend.id, "send-1"));
    expect(send?.status).toBe("bounced"); // must not be overwritten back to "delivered"
  });

  it("dedups by providerEventId — a redelivered webhook is a no-op", async () => {
    await seedSend();
    const event = {
      providerEventId: "evt-replay",
      providerMessageId: "msg-1",
      type: "opened" as const,
      occurredAt: new Date(),
      raw: {},
    };
    provider.queueWebhookEvent(event);
    await processEmailWebhook(db, provider, { body: "{}", headers: {} });
    // Same event delivered again (provider redelivery, or our own replay).
    await processEmailWebhook(db, provider, { body: "{}", headers: {} });

    const deliveries = await db
      .select()
      .from(emailDelivery)
      .where(eq(emailDelivery.providerEventId, "evt-replay"));
    expect(deliveries).toHaveLength(1);

    const events = await db
      .select()
      .from(contactEvent)
      .where(eq(contactEvent.contactId, "contact-1"));
    expect(events).toHaveLength(1); // not emitted twice
  });

  it("ignores an event for a providerMessageId with no matching email_send row", async () => {
    provider.queueWebhookEvent({
      providerEventId: "evt-orphan",
      providerMessageId: "msg-does-not-exist",
      type: "delivered",
      occurredAt: new Date(),
      raw: {},
    });

    // Must not throw — a transactional/out-of-band send outside Loopkit
    // can legitimately produce webhook events with no local record.
    await expect(
      processEmailWebhook(db, provider, { body: "{}", headers: {} }),
    ).resolves.not.toThrow();
  });

  it("records a click event's URL in the contact_event properties", async () => {
    await seedSend();
    provider.queueWebhookEvent({
      providerEventId: "evt-click",
      providerMessageId: "msg-1",
      type: "clicked",
      url: "https://example.com/promo",
      occurredAt: new Date(),
      raw: {},
    });

    await processEmailWebhook(db, provider, { body: "{}", headers: {} });

    const [event] = await db
      .select()
      .from(contactEvent)
      .where(eq(contactEvent.contactId, "contact-1"));
    expect(event?.properties).toMatchObject({ url: "https://example.com/promo" });
  });
});
