import { beforeEach, describe, expect, it } from "vitest";

import {
  completeTask,
  createTask,
  getOrCreateMeetingSettings,
  listCompanies,
  listCompanyContacts,
  listTasks,
  meetingEmailVariables,
  recomputeCompanyRollups,
  syncContactCompany,
  taskStats,
  updateMeetingSettings,
  upsertContact,
  runIntelligenceHook,
  ingestPageView,
} from "@loopkit/core";
import {
  company as companyTable,
  contact as contactTable,
  workspace as workspaceTable,
} from "@loopkit/db/schema";
import { eq } from "drizzle-orm";

import { resetTables, testDb } from "./testDb";

const db = testDb();
let workspaceId: string;

beforeEach(async () => {
  await resetTables(db);
  const id = crypto.randomUUID();
  await db.insert(workspaceTable).values({ id, name: "GTM", slug: "gtm-" + id.slice(0, 8) });
  workspaceId = id;
});

describe("meetings", () => {
  it("creates defaults and exposes email variables", async () => {
    const settings = await getOrCreateMeetingSettings(db, workspaceId);
    expect(settings?.meetingTitle).toBeTruthy();

    await updateMeetingSettings(db, workspaceId, {
      bookingUrl: "https://cal.com/loopkit/intro",
      ctaLabel: "Talk to us",
    });
    const vars = await meetingEmailVariables(db, workspaceId);
    expect(vars["meeting.url"]).toBe("https://cal.com/loopkit/intro");
    expect(vars["meeting.cta"]).toBe("Talk to us");
  });
});

describe("tasks", () => {
  it("creates, lists, and completes follow-ups", async () => {
    const c = await upsertContact(db, { workspaceId, email: "task@example.com" });
    const task = await createTask(db, workspaceId, {
      contactId: c.id,
      title: "Call hot lead",
      kind: "call",
      priority: 5,
      source: "manual",
    });
    expect(task).not.toBeNull();

    const open = await listTasks(db, workspaceId, { status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]!.email).toBe("task@example.com");

    const done = await completeTask(db, workspaceId, task!.id, "done");
    expect(done!.status).toBe("done");

    const stats = await taskStats(db, workspaceId);
    expect(stats.open).toBe(0);
    expect(stats.done).toBe(1);
  });

  it("dedups open tasks by source id", async () => {
    const c = await upsertContact(db, { workspaceId, email: "dedupe@example.com" });
    await createTask(db, workspaceId, {
      contactId: c.id,
      title: "Intent",
      source: "intent",
      sourceId: "/pricing",
    });
    await createTask(db, workspaceId, {
      contactId: c.id,
      title: "Intent again",
      source: "intent",
      sourceId: "/pricing",
    });
    const open = await listTasks(db, workspaceId, { contactId: c.id });
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toBe("Intent");
  });

  it("auto-creates a task on high-intent page view", async () => {
    await ingestPageView(db, workspaceId, {
      email: "intent@example.com",
      path: "/pricing?utm=x",
    });
    const open = await listTasks(db, workspaceId, { status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]!.source).toBe("intent");
  });

  it("auto-creates a hot-lead task when score crosses 50", async () => {
    const { createLeadScoreRule } = await import("@loopkit/core");
    await createLeadScoreRule(db, workspaceId, {
      name: "Pro plan",
      kind: "property",
      propertyKey: "plan",
      operator: "eq",
      propertyValue: "pro",
      points: 60,
    });
    const c = await upsertContact(db, {
      workspaceId,
      email: "hot@example.com",
      properties: { plan: "pro" },
    });
    await runIntelligenceHook(db, {
      workspaceId,
      contactId: c.id,
      email: c.email,
      signal: { kind: "contact_created" },
    });
    const open = await listTasks(db, workspaceId, { contactId: c.id });
    expect(open.some((t) => t.source === "score")).toBe(true);
  });
});

describe("companies", () => {
  it("links a contact by business email domain and rolls up", async () => {
    const a = await upsertContact(db, {
      workspaceId,
      email: "amy@acme.com",
      properties: { leadScore: 60, leadTier: "hot" },
    });
    await upsertContact(db, {
      workspaceId,
      email: "bob@acme.com",
      properties: { leadScore: 10, leadTier: "cold" },
    });
    await upsertContact(db, { workspaceId, email: "free@gmail.com" });

    const company = await syncContactCompany(db, workspaceId, a.id, a.email);
    expect(company).not.toBeNull();
    expect(company!.domain).toBe("acme.com");
    expect(company!.name).toContain("Acme");

    const rolled = await recomputeCompanyRollups(db, workspaceId, company!.id);
    expect(rolled!.contactCount).toBe(2);
    expect(rolled!.hotLeadCount).toBe(1);
    expect(rolled!.totalLeadScore).toBe(70);

    const contacts = await listCompanyContacts(db, workspaceId, company!.id);
    expect(contacts).toHaveLength(2);

    const companies = await listCompanies(db, workspaceId);
    expect(companies).toHaveLength(1); // gmail does not create a company
  });

  it("stores companyId on contact properties", async () => {
    const c = await upsertContact(db, { workspaceId, email: "c@stripe.com" });
    await syncContactCompany(db, workspaceId, c.id, c.email);
    const [row] = await db.select().from(contactTable).where(eq(contactTable.id, c.id));
    expect(row!.properties.companyDomain).toBe("stripe.com");
    expect(typeof row!.properties.companyId).toBe("string");

    const [company] = await db
      .select()
      .from(companyTable)
      .where(eq(companyTable.workspaceId, workspaceId));
    expect(company!.name).toBeTruthy();
  });
});
