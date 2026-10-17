/**
 * Platform expansion: forms, sending domains, billing/metering,
 * preference topics, multi-channel, integrations, audit, compliance jobs,
 * send optimization, journey-as-code snapshots.
 */
import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { contact } from "./contacts";
import { emailSend } from "./email";
import { journey, journeyRun } from "./journeys";
import { user } from "./auth";
import { workspace } from "./workspace";

// ---------------------------------------------------------------------------
// Forms (embeddable signup)
// ---------------------------------------------------------------------------

export const form = pgTable(
  "form",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").$type<"draft" | "published" | "archived">().notNull().default("draft"),
    /** inline | popup | floating */
    kind: text("kind").$type<"inline" | "popup" | "floating">().notNull().default("inline"),
    fields: jsonb("fields")
      .$type<
        Array<{
          key: string;
          label: string;
          type: "email" | "text" | "select" | "checkbox";
          required?: boolean;
          options?: string[];
          mapsTo?: string;
        }>
      >()
      .notNull()
      .default([]),
    /** Preference topic ids to auto-subscribe on submit. */
    topicIds: text("topic_ids").array().notNull().default([]),
    audienceId: text("audience_id"),
    successMessage: text("success_message"),
    doubleOptIn: boolean("double_opt_in").notNull().default(false),
    redirectUrl: text("redirect_url"),
    style: jsonb("style")
      .$type<{
        primaryColor?: string;
        backgroundColor?: string;
        textColor?: string;
        buttonText?: string;
        title?: string;
        description?: string;
      }>()
      .notNull()
      .default({}),
    embedKey: text("embed_key").notNull(),
    views: integer("views").notNull().default(0),
    submissions: integer("submissions").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("form_ws_slug_uidx").on(t.workspaceId, t.slug),
    uniqueIndex("form_embed_key_uidx").on(t.embedKey),
    index("form_ws_idx").on(t.workspaceId),
  ],
);

export const formSubmission = pgTable(
  "form_submission",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    formId: text("form_id")
      .notNull()
      .references(() => form.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contact.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("form_submission_form_idx").on(t.formId),
    index("form_submission_email_idx").on(t.email),
  ],
);

// ---------------------------------------------------------------------------
// Sending domains (SPF / DKIM / DMARC wizard)
// ---------------------------------------------------------------------------

export const sendingDomain = pgTable(
  "sending_domain",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: text("status")
      .$type<"pending" | "verifying" | "verified" | "failed">()
      .notNull()
      .default("pending"),
    /** Resend / SES / custom provider domain id */
    provider: text("provider").notNull().default("resend"),
    providerDomainId: text("provider_domain_id"),
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    replyTo: text("reply_to"),
    /** Expected DNS records for the wizard. */
    dnsRecords: jsonb("dns_records")
      .$type<
        Array<{
          type: "TXT" | "CNAME" | "MX";
          host: string;
          value: string;
          purpose: "spf" | "dkim" | "dmarc" | "return-path" | "tracking";
          status: "pending" | "verified";
        }>
      >()
      .notNull()
      .default([]),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("sending_domain_ws_domain_uidx").on(t.workspaceId, t.domain),
    index("sending_domain_ws_idx").on(t.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// Billing / metering / plans
// ---------------------------------------------------------------------------

export type PlanTier = "free" | "starter" | "growth" | "scale";

export const billingSubscription = pgTable(
  "billing_subscription",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    plan: text("plan").$type<PlanTier>().notNull().default("free"),
    status: text("status")
      .$type<"trialing" | "active" | "past_due" | "canceled" | "paused">()
      .notNull()
      .default("active"),
    /** Stripe-style ids kept free-form so self-host can run without Stripe. */
    provider: text("provider").notNull().default("manual"),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    seats: integer("seats").notNull().default(1),
    monthlyEmailQuota: integer("monthly_email_quota").notNull().default(2000),
    monthlyContactQuota: integer("monthly_contact_quota").notNull().default(500),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true })
      .notNull()
      .defaultNow(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true })
      .notNull()
      .defaultNow(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("billing_sub_ws_uidx").on(t.workspaceId)],
);

export const usageCounter = pgTable(
  "usage_counter",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** YYYY-MM */
    period: text("period").notNull(),
    metric: text("metric")
      .$type<
        "email_sent" | "sms_sent" | "push_sent" | "inapp_sent" | "contacts" | "events" | "api_calls"
      >()
      .notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("usage_counter_ws_period_metric_uidx").on(t.workspaceId, t.period, t.metric)],
);

// ---------------------------------------------------------------------------
// Preference topics (topic-level subscription)
// ---------------------------------------------------------------------------

export const preferenceTopic = pgTable(
  "preference_topic",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** marketing topics honor unsub; transactional/system do not. */
    category: text("category")
      .$type<"marketing" | "product" | "transactional">()
      .notNull()
      .default("marketing"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("preference_topic_ws_key_uidx").on(t.workspaceId, t.key),
    index("preference_topic_ws_idx").on(t.workspaceId),
  ],
);

export const contactTopicSubscription = pgTable(
  "contact_topic_subscription",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    topicId: text("topic_id")
      .notNull()
      .references(() => preferenceTopic.id, { onDelete: "cascade" }),
    subscribed: boolean("subscribed").notNull().default(true),
    source: text("source").notNull().default("preference_center"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("contact_topic_uidx").on(t.contactId, t.topicId),
    index("contact_topic_ws_idx").on(t.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// Multi-channel messaging
// ---------------------------------------------------------------------------

export type ChannelKind = "email" | "sms" | "whatsapp" | "push" | "inapp";

export const channelConnection = pgTable(
  "channel_connection",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    channel: text("channel").$type<ChannelKind>().notNull(),
    provider: text("provider").notNull().default("console"),
    status: text("status").$type<"disabled" | "enabled" | "error">().notNull().default("disabled"),
    name: text("name").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("channel_conn_ws_channel_uidx").on(t.workspaceId, t.channel),
    index("channel_conn_ws_idx").on(t.workspaceId),
  ],
);

export const messageSend = pgTable(
  "message_send",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    channel: text("channel").$type<ChannelKind>().notNull(),
    contactId: text("contact_id").references(() => contact.id, { onDelete: "set null" }),
    to: text("to").notNull(),
    subject: text("subject"),
    body: text("body"),
    templateKey: text("template_key"),
    journeyRunId: text("journey_run_id").references(() => journeyRun.id, { onDelete: "set null" }),
    campaignId: text("campaign_id"),
    topicId: text("topic_id"),
    status: text("status")
      .$type<"queued" | "sent" | "failed" | "skipped">()
      .notNull()
      .default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    error: text("error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("message_send_idem_uidx").on(t.workspaceId, t.idempotencyKey),
    index("message_send_contact_idx").on(t.contactId),
    index("message_send_channel_idx").on(t.channel),
  ],
);

// ---------------------------------------------------------------------------
// Integrations (Stripe / Shopify / Segment inbound)
// ---------------------------------------------------------------------------

export const integration = pgTable(
  "integration",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"stripe" | "shopify" | "segment" | "webhook" | "custom">().notNull(),
    name: text("name").notNull(),
    status: text("status").$type<"disabled" | "enabled" | "error">().notNull().default("disabled"),
    /** Public id used in inbound webhook URLs. */
    slug: text("slug").notNull(),
    secret: text("secret").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("integration_ws_slug_uidx").on(t.workspaceId, t.slug),
    index("integration_ws_idx").on(t.workspaceId),
  ],
);

export const integrationEvent = pgTable(
  "integration_event",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integration.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status")
      .$type<"received" | "processed" | "skipped" | "failed">()
      .notNull()
      .default("received"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("integration_event_ext_uidx").on(t.integrationId, t.externalId),
    index("integration_event_ws_idx").on(t.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// Revenue attribution
// ---------------------------------------------------------------------------

export const revenueEvent = pgTable(
  "revenue_event",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** order.completed | order.refunded | subscription.* */
    type: text("type").notNull(),
    orderId: text("order_id"),
    currency: text("currency").notNull().default("USD"),
    amountCents: integer("amount_cents").notNull().default(0),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** last-touch attribution window defaults 7d */
    attributedJourneyId: text("attributed_journey_id").references(() => journey.id, {
      onDelete: "set null",
    }),
    attributedRunId: text("attributed_run_id").references(() => journeyRun.id, {
      onDelete: "set null",
    }),
    attributedMessageId: text("attributed_message_id"),
    attributionSource: text("attribution_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("revenue_event_contact_idx").on(t.contactId),
    index("revenue_event_ws_time_idx").on(t.workspaceId, t.occurredAt),
    index("revenue_event_journey_idx").on(t.attributedJourneyId),
    uniqueIndex("revenue_event_order_uidx").on(t.workspaceId, t.orderId, t.type),
  ],
);

// ---------------------------------------------------------------------------
// Send optimization experiments (subject / send-time)
// ---------------------------------------------------------------------------

export const sendExperiment = pgTable(
  "send_experiment",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<"subject" | "send_time" | "content">().notNull(),
    status: text("status")
      .$type<"draft" | "running" | "completed" | "canceled">()
      .notNull()
      .default("draft"),
    emailTemplateId: text("email_template_id"),
    journeyId: text("journey_id").references(() => journey.id, { onDelete: "set null" }),
    variants: jsonb("variants")
      .$type<
        Array<{
          id: string;
          label: string;
          weight: number;
          subject?: string;
          sendHourLocal?: number;
          sendWeekday?: number;
        }>
      >()
      .notNull()
      .default([]),
    winnerVariantId: text("winner_variant_id"),
    metric: text("metric").$type<"open" | "click" | "conversion">().notNull().default("open"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("send_experiment_ws_idx").on(t.workspaceId)],
);

export const sendExperimentResult = pgTable(
  "send_experiment_result",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id")
      .notNull()
      .references(() => sendExperiment.id, { onDelete: "cascade" }),
    variantId: text("variant_id").notNull(),
    emailSendId: text("email_send_id").references(() => emailSend.id, { onDelete: "set null" }),
    opened: boolean("opened").notNull().default(false),
    clicked: boolean("clicked").notNull().default(false),
    converted: boolean("converted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("send_exp_result_send_uidx").on(t.emailSendId),
    index("send_exp_result_exp_idx").on(t.experimentId, t.variantId),
  ],
);

// ---------------------------------------------------------------------------
// Journey as Code
// ---------------------------------------------------------------------------

export const journeyExport = pgTable(
  "journey_export",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    journeyId: text("journey_id")
      .notNull()
      .references(() => journey.id, { onDelete: "cascade" }),
    journeyVersion: integer("journey_version"),
    format: text("format").$type<"yaml" | "json">().notNull().default("yaml"),
    document: text("document").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("journey_export_checksum_uidx").on(t.workspaceId, t.checksum),
    index("journey_export_journey_idx").on(t.journeyId),
  ],
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorType: text("actor_type")
      .$type<"user" | "api_key" | "system" | "integration">()
      .notNull()
      .default("user"),
    actorLabel: text("actor_label"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_ws_idx").on(t.workspaceId, t.createdAt),
    index("audit_log_action_idx").on(t.action),
  ],
);

export const workspaceInvite = pgTable(
  "workspace_invite",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<"owner" | "admin" | "member">().notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_invite_token_uidx").on(t.tokenHash),
    index("workspace_invite_email_idx").on(t.email),
  ],
);

// ---------------------------------------------------------------------------
// Compliance: double opt-in + GDPR jobs
// ---------------------------------------------------------------------------

export const consentToken = pgTable(
  "consent_token",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contact.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    purpose: text("purpose").$type<"double_opt_in" | "email_change">().notNull(),
    tokenHash: text("token_hash").notNull(),
    formId: text("form_id"),
    topicIds: text("topic_ids").array().notNull().default([]),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("consent_token_hash_uidx").on(t.tokenHash),
    index("consent_token_email_idx").on(t.email),
  ],
);

export const privacyJob = pgTable(
  "privacy_job",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contact.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    kind: text("kind").$type<"export" | "erasure">().notNull(),
    status: text("status")
      .$type<"pending" | "processing" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    resultPath: text("result_path"),
    error: text("error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("privacy_job_ws_idx").on(t.workspaceId),
    index("privacy_job_email_idx").on(t.email),
  ],
);

/**
 * Ops health alerts — product-level send-health findings (bounce spike,
 * complaint spike, DLQ growth…). Deduped per (workspace, kind, hourly
 * bucket) so a health sweep every minute cannot spam the same incident.
 */
export const opsAlert = pgTable(
  "ops_alert",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: text("kind")
      .$type<
        "bounce_spike" | "complaint_spike" | "failure_spike" | "dlq_growth" | "open_rate_drop"
      >()
      .notNull(),
    severity: text("severity").$type<"info" | "warning" | "critical">().notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    action: text("action").notNull(),
    /** Rate or count in the alerting window. */
    current: doublePrecision("current").notNull().default(0),
    previous: doublePrecision("previous").notNull().default(0),
    /** Hour bucket (epoch hours) used for dedupe. */
    bucket: integer("bucket").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ops_alert_ws_idx").on(t.workspaceId, t.createdAt.desc()),
    uniqueIndex("ops_alert_dedupe_uidx").on(t.workspaceId, t.kind, t.bucket),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const formRelations = relations(form, ({ one, many }) => ({
  workspace: one(workspace, { fields: [form.workspaceId], references: [workspace.id] }),
  submissions: many(formSubmission),
}));

export const formSubmissionRelations = relations(formSubmission, ({ one }) => ({
  form: one(form, { fields: [formSubmission.formId], references: [form.id] }),
  contact: one(contact, { fields: [formSubmission.contactId], references: [contact.id] }),
}));

export const revenueEventRelations = relations(revenueEvent, ({ one }) => ({
  contact: one(contact, { fields: [revenueEvent.contactId], references: [contact.id] }),
  journey: one(journey, { fields: [revenueEvent.attributedJourneyId], references: [journey.id] }),
  run: one(journeyRun, { fields: [revenueEvent.attributedRunId], references: [journeyRun.id] }),
}));

export const platformTables = [
  form,
  formSubmission,
  sendingDomain,
  billingSubscription,
  usageCounter,
  preferenceTopic,
  contactTopicSubscription,
  channelConnection,
  messageSend,
  integration,
  integrationEvent,
  revenueEvent,
  sendExperiment,
  sendExperimentResult,
  journeyExport,
  auditLog,
  workspaceInvite,
  consentToken,
  privacyJob,
  opsAlert,
] as const;
