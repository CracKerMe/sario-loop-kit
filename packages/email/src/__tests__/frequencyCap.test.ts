import { contact, emailSend, workspace } from "@loopkit/db/schema";
import { beforeEach, describe, expect, it } from "vitest";

import { checkFrequencyCap } from "../frequencyCap";
import { resetTables, testDb } from "./testDb";

const db = testDb();

async function seedWorkspaceAndContact() {
  await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "test-ws" });
  await db.insert(contact).values({
    id: "contact-1",
    workspaceId: "ws-1",
    email: "sam@example.com",
  });
}

async function seedSend(createdAt: Date, id = crypto.randomUUID()): Promise<void> {
  await db.insert(emailSend).values({
    id,
    workspaceId: "ws-1",
    contactId: "contact-1",
    toEmail: "sam@example.com",
    subject: "Hi",
    provider: "fake",
    status: "sent",
    idempotencyKey: id,
    createdAt,
  });
}

describe("checkFrequencyCap", () => {
  beforeEach(async () => {
    await resetTables(db);
    await seedWorkspaceAndContact();
  });

  it("is unlimited when maxPerWindow is unset", async () => {
    for (let i = 0; i < 10; i++) await seedSend(new Date());
    const result = await checkFrequencyCap(db, {
      workspaceId: "ws-1",
      contactId: "contact-1",
      config: {},
    });
    expect(result.allowed).toBe(true);
    expect(result.sentInWindow).toBe(0); // short-circuits before counting
  });

  it("is unlimited when maxPerWindow is 0", async () => {
    for (let i = 0; i < 10; i++) await seedSend(new Date());
    const result = await checkFrequencyCap(db, {
      workspaceId: "ws-1",
      contactId: "contact-1",
      config: { maxPerWindow: 0 },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows sends under the cap", async () => {
    await seedSend(new Date());
    const result = await checkFrequencyCap(db, {
      workspaceId: "ws-1",
      contactId: "contact-1",
      config: { maxPerWindow: 3 },
    });
    expect(result.allowed).toBe(true);
    expect(result.sentInWindow).toBe(1);
  });

  it("blocks once the cap is reached", async () => {
    await seedSend(new Date());
    await seedSend(new Date());
    await seedSend(new Date());
    const result = await checkFrequencyCap(db, {
      workspaceId: "ws-1",
      contactId: "contact-1",
      config: { maxPerWindow: 3 },
    });
    expect(result.allowed).toBe(false);
    expect(result.sentInWindow).toBe(3);
  });

  it("only counts sends inside the rolling window", async () => {
    // Two sends 25 hours ago — outside a 24h window.
    await seedSend(new Date(Date.now() - 25 * 3_600_000));
    await seedSend(new Date(Date.now() - 25 * 3_600_000));
    // One send just now.
    await seedSend(new Date());

    const result = await checkFrequencyCap(db, {
      workspaceId: "ws-1",
      contactId: "contact-1",
      config: { maxPerWindow: 2, windowHours: 24 },
    });
    expect(result.allowed).toBe(true);
    expect(result.sentInWindow).toBe(1);
  });

  it("respects a custom window size", async () => {
    await seedSend(new Date(Date.now() - 2 * 3_600_000)); // 2h ago
    const result = await checkFrequencyCap(db, {
      workspaceId: "ws-1",
      contactId: "contact-1",
      config: { maxPerWindow: 1, windowHours: 1 }, // 1h window — the send above is outside it
    });
    expect(result.allowed).toBe(true);
    expect(result.sentInWindow).toBe(0);
  });

  it("scopes counting to the workspace", async () => {
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "other-ws" });
    await db.insert(contact).values({
      id: "contact-2",
      workspaceId: "ws-2",
      email: "sam@example.com",
    });
    await db.insert(emailSend).values({
      id: "send-ws2",
      workspaceId: "ws-2",
      contactId: "contact-2",
      toEmail: "sam@example.com",
      subject: "Hi",
      provider: "fake",
      status: "sent",
      idempotencyKey: "send-ws2",
    });

    const result = await checkFrequencyCap(db, {
      workspaceId: "ws-1",
      contactId: "contact-1",
      config: { maxPerWindow: 1 },
    });
    expect(result.sentInWindow).toBe(0);
  });
});
