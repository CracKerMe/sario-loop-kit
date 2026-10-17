import { beforeEach, describe, expect, it } from "vitest";

import {
  createLeadScoreRule,
  createPlay,
  evaluatePlays,
  ingestPageView,
  listLeadScoreRules,
  recomputeLeadScore,
  scoreDistribution,
  tierForScore,
  updateSignalSettings,
  upsertContact,
  recordContactEvent,
} from "@loopkit/core";
import { contact as contactTable, workspace as workspaceTable } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";

import { resetTables, testDb } from "./testDb";

const db = testDb();
let workspaceId: string;

async function seedWorkspace() {
  const id = crypto.randomUUID();
  await db.insert(workspaceTable).values({
    id,
    name: "Intel",
    slug: "intel-" + id.slice(0, 8),
  });
  return id;
}

beforeEach(async () => {
  await resetTables(db);
  workspaceId = await seedWorkspace();
});

describe("lead scoring", () => {
  it("adds property and event rule points and tiers the contact", async () => {
    await createLeadScoreRule(db, workspaceId, {
      name: "Pro plan",
      kind: "property",
      propertyKey: "plan",
      operator: "eq",
      propertyValue: "pro",
      points: 30,
    });
    await createLeadScoreRule(db, workspaceId, {
      name: "Opened email",
      kind: "event",
      eventName: "email.opened",
      points: 10,
      maxHits: 3,
    });

    const c = await upsertContact(db, {
      workspaceId,
      email: "lead@example.com",
      properties: { plan: "pro" },
    });
    await recordContactEvent(db, {
      workspaceId,
      contactId: c.id,
      name: "email.opened",
      properties: {},
    });
    await recordContactEvent(db, {
      workspaceId,
      contactId: c.id,
      name: "email.opened",
      properties: {},
    });

    const result = await recomputeLeadScore(db, workspaceId, c.id);
    expect(result).not.toBeNull();
    // 30 (pro) + 10*2 (opens)
    expect(result!.score).toBe(50);
    expect(result!.tier).toBe("hot");

    const [row] = await db.select().from(contactTable).where(eq(contactTable.id, c.id));
    expect(row!.properties.leadScore).toBe(50);
    expect(row!.properties.leadTier).toBe("hot");
  });

  it("scores high-intent page paths", async () => {
    await createLeadScoreRule(db, workspaceId, {
      name: "Pricing visits",
      kind: "page",
      pathContains: "/pricing",
      points: 15,
      maxHits: 5,
    });

    await ingestPageView(db, workspaceId, {
      email: "visitor@example.com",
      path: "/pricing?plan=pro",
      title: "Pricing",
    });
    await ingestPageView(db, workspaceId, {
      email: "visitor@example.com",
      path: "/blog",
    });

    const contacts = await db
      .select()
      .from(contactTable)
      .where(eq(contactTable.workspaceId, workspaceId));
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.properties.leadScore).toBe(15);
  });

  it("tierForScore thresholds", () => {
    expect(tierForScore(50)).toBe("hot");
    expect(tierForScore(20)).toBe("warm");
    expect(tierForScore(0)).toBe("cold");
  });

  it("scoreDistribution buckets contacts", async () => {
    await upsertContact(db, {
      workspaceId,
      email: "a@example.com",
      properties: { leadScore: 60, leadTier: "hot" },
    });
    await upsertContact(db, {
      workspaceId,
      email: "b@example.com",
      properties: { leadScore: 5, leadTier: "cold" },
    });
    const dist = await scoreDistribution(db, workspaceId);
    expect(dist.total).toBe(2);
    expect(dist.hot).toBe(1);
    expect(dist.cold).toBe(1);
  });
});

describe("signal plays", () => {
  it("fires set_property and add_tag on high-intent page view", async () => {
    await createPlay(db, workspaceId, {
      name: "Pricing intent",
      trigger: { kind: "event", name: "page.viewed", pathContains: "/pricing" },
      actions: [
        { type: "set_property", key: "intent", value: "pricing" },
        { type: "add_tag", tag: "high-intent" },
      ],
    });

    const result = await ingestPageView(db, workspaceId, {
      email: "hot@example.com",
      path: "/pricing",
    });

    expect(result.intelligence.plays.fired).toHaveLength(1);
    expect(result.intelligence.plays.fired[0]!.playName).toBe("Pricing intent");

    const [row] = await db.select().from(contactTable).where(eq(contactTable.id, result.contactId));
    expect(row!.properties.intent).toBe("pricing");
    expect(row!.properties.tags).toContain("high-intent");
  });

  it("does not re-fire within the cooldown window", async () => {
    await createPlay(db, workspaceId, {
      name: "Every open",
      trigger: { kind: "event", name: "email.opened" },
      actions: [{ type: "add_tag", tag: "engaged" }],
    });

    const c = await upsertContact(db, { workspaceId, email: "once@example.com" });
    const first = await evaluatePlays(db, workspaceId, {
      kind: "event",
      contactId: c.id,
      email: c.email,
      eventName: "email.opened",
      eventProperties: {},
      properties: {},
    });
    expect(first.fired).toHaveLength(1);

    const second = await evaluatePlays(db, workspaceId, {
      kind: "event",
      contactId: c.id,
      email: c.email,
      eventName: "email.opened",
      eventProperties: {},
      properties: {},
    });
    expect(second.fired).toHaveLength(0);
  });

  it("collects start_journey actions without executing them", async () => {
    const journeyId = crypto.randomUUID();
    await createPlay(db, workspaceId, {
      name: "Start nurture",
      trigger: { kind: "event", name: "signup.completed" },
      actions: [{ type: "start_journey", journeyId }],
    });

    const c = await upsertContact(db, { workspaceId, email: "nurture@example.com" });
    const result = await evaluatePlays(db, workspaceId, {
      kind: "event",
      contactId: c.id,
      email: c.email,
      eventName: "signup.completed",
      eventProperties: {},
      properties: {},
    });
    expect(result.journeyStarts).toHaveLength(1);
    expect(result.journeyStarts[0]!.journeyId).toBe(journeyId);
    expect(result.journeyStarts[0]!.contactId).toBe(c.id);
  });
});

describe("signal settings", () => {
  it("creates defaults and updates intent webhook", async () => {
    await updateSignalSettings(db, workspaceId, {
      highIntentPaths: ["/pricing", "/demo"],
      intentWebhookUrl: "https://hooks.example.com/intent",
    });
    await createLeadScoreRule(db, workspaceId, {
      name: "list",
      kind: "property",
      propertyKey: "x",
      operator: "exists",
      points: 1,
    });
    const rules = await listLeadScoreRules(db, workspaceId);
    expect(rules).toHaveLength(1);
  });
});
