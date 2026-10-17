import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Db } from "@loopkit/db";
import {
  auditLog,
  billingSubscription,
  channelConnection,
  consentToken,
  contact,
  contactEvent,
  contactTopicSubscription,
  form,
  formSubmission,
  integration,
  integrationEvent,
  journey,
  journeyExport,
  journeyRun,
  journeyVersion,
  messageSend,
  preferenceTopic,
  privacyJob,
  revenueEvent,
  sendExperiment,
  sendExperimentResult,
  sendingDomain,
  usageCounter,
  workspaceInvite,
  workspaceMember,
} from "@loopkit/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";

export type WorkspaceRole = "owner" | "admin" | "member";

export type UsageMetric =
  | "email_sent"
  | "sms_sent"
  | "push_sent"
  | "inapp_sent"
  | "contacts"
  | "events"
  | "api_calls";

export type ChannelKind = "email" | "sms" | "whatsapp" | "push" | "inapp";

export type PlanTier = "free" | "starter" | "growth" | "scale";

export const PLAN_QUOTAS: Record<
  PlanTier,
  { monthlyEmailQuota: number; monthlyContactQuota: number; seats: number }
> = {
  free: { monthlyEmailQuota: 2_000, monthlyContactQuota: 500, seats: 1 },
  starter: { monthlyEmailQuota: 20_000, monthlyContactQuota: 5_000, seats: 3 },
  growth: { monthlyEmailQuota: 100_000, monthlyContactQuota: 25_000, seats: 10 },
  scale: { monthlyEmailQuota: 1_000_000, monthlyContactQuota: 250_000, seats: 50 },
};

export const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<string>> = {
  owner: new Set([
    "billing:write",
    "billing:read",
    "members:write",
    "members:read",
    "settings:write",
    "settings:read",
    "content:write",
    "content:read",
    "contacts:write",
    "contacts:read",
    "audit:read",
    "compliance:write",
    "compliance:read",
  ]),
  admin: new Set([
    "billing:read",
    "members:write",
    "members:read",
    "settings:write",
    "settings:read",
    "content:write",
    "content:read",
    "contacts:write",
    "contacts:read",
    "audit:read",
    "compliance:write",
    "compliance:read",
  ]),
  member: new Set([
    "billing:read",
    "members:read",
    "settings:read",
    "content:write",
    "content:read",
    "contacts:write",
    "contacts:read",
  ]),
};

export class QuotaExceededError extends Error {
  readonly metric: UsageMetric;
  readonly limit: number;
  readonly used: number;

  constructor(metric: UsageMetric, limit: number, used: number) {
    super(`quota exceeded for ${metric}: ${used}/${limit}`);
    this.name = "QuotaExceededError";
    this.metric = metric;
    this.limit = limit;
    this.used = used;
  }
}

export class PermissionError extends Error {
  constructor(permission: string) {
    super(`missing permission: ${permission}`);
    this.name = "PermissionError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function periodKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

function id(): string {
  return crypto.randomUUID();
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// RBAC + audit
// ---------------------------------------------------------------------------

export function can(role: WorkspaceRole, permission: string): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export async function requireRole(
  db: Db,
  workspaceId: string,
  userId: string,
  permission: string,
): Promise<WorkspaceRole> {
  const [row] = await db
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
    .limit(1);
  const role = (row?.role ?? "member") as WorkspaceRole;
  if (!can(role, permission)) throw new PermissionError(permission);
  return role;
}

export interface AuditInput {
  workspaceId: string;
  action: string;
  actorUserId?: string | null;
  actorType?: "user" | "api_key" | "system" | "integration";
  actorLabel?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function recordAuditLog(db: Db, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    id: id(),
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? "user",
    actorLabel: input.actorLabel ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    summary: input.summary ?? null,
    metadata: input.metadata ?? {},
    ip: input.ip ?? null,
  });
}

export async function listAuditLogs(
  db: Db,
  workspaceId: string,
  opts: { action?: string; limit?: number } = {},
) {
  const limit = opts.limit ?? 50;
  const where = opts.action
    ? and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.action, opts.action))
    : eq(auditLog.workspaceId, workspaceId);
  return db.select().from(auditLog).where(where).orderBy(desc(auditLog.createdAt)).limit(limit);
}

// ---------------------------------------------------------------------------
// Metering / billing
// ---------------------------------------------------------------------------

export async function ensureBillingSubscription(
  db: Db,
  workspaceId: string,
  plan: PlanTier = "free",
) {
  const [existing] = await db
    .select()
    .from(billingSubscription)
    .where(eq(billingSubscription.workspaceId, workspaceId))
    .limit(1);
  if (existing) return existing;
  const quotas = PLAN_QUOTAS[plan];
  const now = new Date();
  const end = new Date(now);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const [created] = await db
    .insert(billingSubscription)
    .values({
      id: id(),
      workspaceId,
      plan,
      status: "active",
      provider: "manual",
      seats: quotas.seats,
      monthlyEmailQuota: quotas.monthlyEmailQuota,
      monthlyContactQuota: quotas.monthlyContactQuota,
      currentPeriodStart: now,
      currentPeriodEnd: end,
    })
    .returning();
  return created!;
}

export async function changePlan(db: Db, workspaceId: string, plan: PlanTier) {
  const quotas = PLAN_QUOTAS[plan];
  await ensureBillingSubscription(db, workspaceId);
  const [updated] = await db
    .update(billingSubscription)
    .set({
      plan,
      seats: quotas.seats,
      monthlyEmailQuota: quotas.monthlyEmailQuota,
      monthlyContactQuota: quotas.monthlyContactQuota,
    })
    .where(eq(billingSubscription.workspaceId, workspaceId))
    .returning();
  return updated ?? null;
}

export async function incrementUsage(
  db: Db,
  workspaceId: string,
  metric: UsageMetric,
  delta = 1,
): Promise<number> {
  const period = periodKey();
  await db
    .insert(usageCounter)
    .values({
      id: id(),
      workspaceId,
      period,
      metric,
      count: delta,
    })
    .onConflictDoUpdate({
      target: [usageCounter.workspaceId, usageCounter.period, usageCounter.metric],
      set: { count: sql`${usageCounter.count} + ${delta}` },
    });
  const [row] = await db
    .select({ count: usageCounter.count })
    .from(usageCounter)
    .where(
      and(
        eq(usageCounter.workspaceId, workspaceId),
        eq(usageCounter.period, period),
        eq(usageCounter.metric, metric),
      ),
    )
    .limit(1);
  return row?.count ?? delta;
}

export async function getUsage(db: Db, workspaceId: string, period = periodKey()) {
  const rows = await db
    .select()
    .from(usageCounter)
    .where(and(eq(usageCounter.workspaceId, workspaceId), eq(usageCounter.period, period)));
  const byMetric: Record<string, number> = {};
  for (const row of rows) byMetric[row.metric] = row.count;
  return { period, byMetric };
}

export async function assertWithinQuota(
  db: Db,
  workspaceId: string,
  metric: UsageMetric,
  upcoming = 1,
): Promise<void> {
  const sub = await ensureBillingSubscription(db, workspaceId);
  const usage = await getUsage(db, workspaceId);
  const used = usage.byMetric[metric] ?? 0;
  const emailQuota = sub?.monthlyEmailQuota ?? PLAN_QUOTAS.free.monthlyEmailQuota;
  const contactQuota = sub?.monthlyContactQuota ?? PLAN_QUOTAS.free.monthlyContactQuota;
  if (metric === "email_sent" && used + upcoming > emailQuota) {
    throw new QuotaExceededError(metric, emailQuota, used);
  }
  if (metric === "contacts" && used + upcoming > contactQuota) {
    throw new QuotaExceededError(metric, contactQuota, used);
  }
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export interface FormField {
  key: string;
  label: string;
  type: "email" | "text" | "select" | "checkbox";
  required?: boolean;
  options?: string[];
  mapsTo?: string;
}

export async function createForm(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    slug: string;
    kind?: "inline" | "popup" | "floating";
    fields?: FormField[];
    topicIds?: string[];
    doubleOptIn?: boolean;
    successMessage?: string;
    redirectUrl?: string | null;
    style?: Record<string, unknown>;
  },
) {
  const [row] = await db
    .insert(form)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      name: input.name,
      slug: input.slug,
      kind: input.kind ?? "inline",
      fields: input.fields ?? [{ key: "email", label: "Email", type: "email", required: true }],
      topicIds: input.topicIds ?? [],
      doubleOptIn: input.doubleOptIn ?? false,
      successMessage: input.successMessage ?? "Thanks — you're subscribed.",
      redirectUrl: input.redirectUrl ?? null,
      style: input.style ?? {},
      embedKey: randomBytes(12).toString("hex"),
      status: "draft",
    })
    .returning();
  return row;
}

export async function listForms(db: Db, workspaceId: string) {
  return db
    .select()
    .from(form)
    .where(eq(form.workspaceId, workspaceId))
    .orderBy(desc(form.createdAt));
}

export async function getFormByEmbedKey(db: Db, embedKey: string) {
  const [row] = await db.select().from(form).where(eq(form.embedKey, embedKey)).limit(1);
  return row ?? null;
}

export async function getForm(db: Db, workspaceId: string, formId: string) {
  const [row] = await db
    .select()
    .from(form)
    .where(and(eq(form.workspaceId, workspaceId), eq(form.id, formId)))
    .limit(1);
  return row ?? null;
}

export async function updateForm(
  db: Db,
  workspaceId: string,
  formId: string,
  patch: Partial<{
    name: string;
    status: "draft" | "published" | "archived";
    fields: FormField[];
    topicIds: string[];
    doubleOptIn: boolean;
    successMessage: string;
    redirectUrl: string | null;
    style: Record<string, unknown>;
  }>,
) {
  const [row] = await db
    .update(form)
    .set(patch)
    .where(and(eq(form.workspaceId, workspaceId), eq(form.id, formId)))
    .returning();
  return row ?? null;
}

export async function deleteForm(db: Db, workspaceId: string, formId: string) {
  await db.delete(form).where(and(eq(form.workspaceId, workspaceId), eq(form.id, formId)));
}

export async function trackFormView(db: Db, embedKey: string) {
  await db
    .update(form)
    .set({ views: sql`${form.views} + 1` })
    .where(eq(form.embedKey, embedKey));
}

export async function recordFormSubmission(
  db: Db,
  input: {
    embedKey: string;
    email: string;
    data: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
    workspaceId: string;
    createDoubleOptIn?: (payload: {
      contactId: string | null;
      email: string;
      topicIds: string[];
      formId: string;
    }) => Promise<void>;
  },
) {
  const formRow = await getFormByEmbedKey(db, input.embedKey);
  if (!formRow) throw new Error("form not found");
  if (formRow.status !== "published") throw new Error("form not published");

  await assertWithinQuota(db, input.workspaceId, "contacts");

  const email = input.email.trim().toLowerCase();
  const [existing] = await db
    .select()
    .from(contact)
    .where(and(eq(contact.workspaceId, input.workspaceId), eq(contact.email, email)))
    .limit(1);

  const properties: Record<string, unknown> = { ...existing?.properties };
  for (const field of formRow.fields) {
    const raw = input.data[field.key];
    if (raw === undefined || raw === null || raw === "") continue;
    const dest = field.mapsTo ?? field.key;
    if (dest !== "email") properties[dest] = raw;
  }

  let contactId = existing?.id ?? null;
  if (existing) {
    const [updated] = await db
      .update(contact)
      .set({
        properties: properties as Record<string, unknown>,
        subscribed: !formRow.doubleOptIn,
      })
      .where(eq(contact.id, existing.id))
      .returning();
    contactId = updated?.id ?? existing.id;
  } else {
    const [created] = await db
      .insert(contact)
      .values({
        id: id(),
        workspaceId: input.workspaceId,
        email,
        properties: properties as Record<string, unknown>,
        subscribed: !formRow.doubleOptIn,
      })
      .returning();
    contactId = created?.id ?? null;
    await incrementUsage(db, input.workspaceId, "contacts");
  }

  if (contactId && !formRow.doubleOptIn && formRow.topicIds.length) {
    for (const topicId of formRow.topicIds) {
      await db
        .insert(contactTopicSubscription)
        .values({
          id: id(),
          workspaceId: input.workspaceId,
          contactId,
          topicId,
          subscribed: true,
          source: "form",
        })
        .onConflictDoUpdate({
          target: [contactTopicSubscription.contactId, contactTopicSubscription.topicId],
          set: { subscribed: true, source: "form" },
        });
    }
  }

  if (formRow.doubleOptIn && input.createDoubleOptIn) {
    await input.createDoubleOptIn({
      contactId,
      email,
      topicIds: formRow.topicIds,
      formId: formRow.id,
    });
  }

  await db.insert(formSubmission).values({
    id: id(),
    workspaceId: input.workspaceId,
    formId: formRow.id,
    contactId,
    email,
    data: input.data,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
  await db
    .update(form)
    .set({ submissions: sql`${form.submissions} + 1` })
    .where(eq(form.id, formRow.id));

  if (contactId) {
    await db.insert(contactEvent).values({
      id: id(),
      workspaceId: input.workspaceId,
      contactId,
      name: "form.submitted",
      properties: { formId: formRow.id, slug: formRow.slug },
    });
  }

  return {
    contactId,
    requiresConfirmation: formRow.doubleOptIn,
    successMessage: formRow.successMessage,
    redirectUrl: formRow.redirectUrl,
  };
}

// ---------------------------------------------------------------------------
// Sending domains
// ---------------------------------------------------------------------------

export function generateDnsRecords(domain: string) {
  const selector = "loopkit";
  // Records a Resend-verified domain needs. Operators paste these at their
  // DNS host; verifySendingDomain marks them checked.
  return [
    {
      type: "TXT" as const,
      host: `@`,
      value: `v=spf1 include:amazonses.com ~all`,
      purpose: "spf" as const,
      status: "pending" as const,
    },
    {
      type: "TXT" as const,
      host: `${selector}._domainkey.${domain}`,
      value: `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xfn/ygWyF0P4qV0uI7q6Zb5hplaceholder`,
      purpose: "dkim" as const,
      status: "pending" as const,
    },
    {
      type: "TXT" as const,
      host: `_dmarc.${domain}`,
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      purpose: "dmarc" as const,
      status: "pending" as const,
    },
    {
      type: "CNAME" as const,
      host: `bounce.${domain}`,
      value: `feedback.amazonses.com`,
      purpose: "return-path" as const,
      status: "pending" as const,
    },
    {
      type: "CNAME" as const,
      host: `em.${domain}`,
      value: `tracking.loopkit.local`,
      purpose: "tracking" as const,
      status: "pending" as const,
    },
  ];
}

export async function createSendingDomain(
  db: Db,
  input: {
    workspaceId: string;
    domain: string;
    fromName?: string;
    fromEmail?: string;
    replyTo?: string;
  },
) {
  const domain = input.domain.trim().toLowerCase();
  const [row] = await db
    .insert(sendingDomain)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      domain,
      status: "pending",
      provider: "resend",
      fromName: input.fromName ?? null,
      fromEmail: input.fromEmail ?? `hello@${domain}`,
      replyTo: input.replyTo ?? null,
      dnsRecords: generateDnsRecords(domain),
    })
    .returning();
  await recordAuditLog(db, {
    workspaceId: input.workspaceId,
    action: "domain.create",
    targetType: "sending_domain",
    targetId: row?.id,
    summary: domain,
  });
  return row;
}

export async function listSendingDomains(db: Db, workspaceId: string) {
  return db
    .select()
    .from(sendingDomain)
    .where(eq(sendingDomain.workspaceId, workspaceId))
    .orderBy(desc(sendingDomain.createdAt));
}

export async function verifySendingDomain(
  db: Db,
  workspaceId: string,
  domainId: string,
  opts: { manual?: boolean; resolvedHosts?: string[] } = {},
) {
  const [row] = await db
    .select()
    .from(sendingDomain)
    .where(and(eq(sendingDomain.workspaceId, workspaceId), eq(sendingDomain.id, domainId)))
    .limit(1);
  if (!row) return null;

  const records = [...row.dnsRecords];
  if (opts.manual) {
    for (const record of records) record.status = "verified";
  } else if (opts.resolvedHosts?.length) {
    const hosts = new Set(opts.resolvedHosts.map((h) => h.toLowerCase()));
    for (const record of records) {
      if (hosts.has(record.host.toLowerCase())) record.status = "verified";
    }
  }

  const allVerified = records.every((r) => r.status === "verified");
  const [updated] = await db
    .update(sendingDomain)
    .set({
      dnsRecords: records,
      status: allVerified ? "verified" : "verifying",
      verifiedAt: allVerified ? new Date() : null,
      lastCheckedAt: new Date(),
    })
    .where(eq(sendingDomain.id, domainId))
    .returning();

  await recordAuditLog(db, {
    workspaceId,
    action: "domain.verify",
    targetType: "sending_domain",
    targetId: domainId,
    summary: updated?.status ?? "unknown",
  });
  return updated;
}

export async function deleteSendingDomain(db: Db, workspaceId: string, domainId: string) {
  await db
    .delete(sendingDomain)
    .where(and(eq(sendingDomain.workspaceId, workspaceId), eq(sendingDomain.id, domainId)));
}

// ---------------------------------------------------------------------------
// Preference topics
// ---------------------------------------------------------------------------

export async function upsertPreferenceTopic(
  db: Db,
  input: {
    workspaceId: string;
    key: string;
    name: string;
    description?: string | null;
    category?: "marketing" | "product" | "transactional";
    sortOrder?: number;
    active?: boolean;
  },
) {
  const [row] = await db
    .insert(preferenceTopic)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? "marketing",
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
    })
    .onConflictDoUpdate({
      target: [preferenceTopic.workspaceId, preferenceTopic.key],
      set: {
        name: input.name,
        description: input.description ?? null,
        category: input.category ?? "marketing",
        sortOrder: input.sortOrder ?? 0,
        active: input.active ?? true,
      },
    })
    .returning();
  return row;
}

export async function listPreferenceTopics(db: Db, workspaceId: string) {
  return db
    .select()
    .from(preferenceTopic)
    .where(eq(preferenceTopic.workspaceId, workspaceId))
    .orderBy(preferenceTopic.sortOrder, preferenceTopic.name);
}

export async function deletePreferenceTopic(db: Db, workspaceId: string, topicId: string) {
  await db
    .delete(preferenceTopic)
    .where(and(eq(preferenceTopic.workspaceId, workspaceId), eq(preferenceTopic.id, topicId)));
}

export async function listContactTopics(db: Db, workspaceId: string, contactId: string) {
  const topics = await listPreferenceTopics(db, workspaceId);
  const subs = await db
    .select()
    .from(contactTopicSubscription)
    .where(
      and(
        eq(contactTopicSubscription.workspaceId, workspaceId),
        eq(contactTopicSubscription.contactId, contactId),
      ),
    );
  const byId = new Map(subs.map((s) => [s.topicId, s]));
  return topics.map((topic) => ({
    topic,
    subscribed: byId.get(topic.id)?.subscribed ?? topic.category !== "marketing",
  }));
}

export async function setContactTopicSubscription(
  db: Db,
  input: {
    workspaceId: string;
    contactId: string;
    topicId: string;
    subscribed: boolean;
    source?: string;
  },
) {
  const [row] = await db
    .insert(contactTopicSubscription)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      topicId: input.topicId,
      subscribed: input.subscribed,
      source: input.source ?? "preference_center",
    })
    .onConflictDoUpdate({
      target: [contactTopicSubscription.contactId, contactTopicSubscription.topicId],
      set: { subscribed: input.subscribed, source: input.source ?? "preference_center" },
    })
    .returning();
  return row;
}

export async function isTopicAllowed(
  db: Db,
  workspaceId: string,
  contactId: string | null,
  topicKey: string | null | undefined,
): Promise<boolean> {
  if (!topicKey) return true;
  const [topic] = await db
    .select()
    .from(preferenceTopic)
    .where(and(eq(preferenceTopic.workspaceId, workspaceId), eq(preferenceTopic.key, topicKey)))
    .limit(1);
  if (!topic) return true;
  if (topic.category === "transactional") return true;
  if (!contactId) return true;
  const [sub] = await db
    .select()
    .from(contactTopicSubscription)
    .where(
      and(
        eq(contactTopicSubscription.contactId, contactId),
        eq(contactTopicSubscription.topicId, topic.id),
      ),
    )
    .limit(1);
  return sub?.subscribed ?? topic.category !== "marketing";
}

// ---------------------------------------------------------------------------
// Multi-channel messaging
// ---------------------------------------------------------------------------

export interface ChannelSendInput {
  workspaceId: string;
  channel: ChannelKind;
  to: string;
  subject?: string;
  body: string;
  title?: string;
  contactId?: string | null;
  journeyRunId?: string | null;
  campaignId?: string | null;
  topicId?: string | null;
  topicKey?: string | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelProvider {
  channel: ChannelKind;
  send(input: { to: string; subject?: string; body: string; title?: string }): Promise<{
    ok: boolean;
    providerMessageId?: string;
    error?: string;
  }>;
}

export class ConsoleChannelProvider implements ChannelProvider {
  constructor(readonly channel: ChannelKind) {}

  async send(input: { to: string; subject?: string; body: string; title?: string }) {
    console.info(`[loopkit:${this.channel}]`, {
      to: input.to,
      subject: input.subject,
      title: input.title,
      body: input.body.slice(0, 200),
    });
    return { ok: true, providerMessageId: `console-${randomBytes(6).toString("hex")}` };
  }
}

export function createConsoleProviders(): Record<ChannelKind, ChannelProvider> {
  return {
    email: new ConsoleChannelProvider("email"),
    sms: new ConsoleChannelProvider("sms"),
    whatsapp: new ConsoleChannelProvider("whatsapp"),
    push: new ConsoleChannelProvider("push"),
    inapp: new ConsoleChannelProvider("inapp"),
  };
}

export async function listChannelConnections(db: Db, workspaceId: string) {
  return db.select().from(channelConnection).where(eq(channelConnection.workspaceId, workspaceId));
}

export async function upsertChannelConnection(
  db: Db,
  input: {
    workspaceId: string;
    channel: ChannelKind;
    provider?: string;
    name?: string;
    status?: "disabled" | "enabled" | "error";
    config?: Record<string, unknown>;
  },
) {
  const [row] = await db
    .insert(channelConnection)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      channel: input.channel,
      provider: input.provider ?? "console",
      name: input.name ?? input.channel,
      status: input.status ?? "enabled",
      config: input.config ?? {},
    })
    .onConflictDoUpdate({
      target: [channelConnection.workspaceId, channelConnection.channel],
      set: {
        provider: input.provider ?? "console",
        name: input.name ?? input.channel,
        status: input.status ?? "enabled",
        config: input.config ?? {},
      },
    })
    .returning();
  return row;
}

export async function sendViaChannel(db: Db, input: ChannelSendInput) {
  const [existing] = await db
    .select()
    .from(messageSend)
    .where(
      and(
        eq(messageSend.workspaceId, input.workspaceId),
        eq(messageSend.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) return existing;

  if (input.topicKey) {
    const allowed = await isTopicAllowed(
      db,
      input.workspaceId,
      input.contactId ?? null,
      input.topicKey,
    );
    if (!allowed) {
      const [skipped] = await db
        .insert(messageSend)
        .values({
          id: id(),
          workspaceId: input.workspaceId,
          channel: input.channel,
          contactId: input.contactId ?? null,
          to: input.to,
          subject: input.subject ?? null,
          body: input.body,
          journeyRunId: input.journeyRunId ?? null,
          campaignId: input.campaignId ?? null,
          topicId: input.topicId ?? null,
          status: "skipped",
          idempotencyKey: input.idempotencyKey,
          error: "topic_unsubscribed",
          metadata: input.metadata ?? {},
        })
        .returning();
      return skipped;
    }
  }

  const metric: UsageMetric =
    input.channel === "email"
      ? "email_sent"
      : input.channel === "sms" || input.channel === "whatsapp"
        ? "sms_sent"
        : input.channel === "push"
          ? "push_sent"
          : "inapp_sent";
  await assertWithinQuota(db, input.workspaceId, metric);

  const providers = createConsoleProviders();
  const provider = providers[input.channel];
  const result = await provider.send({
    to: input.to,
    subject: input.subject,
    body: input.body,
    title: input.title,
  });

  const [row] = await db
    .insert(messageSend)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      channel: input.channel,
      contactId: input.contactId ?? null,
      to: input.to,
      subject: input.subject ?? null,
      body: input.body,
      journeyRunId: input.journeyRunId ?? null,
      campaignId: input.campaignId ?? null,
      topicId: input.topicId ?? null,
      status: result.ok ? "sent" : "failed",
      idempotencyKey: input.idempotencyKey,
      error: result.error ?? null,
      metadata: { ...input.metadata, providerMessageId: result.providerMessageId },
      sentAt: result.ok ? new Date() : null,
    })
    .returning();
  if (result.ok) await incrementUsage(db, input.workspaceId, metric);
  return row;
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export async function createIntegration(
  db: Db,
  input: {
    workspaceId: string;
    kind: "stripe" | "shopify" | "segment" | "webhook" | "custom";
    name: string;
    slug: string;
    config?: Record<string, unknown>;
  },
) {
  const secret = randomBytes(24).toString("hex");
  const [row] = await db
    .insert(integration)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      name: input.name,
      slug: input.slug,
      secret,
      status: "enabled",
      config: input.config ?? {},
    })
    .returning();
  await recordAuditLog(db, {
    workspaceId: input.workspaceId,
    action: "integration.create",
    targetType: "integration",
    targetId: row?.id,
    summary: `${input.kind}:${input.slug}`,
  });
  return row;
}

export async function listIntegrations(db: Db, workspaceId: string) {
  return db
    .select()
    .from(integration)
    .where(eq(integration.workspaceId, workspaceId))
    .orderBy(desc(integration.createdAt));
}

export async function getIntegrationBySlug(db: Db, workspaceId: string, slug: string) {
  const [row] = await db
    .select()
    .from(integration)
    .where(and(eq(integration.workspaceId, workspaceId), eq(integration.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function updateIntegration(
  db: Db,
  workspaceId: string,
  integrationId: string,
  patch: Partial<{
    name: string;
    status: "disabled" | "enabled" | "error";
    config: Record<string, unknown>;
  }>,
) {
  const [row] = await db
    .update(integration)
    .set(patch)
    .where(and(eq(integration.workspaceId, workspaceId), eq(integration.id, integrationId)))
    .returning();
  return row ?? null;
}

export async function deleteIntegration(db: Db, workspaceId: string, integrationId: string) {
  await db
    .delete(integration)
    .where(and(eq(integration.workspaceId, workspaceId), eq(integration.id, integrationId)));
}

export function verifyIntegrationSignature(
  secret: string,
  payload: string,
  signature: string | null | undefined,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const provided = signature.replace(/^sha256=/, "");
  return safeEqual(expected, provided);
}

export async function recordRevenueFromIntegration(
  db: Db,
  input: {
    workspaceId: string;
    contactId: string;
    type: string;
    orderId?: string;
    currency?: string;
    amountCents: number;
    metadata?: Record<string, unknown>;
    source: string;
  },
) {
  return recordRevenueEvent(db, {
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    type: input.type,
    orderId: input.orderId,
    currency: input.currency,
    amountCents: input.amountCents,
    metadata: input.metadata,
    attributionSource: input.source,
  });
}

export async function processIntegrationEvent(
  db: Db,
  input: {
    integration: {
      id: string;
      workspaceId: string;
      kind: "stripe" | "shopify" | "segment" | "webhook" | "custom";
    };
    externalId: string;
    type: string;
    payload: Record<string, unknown>;
  },
) {
  const [existing] = await db
    .select()
    .from(integrationEvent)
    .where(
      and(
        eq(integrationEvent.integrationId, input.integration.id),
        eq(integrationEvent.externalId, input.externalId),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const email = String(
    input.payload.email ??
      input.payload.customer_email ??
      (input.payload.properties as Record<string, unknown> | undefined)?.email ??
      "",
  )
    .trim()
    .toLowerCase();
  let contactId: string | null = null;
  if (email) {
    const [existingContact] = await db
      .select()
      .from(contact)
      .where(and(eq(contact.workspaceId, input.integration.workspaceId), eq(contact.email, email)))
      .limit(1);
    if (existingContact) {
      contactId = existingContact.id;
    } else {
      const [created] = await db
        .insert(contact)
        .values({
          id: id(),
          workspaceId: input.integration.workspaceId,
          email,
          properties: { ...(input.payload.properties as Record<string, unknown> | undefined) },
          subscribed: true,
        })
        .returning();
      contactId = created?.id ?? null;
      await incrementUsage(db, input.integration.workspaceId, "contacts");
    }
  }

  const amountCents = Number(
    (input.payload.amount_cents as number | undefined) ??
      (input.payload.amount as number | undefined) ??
      ((input.payload.data as { object?: { amount?: number } } | undefined)?.object?.amount
        ? Number((input.payload.data as { object: { amount: number } }).object.amount) / 100
        : 0),
  );

  if (contactId && /order\.|charge\.|invoice\.|payment|subscription\./i.test(input.type)) {
    await recordRevenueFromIntegration(db, {
      workspaceId: input.integration.workspaceId,
      contactId,
      type: input.type,
      orderId: String(input.payload.orderId ?? input.payload.id ?? input.externalId),
      currency: String(input.payload.currency ?? "USD"),
      amountCents: Math.round(
        amountCents * (amountCents < 100 && input.payload.amount_cents === undefined ? 100 : 1),
      ),
      metadata: input.payload,
      source: input.integration.kind,
    });
  }

  if (contactId) {
    await db.insert(contactEvent).values({
      id: id(),
      workspaceId: input.integration.workspaceId,
      contactId,
      name: input.type,
      properties: input.payload,
    });
    await incrementUsage(db, input.integration.workspaceId, "events");
  }

  const [row] = await db
    .insert(integrationEvent)
    .values({
      id: id(),
      workspaceId: input.integration.workspaceId,
      integrationId: input.integration.id,
      externalId: input.externalId,
      type: input.type,
      payload: input.payload,
      status: contactId ? "processed" : "skipped",
    })
    .returning();

  await db
    .update(integration)
    .set({ lastEventAt: new Date() })
    .where(eq(integration.id, input.integration.id));

  return row;
}

// ---------------------------------------------------------------------------
// Revenue attribution
// ---------------------------------------------------------------------------

export async function recordRevenueEvent(
  db: Db,
  input: {
    workspaceId: string;
    contactId: string;
    type: string;
    orderId?: string;
    currency?: string;
    amountCents: number;
    metadata?: Record<string, unknown>;
    attributionSource?: string;
  },
) {
  const occurredAt = new Date();
  const windowStart = new Date(occurredAt.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [recentRun] = await db
    .select()
    .from(journeyRun)
    .where(and(eq(journeyRun.contactId, input.contactId), gte(journeyRun.enteredAt, windowStart)))
    .orderBy(desc(journeyRun.enteredAt))
    .limit(1);

  const [row] = await db
    .insert(revenueEvent)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      type: input.type,
      orderId: input.orderId ?? null,
      currency: input.currency ?? "USD",
      amountCents: input.amountCents,
      occurredAt,
      attributedJourneyId: recentRun?.journeyId ?? null,
      attributedRunId: recentRun?.id ?? null,
      attributedMessageId: null,
      attributionSource: input.attributionSource ?? "last_touch",
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: [revenueEvent.workspaceId, revenueEvent.orderId, revenueEvent.type],
    })
    .returning();
  return row ?? null;
}

export async function getRevenueAttributionReport(
  db: Db,
  workspaceId: string,
  opts: { since?: Date } = {},
) {
  const since = opts.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      journeyId: revenueEvent.attributedJourneyId,
      journeyName: journey.name,
      count: sql<number>`count(*)::int`,
      amountCents: sql<number>`coalesce(sum(${revenueEvent.amountCents}), 0)::int`,
    })
    .from(revenueEvent)
    .leftJoin(journey, eq(journey.id, revenueEvent.attributedJourneyId))
    .where(and(eq(revenueEvent.workspaceId, workspaceId), gte(revenueEvent.occurredAt, since)))
    .groupBy(revenueEvent.attributedJourneyId, journey.name);
  return rows;
}

export async function getContactLtv(db: Db, workspaceId: string, contactId: string) {
  const [row] = await db
    .select({
      amountCents: sql<number>`coalesce(sum(case when ${revenueEvent.type} not like '%refund%' then ${revenueEvent.amountCents} else -${revenueEvent.amountCents} end), 0)::int`,
      orders: sql<number>`count(*)::int`,
    })
    .from(revenueEvent)
    .where(and(eq(revenueEvent.workspaceId, workspaceId), eq(revenueEvent.contactId, contactId)));
  return {
    contactId,
    ltvCents: row?.amountCents ?? 0,
    orderCount: row?.orders ?? 0,
    currency: "USD",
  };
}

// ---------------------------------------------------------------------------
// Send experiments (subject / send-time)
// ---------------------------------------------------------------------------

export function assignVariant(
  variants: Array<{ id: string; weight: number }>,
  contactId: string,
): string {
  if (!variants.length) throw new Error("no variants");
  const total = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0) || variants.length;
  const digest = createHash("sha256").update(contactId).digest();
  const bucket = digest.readUInt32BE(0) % total;
  let cursor = 0;
  for (const variant of variants) {
    const weight = Math.max(0, variant.weight) || 1;
    if (bucket < cursor + weight) return variant.id;
    cursor += weight;
  }
  return variants[variants.length - 1]!.id;
}

export async function createSendExperiment(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    kind: "subject" | "send_time" | "content";
    variants: Array<{
      id?: string;
      label: string;
      weight: number;
      subject?: string;
      sendHourLocal?: number;
      sendWeekday?: number;
    }>;
    metric?: "open" | "click" | "conversion";
    journeyId?: string;
  },
) {
  const variants = input.variants.map((v) => ({
    id: v.id ?? randomBytes(4).toString("hex"),
    label: v.label,
    weight: v.weight,
    subject: v.subject,
    sendHourLocal: v.sendHourLocal,
    sendWeekday: v.sendWeekday,
  }));
  const [row] = await db
    .insert(sendExperiment)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      name: input.name,
      kind: input.kind,
      status: "draft",
      journeyId: input.journeyId ?? null,
      variants,
      metric: input.metric ?? "open",
    })
    .returning();
  return row;
}

export async function listSendExperiments(db: Db, workspaceId: string) {
  return db
    .select()
    .from(sendExperiment)
    .where(eq(sendExperiment.workspaceId, workspaceId))
    .orderBy(desc(sendExperiment.createdAt));
}

export async function getSendExperiment(db: Db, workspaceId: string, experimentId: string) {
  const [row] = await db
    .select()
    .from(sendExperiment)
    .where(and(eq(sendExperiment.workspaceId, workspaceId), eq(sendExperiment.id, experimentId)))
    .limit(1);
  return row ?? null;
}

export async function startSendExperiment(db: Db, workspaceId: string, experimentId: string) {
  const [row] = await db
    .update(sendExperiment)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(sendExperiment.workspaceId, workspaceId), eq(sendExperiment.id, experimentId)))
    .returning();
  return row ?? null;
}

export async function recordExperimentOutcome(
  db: Db,
  input: {
    experimentId: string;
    variantId: string;
    emailSendId?: string;
    opened?: boolean;
    clicked?: boolean;
    converted?: boolean;
  },
) {
  const [row] = await db
    .insert(sendExperimentResult)
    .values({
      id: id(),
      experimentId: input.experimentId,
      variantId: input.variantId,
      emailSendId: input.emailSendId ?? null,
      opened: input.opened ?? false,
      clicked: input.clicked ?? false,
      converted: input.converted ?? false,
    })
    .onConflictDoUpdate({
      target: [sendExperimentResult.emailSendId],
      set: {
        opened: input.opened ?? false,
        clicked: input.clicked ?? false,
        converted: input.converted ?? false,
      },
    })
    .returning();
  return row;
}

export async function pickWinner(
  db: Db,
  workspaceId: string,
  experimentId: string,
  metric: "open" | "click" | "conversion" = "open",
) {
  const experiment = await getSendExperiment(db, workspaceId, experimentId);
  if (!experiment) return null;
  const rows = await db
    .select({
      variantId: sendExperimentResult.variantId,
      total: sql<number>`count(*)::int`,
      hits: sql<number>`sum(case when ${
        metric === "open"
          ? sendExperimentResult.opened
          : metric === "click"
            ? sendExperimentResult.clicked
            : sendExperimentResult.converted
      } then 1 else 0 end)::int`,
    })
    .from(sendExperimentResult)
    .where(eq(sendExperimentResult.experimentId, experimentId))
    .groupBy(sendExperimentResult.variantId);

  let winner: string | null = null;
  let best = -1;
  for (const row of rows) {
    const rate = row.total ? row.hits / row.total : 0;
    if (rate > best) {
      best = rate;
      winner = row.variantId;
    }
  }
  if (!winner) return experiment;
  const [updated] = await db
    .update(sendExperiment)
    .set({ winnerVariantId: winner, status: "completed", endedAt: new Date() })
    .where(eq(sendExperiment.id, experimentId))
    .returning();
  return updated ?? experiment;
}

export function pickSendExperimentVariant(
  experiment: {
    variants: Array<{ id: string; weight: number; subject?: string; sendHourLocal?: number }>;
  },
  contactId: string,
) {
  const variantId = assignVariant(experiment.variants, contactId);
  const hit = experiment.variants.find((v) => v.id === variantId);
  return hit ?? experiment.variants[0]!;
}

// ---------------------------------------------------------------------------
// Journey as Code
// ---------------------------------------------------------------------------

export async function exportJourneyDocument(
  db: Db,
  workspaceId: string,
  journeyId: string,
  format: "yaml" | "json" = "json",
  createdBy?: string,
) {
  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.workspaceId, workspaceId), eq(journey.id, journeyId)))
    .limit(1);
  if (!j) return null;
  const [version] = await db
    .select()
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.createdAt))
    .limit(1);

  const graph = (version?.graph ?? { nodes: [], edges: [] }) as {
    nodes?: Array<{ type?: string; data?: { trigger?: unknown } }>;
    edges?: unknown[];
  };
  // Builder graphs keep the trigger as a `type:"trigger"` node; older
  // snapshots may still carry a top-level `trigger` field.
  const triggerNode = graph.nodes?.find((n) => n.type === "trigger");
  const trigger = triggerNode?.data?.trigger ??
    (version?.graph as { trigger?: unknown } | undefined)?.trigger ??
    j.trigger ?? { kind: "manual" };

  const doc = {
    apiVersion: "loopkit/v1",
    kind: "Journey",
    metadata: {
      id: j.id,
      name: j.name,
      status: j.status,
    },
    spec: {
      trigger,
      graph: {
        nodes: graph.nodes ?? [],
        edges: graph.edges ?? [],
      },
    },
  };
  const document =
    format === "json"
      ? JSON.stringify(doc, null, 2)
      : `# loopkit journey\n${JSON.stringify(doc, null, 2)}`;
  const checksum = sha256(document);

  const [row] = await db
    .insert(journeyExport)
    .values({
      id: id(),
      workspaceId,
      journeyId,
      journeyVersion: version?.version ?? null,
      format,
      document,
      checksum,
      createdBy: createdBy ?? null,
    })
    .returning();
  return row;
}

export async function importJourneyDocument(
  db: Db,
  workspaceId: string,
  document: string,
  createdBy?: string,
) {
  let parsed: {
    metadata?: { name?: string };
    spec?: { trigger?: unknown; graph?: { nodes: unknown[]; edges: unknown[] } };
  };
  try {
    parsed = JSON.parse(document);
  } catch {
    // allow YAML-ish wrapper that is JSON after stripping a leading comment
    const stripped = document.replace(/^#.*\n/, "");
    parsed = JSON.parse(stripped);
  }
  const name = parsed.metadata?.name ?? `Imported ${new Date().toISOString().slice(0, 10)}`;
  const trigger = parsed.spec?.trigger ?? { kind: "manual" };
  // Builder source of truth is nodes+edges with a trigger node. Preserve
  // an imported trigger node as-is; otherwise synthesize one so the
  // builder and compile path stay happy.
  const importedNodes = (parsed.spec?.graph?.nodes ?? []) as Array<Record<string, unknown>>;
  const hasTriggerNode = importedNodes.some((n) => n.type === "trigger");
  const nodes = hasTriggerNode
    ? importedNodes
    : [
        {
          id: "trigger",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { trigger },
        },
        ...importedNodes,
      ];
  const graph = {
    nodes,
    edges: parsed.spec?.graph?.edges ?? [],
  } as typeof journeyVersion.$inferInsert.graph;

  const journeyId = id();
  await db.insert(journey).values({
    id: journeyId,
    workspaceId,
    name,
    // Same convention as createJourneyDraft — stable across versions.
    workflowId: `journey-${journeyId}`,
    trigger: (trigger ?? { kind: "manual" }) as never,
  });
  await db.insert(journeyVersion).values({
    journeyId,
    version: 1,
    graph,
    compiled: {},
    createdBy: createdBy ?? null,
  });
  await db.insert(journeyExport).values({
    id: id(),
    workspaceId,
    journeyId,
    journeyVersion: 1,
    format: "json",
    document,
    checksum: sha256(document),
    createdBy: createdBy ?? null,
  });
  return { journeyId, name };
}

// ---------------------------------------------------------------------------
// Compliance: double opt-in + GDPR
// ---------------------------------------------------------------------------

export async function createDoubleOptInToken(
  db: Db,
  input: {
    workspaceId: string;
    email: string;
    contactId?: string | null;
    formId?: string | null;
    topicIds?: string[];
  },
) {
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(consentToken)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      contactId: input.contactId ?? null,
      email: input.email.toLowerCase(),
      purpose: "double_opt_in",
      tokenHash: sha256(token),
      formId: input.formId ?? null,
      topicIds: input.topicIds ?? [],
      expiresAt,
    })
    .returning();
  return { token, row };
}

export async function confirmDoubleOptIn(db: Db, token: string) {
  const [row] = await db
    .select()
    .from(consentToken)
    .where(eq(consentToken.tokenHash, sha256(token)))
    .limit(1);
  if (!row) throw new Error("invalid token");
  if (row.confirmedAt) return row;
  if (row.expiresAt.getTime() < Date.now()) throw new Error("token expired");

  let contactId = row.contactId;
  if (!contactId) {
    const [existing] = await db
      .select()
      .from(contact)
      .where(and(eq(contact.workspaceId, row.workspaceId), eq(contact.email, row.email)))
      .limit(1);
    if (existing) {
      contactId = existing.id;
      await db.update(contact).set({ subscribed: true }).where(eq(contact.id, existing.id));
    }
  } else {
    await db.update(contact).set({ subscribed: true }).where(eq(contact.id, contactId));
  }

  if (contactId) {
    for (const topicId of row.topicIds) {
      await db
        .insert(contactTopicSubscription)
        .values({
          id: id(),
          workspaceId: row.workspaceId,
          contactId,
          topicId,
          subscribed: true,
          source: "double_opt_in",
        })
        .onConflictDoUpdate({
          target: [contactTopicSubscription.contactId, contactTopicSubscription.topicId],
          set: { subscribed: true, source: "double_opt_in" },
        });
    }
  }

  const [updated] = await db
    .update(consentToken)
    .set({ confirmedAt: new Date(), contactId })
    .where(eq(consentToken.id, row.id))
    .returning();
  return updated;
}

export async function createPrivacyJob(
  db: Db,
  input: {
    workspaceId: string;
    email: string;
    kind: "export" | "erasure";
    contactId?: string | null;
    requestedBy?: string | null;
  },
) {
  const [row] = await db
    .insert(privacyJob)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      contactId: input.contactId ?? null,
      email: input.email.toLowerCase(),
      kind: input.kind,
      status: "pending",
      requestedBy: input.requestedBy ?? null,
    })
    .returning();
  return row;
}

export async function runPrivacyJob(db: Db, jobId: string) {
  const [job] = await db.select().from(privacyJob).where(eq(privacyJob.id, jobId)).limit(1);
  if (!job) throw new Error("privacy job not found");
  await db.update(privacyJob).set({ status: "processing" }).where(eq(privacyJob.id, jobId));

  try {
    const [existing] = await db
      .select()
      .from(contact)
      .where(and(eq(contact.workspaceId, job.workspaceId), eq(contact.email, job.email)))
      .limit(1);

    if (job.kind === "export") {
      const events = existing
        ? await db.select().from(contactEvent).where(eq(contactEvent.contactId, existing.id))
        : [];
      const revenue = existing
        ? await db.select().from(revenueEvent).where(eq(revenueEvent.contactId, existing.id))
        : [];
      const exportPayload = {
        email: job.email,
        contact: existing ?? null,
        events,
        revenue,
        exportedAt: new Date().toISOString(),
      };
      const [updated] = await db
        .update(privacyJob)
        .set({
          status: "completed",
          resultPath: JSON.stringify(exportPayload),
          completedAt: new Date(),
        })
        .where(eq(privacyJob.id, jobId))
        .returning();
      return updated;
    }

    if (existing) {
      await db
        .update(contact)
        .set({
          email: `deleted-${existing.id}@invalid`,
          properties: {},
          subscribed: false,
          unsubscribedAt: new Date(),
        })
        .where(eq(contact.id, existing.id));
    }
    const [updated] = await db
      .update(privacyJob)
      .set({ status: "completed", contactId: existing?.id ?? null, completedAt: new Date() })
      .where(eq(privacyJob.id, jobId))
      .returning();
    return updated;
  } catch (error) {
    const [updated] = await db
      .update(privacyJob)
      .set({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      .where(eq(privacyJob.id, jobId))
      .returning();
    return updated;
  }
}

export async function getPrivacyJob(db: Db, workspaceId: string, jobId: string) {
  const [row] = await db
    .select()
    .from(privacyJob)
    .where(and(eq(privacyJob.workspaceId, workspaceId), eq(privacyJob.id, jobId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Workspace invites
// ---------------------------------------------------------------------------

export async function createWorkspaceInvite(
  db: Db,
  input: {
    workspaceId: string;
    email: string;
    role: WorkspaceRole;
    invitedBy?: string | null;
  },
) {
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(workspaceInvite)
    .values({
      id: id(),
      workspaceId: input.workspaceId,
      email: input.email.toLowerCase(),
      role: input.role,
      tokenHash: sha256(token),
      invitedBy: input.invitedBy ?? null,
      expiresAt,
    })
    .returning();
  return { token, invite: row };
}

export async function acceptWorkspaceInvite(db: Db, token: string, userId: string) {
  const [invite] = await db
    .select()
    .from(workspaceInvite)
    .where(eq(workspaceInvite.tokenHash, sha256(token)))
    .limit(1);
  if (!invite) throw new Error("invalid invite");
  if (invite.acceptedAt) throw new Error("invite already accepted");
  if (invite.expiresAt.getTime() < Date.now()) throw new Error("invite expired");

  const [member] = await db
    .insert(workspaceMember)
    .values({
      id: id(),
      workspaceId: invite.workspaceId,
      userId,
      role: invite.role,
    })
    .onConflictDoUpdate({
      target: [workspaceMember.workspaceId, workspaceMember.userId],
      set: { role: invite.role },
    })
    .returning();
  await db
    .update(workspaceInvite)
    .set({ acceptedAt: new Date() })
    .where(eq(workspaceInvite.id, invite.id));
  await recordAuditLog(db, {
    workspaceId: invite.workspaceId,
    action: "member.join",
    actorUserId: userId,
    targetType: "workspace_member",
    targetId: member?.id,
    summary: invite.email,
  });
  return member;
}

export async function listWorkspaceMembers(db: Db, workspaceId: string) {
  return db
    .select({
      id: workspaceMember.id,
      userId: workspaceMember.userId,
      role: workspaceMember.role,
      createdAt: workspaceMember.createdAt,
    })
    .from(workspaceMember)
    .where(eq(workspaceMember.workspaceId, workspaceId));
}

export async function updateMemberRole(
  db: Db,
  workspaceId: string,
  memberId: string,
  role: WorkspaceRole,
) {
  const [row] = await db
    .update(workspaceMember)
    .set({ role })
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.id, memberId)))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

export async function renderPrometheusMetrics(db: Db, workspaceId?: string) {
  const lines: string[] = [];
  lines.push("# HELP loopkit_usage_total Usage counters by metric and period");
  lines.push("# TYPE loopkit_usage_total counter");
  const usageRows = workspaceId
    ? await db.select().from(usageCounter).where(eq(usageCounter.workspaceId, workspaceId))
    : await db.select().from(usageCounter);
  for (const row of usageRows) {
    lines.push(
      `loopkit_usage_total{workspace="${row.workspaceId}",metric="${row.metric}",period="${row.period}"} ${row.count}`,
    );
  }

  lines.push("# HELP loopkit_message_sends_total Message sends by channel and status");
  lines.push("# TYPE loopkit_message_sends_total counter");
  const sendRows = workspaceId
    ? await db
        .select({
          channel: messageSend.channel,
          status: messageSend.status,
          count: sql<number>`count(*)::int`,
        })
        .from(messageSend)
        .where(eq(messageSend.workspaceId, workspaceId))
        .groupBy(messageSend.channel, messageSend.status)
    : await db
        .select({
          channel: messageSend.channel,
          status: messageSend.status,
          count: sql<number>`count(*)::int`,
        })
        .from(messageSend)
        .groupBy(messageSend.channel, messageSend.status);
  for (const row of sendRows) {
    lines.push(
      `loopkit_message_sends_total{channel="${row.channel}",status="${row.status}"} ${row.count}`,
    );
  }

  lines.push("# HELP loopkit_revenue_events_total Revenue events");
  lines.push("# TYPE loopkit_revenue_events_total counter");
  const revRows = workspaceId
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(revenueEvent)
        .where(eq(revenueEvent.workspaceId, workspaceId))
    : await db.select({ count: sql<number>`count(*)::int` }).from(revenueEvent);
  lines.push(`loopkit_revenue_events_total ${revRows[0]?.count ?? 0}`);

  return `${lines.join("\n")}\n`;
}
