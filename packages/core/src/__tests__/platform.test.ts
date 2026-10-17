import { beforeEach, describe, expect, it } from "vitest";

import {
  acceptWorkspaceInvite,
  assertWithinQuota,
  assignVariant,
  can,
  changePlan,
  confirmDoubleOptIn,
  createDoubleOptInToken,
  createForm,
  createIntegration,
  createSendingDomain,
  createSendExperiment,
  createWorkspaceInvite,
  ensureBillingSubscription,
  getContactLtv,
  getFormByEmbedKey,
  getUsage,
  incrementUsage,
  isTopicAllowed,
  listContactTopics,
  pickWinner,
  PLAN_QUOTAS,
  processIntegrationEvent,
  QuotaExceededError,
  recordFormSubmission,
  recordRevenueEvent,
  setContactTopicSubscription,
  startSendExperiment,
  upsertPreferenceTopic,
  verifyIntegrationSignature,
  verifySendingDomain,
} from "../platform";
import { resetTables, testDb } from "./testDb";

const db = testDb();
let workspaceId: string;

async function seedWorkspace() {
  const id = crypto.randomUUID();
  await db.execute(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (await import("drizzle-orm"))
      .sql`INSERT INTO workspace (id, name, slug) VALUES (${id}, ${"Test"}, ${"ws-" + id.slice(0, 8)})`,
  );
  return id;
}

beforeEach(async () => {
  await resetTables(db);
  workspaceId = await seedWorkspace();
});

describe("billing / usage", () => {
  it("seeds a free subscription and blocks past quota", async () => {
    const sub = await ensureBillingSubscription(db, workspaceId);
    expect(sub.plan).toBe("free");
    expect(sub.monthlyEmailQuota).toBe(PLAN_QUOTAS.free.monthlyEmailQuota);

    await assertWithinQuota(db, workspaceId, "email_sent");
    for (let i = 0; i < PLAN_QUOTAS.free.monthlyEmailQuota; i++) {
      await incrementUsage(db, workspaceId, "email_sent");
    }
    await expect(assertWithinQuota(db, workspaceId, "email_sent")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("changePlan updates quotas", async () => {
    await ensureBillingSubscription(db, workspaceId);
    const updated = await changePlan(db, workspaceId, "starter");
    expect(updated?.monthlyEmailQuota).toBe(PLAN_QUOTAS.starter.monthlyEmailQuota);
    const usage = await getUsage(db, workspaceId);
    expect(usage.period).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("rbac", () => {
  it("owner has billing:write, member does not", () => {
    expect(can("owner", "billing:write")).toBe(true);
    expect(can("admin", "billing:write")).toBe(false);
    expect(can("member", "billing:write")).toBe(false);
    expect(can("member", "content:write")).toBe(true);
  });
});

describe("forms", () => {
  it("submits and upserts a contact + topic", async () => {
    const topic = await upsertPreferenceTopic(db, {
      workspaceId,
      key: "product",
      name: "Product updates",
      category: "product",
    });
    const form = await createForm(db, {
      workspaceId,
      name: "Newsletter",
      slug: "news",
      topicIds: [topic!.id],
    });
    const byKey = await getFormByEmbedKey(db, form!.embedKey);
    expect(byKey?.status).toBe("draft");

    // published required for submit
    const { form: formTable } = await import("@loopkit/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(formTable).set({ status: "published" }).where(eq(formTable.id, form!.id));

    const result = await recordFormSubmission(db, {
      embedKey: form!.embedKey,
      email: "sam@example.com",
      data: { email: "sam@example.com", firstName: "Sam" },
      workspaceId,
    });
    expect(result.requiresConfirmation).toBe(false);
    expect(result.contactId).toBeTruthy();

    const topics = await listContactTopics(db, workspaceId, result.contactId!);
    const product = topics.find((t) => t.topic.key === "product");
    expect(product?.subscribed).toBe(true);
  });

  it("queues double opt-in when enabled", async () => {
    const form = await createForm(db, {
      workspaceId,
      name: "DOI",
      slug: "doi",
      doubleOptIn: true,
    });
    const { form: formTable } = await import("@loopkit/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(formTable).set({ status: "published" }).where(eq(formTable.id, form!.id));

    let issued: string | null = null;
    const result = await recordFormSubmission(db, {
      embedKey: form!.embedKey,
      email: "doi@example.com",
      data: { email: "doi@example.com" },
      workspaceId,
      createDoubleOptIn: async (payload) => {
        const { token } = await createDoubleOptInToken(db, {
          workspaceId,
          email: payload.email,
          contactId: payload.contactId,
          formId: payload.formId,
          topicIds: payload.topicIds,
        });
        issued = token;
      },
    });
    expect(result.requiresConfirmation).toBe(true);
    expect(issued).toBeTruthy();
    await confirmDoubleOptIn(db, issued!);
  });
});

describe("sending domains", () => {
  it("creates DNS wizard records and verifies manually", async () => {
    const row = await createSendingDomain(db, {
      workspaceId,
      domain: "mail.example.com",
    });
    expect(row?.dnsRecords.map((r) => r.purpose).sort()).toEqual([
      "dkim",
      "dmarc",
      "return-path",
      "spf",
      "tracking",
    ]);
    const verified = await verifySendingDomain(db, workspaceId, row!.id, { manual: true });
    expect(verified?.status).toBe("verified");
  });
});

describe("topics", () => {
  it("marketing topics require an explicit subscription; product defaults on", async () => {
    const marketing = await upsertPreferenceTopic(db, {
      workspaceId,
      key: "promos",
      name: "Promos",
      category: "marketing",
    });
    await upsertPreferenceTopic(db, {
      workspaceId,
      key: "updates",
      name: "Updates",
      category: "product",
    });
    const { contact: contactTable } = await import("@loopkit/db/schema");
    const [c] = await db
      .insert(contactTable)
      .values({
        id: crypto.randomUUID(),
        workspaceId,
        email: "t@example.com",
      })
      .returning();

    expect(await isTopicAllowed(db, workspaceId, c!.id, "promos")).toBe(false);
    expect(await isTopicAllowed(db, workspaceId, c!.id, "updates")).toBe(true);
    expect(await isTopicAllowed(db, workspaceId, c!.id, "missing")).toBe(true);

    await setContactTopicSubscription(db, {
      workspaceId,
      contactId: c!.id,
      topicId: marketing!.id,
      subscribed: true,
    });
    expect(await isTopicAllowed(db, workspaceId, c!.id, "promos")).toBe(true);
  });
});

describe("revenue attribution", () => {
  it("attributes last-touch to a recent journey run and sums LTV", async () => {
    const {
      contact: contactTable,
      journey: journeyTable,
      journeyRun: runTable,
    } = await import("@loopkit/db/schema");
    const [c] = await db
      .insert(contactTable)
      .values({ id: crypto.randomUUID(), workspaceId, email: "buyer@example.com" })
      .returning();
    const jId = crypto.randomUUID();
    await db.insert(journeyTable).values({
      id: jId,
      workspaceId,
      name: "Winback",
      workflowId: `journey-${jId}`,
      trigger: { kind: "manual" } as never,
    });
    await db.insert(runTable).values({
      id: crypto.randomUUID(),
      workspaceId,
      journeyId: jId,
      journeyVersion: 1,
      contactId: c!.id,
      instanceId: `inst-${crypto.randomUUID()}`,
      status: "running",
      enteredAt: new Date(),
    });

    await recordRevenueEvent(db, {
      workspaceId,
      contactId: c!.id,
      type: "order.completed",
      orderId: "ord_1",
      amountCents: 4900,
    });
    // replay is a no-op
    await recordRevenueEvent(db, {
      workspaceId,
      contactId: c!.id,
      type: "order.completed",
      orderId: "ord_1",
      amountCents: 4900,
    });
    await recordRevenueEvent(db, {
      workspaceId,
      contactId: c!.id,
      type: "order.refunded",
      orderId: "ord_1",
      amountCents: 4900,
    });

    const ltv = await getContactLtv(db, workspaceId, c!.id);
    expect(ltv.ltvCents).toBe(0); // 4900 - 4900 refund
  });
});

describe("experiments", () => {
  it("assigns variants deterministically and picks a winner", async () => {
    const exp = await createSendExperiment(db, {
      workspaceId,
      name: "Subject test",
      kind: "subject",
      metric: "open",
      variants: [
        { label: "A", weight: 50, subject: "Hello" },
        { label: "B", weight: 50, subject: "Hi there" },
      ],
    });
    const v1 = assignVariant(exp!.variants, "contact-1");
    const v2 = assignVariant(exp!.variants, "contact-1");
    expect(v1).toBe(v2);

    await startSendExperiment(db, workspaceId, exp!.id);
    const { recordExperimentOutcome } = await import("../platform");
    const a = exp!.variants[0]!.id;
    const b = exp!.variants[1]!.id;
    await recordExperimentOutcome(db, { experimentId: exp!.id, variantId: a, opened: true });
    await recordExperimentOutcome(db, { experimentId: exp!.id, variantId: a, opened: true });
    await recordExperimentOutcome(db, { experimentId: exp!.id, variantId: b, opened: false });

    const done = await pickWinner(db, workspaceId, exp!.id, "open");
    expect(done?.winnerVariantId).toBe(a);
    expect(done?.status).toBe("completed");
  });
});

describe("integrations", () => {
  it("verifies HMAC signature and records revenue from stripe-like events", async () => {
    const integ = await createIntegration(db, {
      workspaceId,
      kind: "stripe",
      name: "Stripe",
      slug: "stripe-1",
    });
    const secret = integ!.secret;
    expect(verifyIntegrationSignature(secret, "{}", "deadbeef")).toBe(false);

    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({
      id: "evt_1",
      type: "invoice.paid",
      email: "buyer@example.com",
      amount_cents: 2500,
      currency: "usd",
      orderId: "in_1",
    });
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyIntegrationSignature(secret, body, sig)).toBe(true);

    const { contact: contactTable } = await import("@loopkit/db/schema");
    await db
      .insert(contactTable)
      .values({
        id: crypto.randomUUID(),
        workspaceId,
        email: "buyer@example.com",
      })
      .returning();

    const event = await processIntegrationEvent(db, {
      integration: { id: integ!.id, workspaceId, kind: "stripe" },
      externalId: "evt_1",
      type: "invoice.paid",
      payload: JSON.parse(body),
    });
    expect(event!.status).toBe("processed");
    // replay
    const again = await processIntegrationEvent(db, {
      integration: { id: integ!.id, workspaceId, kind: "stripe" },
      externalId: "evt_1",
      type: "invoice.paid",
      payload: JSON.parse(body),
    });
    expect(again!.id).toBe(event!.id);
  });
});

describe("invites", () => {
  it("accepts a valid invite once", async () => {
    const { user: userTable } = await import("@loopkit/db/schema");
    const userId = crypto.randomUUID();
    await db.insert(userTable).values({
      id: userId,
      name: "Sam",
      email: "sam@example.com",
      emailVerified: true,
    });
    const { token } = await createWorkspaceInvite(db, {
      workspaceId,
      email: "sam@example.com",
      role: "admin",
    });
    const member = await acceptWorkspaceInvite(db, token, userId);
    expect(member?.role).toBe("admin");
    await expect(acceptWorkspaceInvite(db, token, userId)).rejects.toThrow();
  });
});
