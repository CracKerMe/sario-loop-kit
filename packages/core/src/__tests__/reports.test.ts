import { emailDelivery, emailSend, emailTemplate, journey, workspace } from "@loopkit/db/schema";
import { beforeEach, describe, expect, it } from "vitest";

import { upsertContact } from "../contacts";
import {
  getJourneyEmailEngagement,
  getTemplateEngagement,
  getWorkspaceEngagement,
} from "../reports";
import { resetTables, testDb } from "./testDb";

const db = testDb();

async function seedWorkspace(): Promise<{ workspaceId: string; contactId: string }> {
  await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  const created = await upsertContact(db, { workspaceId: "ws-1", email: "a@example.com" });
  return { workspaceId: "ws-1", contactId: created.id };
}

/** Mirrors what @loopkit/email's channel.ts writes for a send. */
async function seedSend(params: {
  id: string;
  workspaceId: string;
  contactId: string;
  templateId?: string;
  journeyId?: string;
  nodeId?: string;
  status: "queued" | "sent" | "delivered" | "bounced" | "failed" | "complained";
}): Promise<void> {
  await db.insert(emailSend).values({
    id: params.id,
    workspaceId: params.workspaceId,
    contactId: params.contactId,
    templateId: params.templateId ?? null,
    journeyId: params.journeyId ?? null,
    nodeId: params.nodeId ?? null,
    toEmail: "a@example.com",
    subject: "Hello",
    provider: "fake",
    status: params.status,
    idempotencyKey: params.id,
  });
}

/** Mirrors what the Resend webhook writes on delivery events. */
async function seedDelivery(
  sendId: string,
  type: "delivered" | "opened" | "clicked",
): Promise<void> {
  await db.insert(emailDelivery).values({
    id: crypto.randomUUID(),
    sendId,
    type,
    occurredAt: new Date(),
  });
}

describe("getWorkspaceEngagement", () => {
  beforeEach(async () => {
    await resetTables(db);
  });

  it("returns zeroed rates when nothing has been sent", async () => {
    const { workspaceId } = await seedWorkspace();
    const engagement = await getWorkspaceEngagement(db, workspaceId);
    expect(engagement).toEqual({
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
      openRate: 0,
      clickRate: 0,
    });
  });

  it("aggregates delivered/opened/clicked across sends and derives rates", async () => {
    const { workspaceId, contactId } = await seedWorkspace();
    await seedSend({ id: "s1", workspaceId, contactId, status: "delivered" });
    await seedSend({ id: "s2", workspaceId, contactId, status: "delivered" });
    await seedSend({ id: "s3", workspaceId, contactId, status: "bounced" });
    await seedDelivery("s1", "delivered");
    await seedDelivery("s1", "opened");
    await seedDelivery("s1", "clicked");
    await seedDelivery("s2", "delivered");
    // s2 delivered but never opened/clicked.

    const engagement = await getWorkspaceEngagement(db, workspaceId);
    expect(engagement.sent).toBe(3); // delivered(2) + bounced(1) email_send rows
    expect(engagement.delivered).toBe(2);
    expect(engagement.opened).toBe(1);
    expect(engagement.clicked).toBe(1);
    // `bounced`/`complained` on EmailEngagementStats come from email_delivery
    // events (the provider's own report), not email_send.status — no bounce
    // *event* was seeded here even though one send's status is "bounced".
    expect(engagement.bounced).toBe(0);
    expect(engagement.openRate).toBeCloseTo(0.5);
    expect(engagement.clickRate).toBeCloseTo(0.5);
  });

  it("does not leak another workspace's engagement", async () => {
    const { workspaceId, contactId } = await seedWorkspace();
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
    const otherContact = await upsertContact(db, { workspaceId: "ws-2", email: "b@example.com" });
    const otherContactId = otherContact.id;

    await seedSend({ id: "s1", workspaceId, contactId, status: "delivered" });
    await seedDelivery("s1", "delivered");
    await seedDelivery("s1", "opened");

    await seedSend({
      id: "s2",
      workspaceId: "ws-2",
      contactId: otherContactId,
      status: "delivered",
    });
    await seedDelivery("s2", "delivered");
    await seedDelivery("s2", "opened");
    await seedDelivery("s2", "clicked");

    const engagement = await getWorkspaceEngagement(db, workspaceId);
    expect(engagement.delivered).toBe(1);
    expect(engagement.opened).toBe(1);
    expect(engagement.clicked).toBe(0);
  });
});

describe("getJourneyEmailEngagement", () => {
  beforeEach(async () => {
    await resetTables(db);
  });

  async function seedJourney(id: string, workspaceId: string): Promise<void> {
    await db.insert(journey).values({
      id,
      workspaceId,
      name: `Journey ${id}`,
      workflowId: `wf-${id}`,
      trigger: { type: "manual" },
    });
  }

  it("buckets engagement per node id within one journey", async () => {
    const { workspaceId, contactId } = await seedWorkspace();
    await seedJourney("j1", workspaceId);
    await seedSend({
      id: "s1",
      workspaceId,
      contactId,
      journeyId: "j1",
      nodeId: "email-1",
      status: "delivered",
    });
    await seedSend({
      id: "s2",
      workspaceId,
      contactId,
      journeyId: "j1",
      nodeId: "email-2",
      status: "delivered",
    });
    await seedDelivery("s1", "delivered");
    await seedDelivery("s1", "opened");
    await seedDelivery("s2", "delivered");

    const rows = await getJourneyEmailEngagement(db, workspaceId, "j1");
    const byNode = Object.fromEntries(rows.map((r) => [r.nodeId, r]));
    expect(byNode["email-1"]!.opened).toBe(1);
    expect(byNode["email-1"]!.openRate).toBeCloseTo(1);
    expect(byNode["email-2"]!.opened).toBe(0);
    expect(byNode["email-2"]!.openRate).toBe(0);
  });

  it("ignores sends from a different journey", async () => {
    const { workspaceId, contactId } = await seedWorkspace();
    await seedJourney("j1", workspaceId);
    await seedJourney("other-journey", workspaceId);
    await seedSend({
      id: "s1",
      workspaceId,
      contactId,
      journeyId: "other-journey",
      nodeId: "email-1",
      status: "delivered",
    });
    const rows = await getJourneyEmailEngagement(db, workspaceId, "j1");
    expect(rows).toEqual([]);
  });
});

describe("getTemplateEngagement", () => {
  beforeEach(async () => {
    await resetTables(db);
  });

  async function seedTemplate(): Promise<void> {
    await db.insert(emailTemplate).values({
      id: "tpl-1",
      workspaceId: "ws-1",
      name: "Welcome",
      subject: "Hi",
      html: "<p>hi</p>",
    });
  }

  it("aggregates engagement across every send that used this template", async () => {
    const { workspaceId, contactId } = await seedWorkspace();
    await seedTemplate();
    await seedSend({ id: "s1", workspaceId, contactId, templateId: "tpl-1", status: "delivered" });
    await seedDelivery("s1", "delivered");
    await seedDelivery("s1", "opened");

    const engagement = await getTemplateEngagement(db, workspaceId, "tpl-1");
    expect(engagement.delivered).toBe(1);
    expect(engagement.opened).toBe(1);
    expect(engagement.openRate).toBeCloseTo(1);
  });

  it("returns zeros for a template that was never sent", async () => {
    const { workspaceId } = await seedWorkspace();
    await seedTemplate();
    const engagement = await getTemplateEngagement(db, workspaceId, "tpl-1");
    expect(engagement.sent).toBe(0);
    expect(engagement.openRate).toBe(0);
  });
});
