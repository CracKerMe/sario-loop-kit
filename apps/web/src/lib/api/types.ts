import type { EmailDocJson } from "@loopkit/email-doc";

/**
 * API wire types.
 *
 * Shared domain types are re-exported from their owning packages so the
 * browser and server cannot drift:
 * - SegmentFilter AST → `@loopkit/journey` (also used by `@loopkit/core`)
 * - Journey validation result → `@loopkit/journey`
 *
 * Response DTOs that JSON-serialize `Date` as ISO strings stay here —
 * package types may carry `Date`, the wire does not.
 */

import type { SegmentFilter, ValidationResult } from "@loopkit/journey";

export type {
  SegmentCondition,
  SegmentEventCondition,
  SegmentFilter,
  SegmentGroup,
  SegmentNot,
  SegmentOperator,
  SegmentValue,
} from "@loopkit/journey";

export type { ValidationIssue, ValidationResult } from "@loopkit/journey";

/** Alias used across audience/campaign wire types. */
export type SegmentFilterDto = SegmentFilter;

/* ------------------------------------------------------------------ */
/* Journey graph (wire / React Flow)                                   */
/* ------------------------------------------------------------------ */

/**
 * Loose graph shape as it travels over JSON and through React Flow.
 * Strongly-typed `JourneyGraph` from `@loopkit/journey` is the editor's
 * source of truth; this stays open (`data: Record<string, unknown>`) so
 * partial/legacy nodes and RF mutations remain representable.
 */
export type JourneyNodeDto = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

export type JourneyEdgeDto = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
};

export type JourneyGraphDto = { nodes: JourneyNodeDto[]; edges: JourneyEdgeDto[] };

export type JourneyDto = {
  id: string;
  name: string;
  status: string;
  publishedVersion: number | null;
  workflowId: string;
  trigger: unknown;
  reentry: string;
  holdoutPercent?: number;
  holdoutGoalEvent?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CopilotResultDto = {
  graph: JourneyGraphDto;
  validation: ValidationResult;
  model: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
};

export type JourneyOptimizationAnalysisDto = {
  summary: string;
  diagnosis: {
    nodeId: string;
    nodeType?: string;
    issue: string;
    severity: "info" | "warning" | "critical";
  }[];
  changes: {
    nodeId: string;
    action: "modify" | "add" | "remove" | "rewire";
    description: string;
  }[];
  expectedImpact: {
    metric: string;
    direction: "increase" | "decrease" | "neutral";
    note: string;
  }[];
  canaryPercent: number;
  nodeMapping?: Record<string, string>;
};

export type JourneyOptimizationProposeDto = {
  optimizationId: string;
  analysis: JourneyOptimizationAnalysisDto;
  graph: JourneyGraphDto;
  model: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
  signals: {
    runCounts: Record<string, number>;
    nodes: { nodeId: string; nodeType: string | null; status: string | null; count: number }[];
    email: {
      sent: number;
      delivered: number;
      bounced: number;
      complained: number;
      failed: number;
    };
    inFlightByVersion: { version: number; runs: number }[];
  };
};

export type JourneyOptimizationDto = {
  id: string;
  journeyId: string;
  baselineVersion: number | null;
  analysis: JourneyOptimizationAnalysisDto;
  proposedGraph: JourneyGraphDto;
  canaryPercent: number;
  status: "proposed" | "accepted" | "rejected" | "canary" | "promoted" | "rolled_back";
  targetVersion: number | null;
  model: string | null;
  createdAt: string;
};

export type VersionOutcomeMetricsDto = {
  version: number;
  runs: number;
  running: number;
  completed: number;
  failed: number;
  exited: number;
  cancelled: number;
  completionRate: number;
  failureRate: number;
  emailSent: number;
  emailDelivered: number;
  emailBounced: number;
  emailComplained: number;
  deliveryRate: number;
  bounceRate: number;
};

export type CanaryComparisonDto = {
  baseline: VersionOutcomeMetricsDto;
  canary: VersionOutcomeMetricsDto;
  completionDelta: number;
  bounceDelta: number;
  deliveryDelta: number;
  decision: "promote" | "rollback" | "hold";
  reason: string;
  engine?: { shouldPromote: boolean; reason: string };
};

export type JourneyCanaryRowDto = {
  journeyId: string;
  optimizationId: string | null;
  baselineVersion: number;
  canaryVersion: number;
  percent: number;
  autoPromote: boolean;
  minRuns: number;
  maxBounceRate: number;
  minCompletionDelta: number;
  status: "active" | "promoted" | "rolled_back";
  startedAt: string;
  promotedAt: string | null;
  rolledBackAt: string | null;
  lastEvaluation: unknown;
};

export type JourneyCanaryStatusDto = {
  canary: JourneyCanaryRowDto | null;
  comparison: CanaryComparisonDto | null;
  metrics: VersionOutcomeMetricsDto[];
};

export type CohortArmStatsDto = {
  enrolled: number;
  converted: number;
  conversionRate: number;
  goalEvents: number;
  revenue: number;
};

export type JourneyLiftReportDto = {
  journeyId: string;
  goalEvent: string | null;
  holdoutPercent: number;
  since: string | null;
  exposed: CohortArmStatsDto;
  holdout: CohortArmStatsDto;
  relativeLift: number | null;
  absoluteLift: number;
  zScore: number | null;
  significant: boolean;
  interpretation: string;
};

export type OpsFindingDto = {
  kind: "bounce_spike" | "complaint_spike" | "failure_spike" | "dlq_growth" | "open_rate_drop";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  current: number;
  previous: number;
  action: string;
};

export type OpsHealthSnapshotDto = {
  windowHours: number;
  current: {
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
    opened: number;
    bouncedRate: number;
    complainedRate: number;
    failedRate: number;
    openRate: number;
    dlq: number;
  };
  previous: {
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
    opened: number;
    bouncedRate: number;
    complainedRate: number;
    failedRate: number;
    openRate: number;
    dlq: number;
  };
  findings: OpsFindingDto[];
  healthy: boolean;
  checkedAt: string;
};

export type OpsAlertDto = {
  id: string;
  kind: OpsFindingDto["kind"];
  severity: OpsFindingDto["severity"];
  title: string;
  detail: string;
  action: string;
  current: number;
  previous: number;
  bucket: number;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
};

export type AcceptOptimizationInput = {
  mode: "draft" | "canary" | "full";
  canaryPercent?: number;
  autoPromote?: boolean;
  minRuns?: number;
  maxBounceRate?: number;
  minCompletionDelta?: number;
};

export type AcceptOptimizationResultDto = {
  optimizationId: string;
  targetVersion: number;
  mode: "draft" | "canary" | "full";
  canary?: { baselineVersion: number; canaryVersion: number; percent: number };
};

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

export type ContactDto = {
  id: string;
  email: string;
  properties: Record<string, unknown>;
  subscribed: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type ContactEventDto = {
  id: string;
  contactId: string;
  name: string;
  properties: Record<string, unknown> | null;
  occurredAt: string;
};

export type ContactActivityDto = {
  contact: ContactDto;
  deliverability: {
    subscribed: boolean;
    suppression: {
      reason: SuppressionReasonDto;
      source: string | null;
      note: string | null;
      createdAt: string;
    } | null;
    mailable: boolean;
  };
  runs: {
    id: string;
    instanceId: string;
    journeyId: string;
    journeyName: string | null;
    status: string;
    journeyVersion: number;
    enteredAt: string;
    exitedAt: string | null;
    exitReason: string | null;
  }[];
  emails: {
    id: string;
    status: string;
    subject: string;
    templateId: string | null;
    templateName: string | null;
    campaignId: string | null;
    journeyRunId: string | null;
    idempotencyKey: string;
    createdAt: string;
    sentAt: string | null;
    opened: boolean;
    clicked: boolean;
  }[];
};

/* ------------------------------------------------------------------ */
/* Email templates                                                     */
/* ------------------------------------------------------------------ */

export type EmailTemplateDto = {
  id: string;
  name: string;
  subject: string;
  html: string;
  /**
   * What produced `html`: `"tiptap"` is the visual editor and the only value
   * with a structured `doc` behind it; `"html"` is a hand-written body.
   */
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type CopilotEmailResultDto = {
  subject: string;
  doc: EmailDocJson;
  validation: { valid: boolean; issues: { path: string; message: string }[] };
  model: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
};

export type FullEmailTemplateDto = {
  id: string;
  name: string;
  subject: string;
  html: string;
  textBody: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  source: string;
  doc: EmailDocJson | null;
  createdAt: string;
  updatedAt: string;
};

export type EmailPreviewDto = {
  html: string;
  textBody: string;
  mergeTags: string[];
};

/* ------------------------------------------------------------------ */
/* Runs / funnel / dry-run                                             */
/* ------------------------------------------------------------------ */

export type JourneyRunDto = {
  id: string;
  instanceId: string;
  contactId: string;
  status: string;
  journeyVersion: number;
  enteredAt: string;
  exitedAt: string | null;
  email?: string | null;
};

export type FunnelEntryDto = {
  nodeId: string;
  nodeType: string;
  status: string;
  count: number;
};

/**
 * Send + open/click engagement rollup. Provider-dependent: Loopkit relies
 * entirely on Resend's own tracking, so privacy-preserving mail clients can
 * inflate opens. Surface that caveat wherever this is shown.
 */
export type EmailEngagementDto = {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  openRate: number;
  clickRate: number;
};

export type NodeEmailEngagementDto = EmailEngagementDto & { nodeId: string };

export type DryRunStepDto = {
  nodeId: string;
  type: string;
  description: string;
  detail: Record<string, unknown>;
  next: string[];
};

export type DryRunEmailPreviewDto = {
  nodeId: string;
  templateId: string;
  templateName: string | null;
  wouldSend: boolean;
  /** "unsubscribed" | "suppressed:<reason>" | "template_not_found" | null */
  blockedReason: string | null;
  subject: string | null;
  html: string | null;
  text: string | null;
};

export type JourneyDryRunResultDto = {
  startNode: string;
  executionPath: string[];
  steps: DryRunStepDto[];
  emailPreviews: DryRunEmailPreviewDto[];
  warnings: string[];
  errors: { nodeId: string; error: string }[];
  truncated: boolean;
  exited: boolean;
  exitReason?: string;
};

export type SimulationInsightDto = {
  summary: string;
  observations: { title: string; detail: string; severity: "info" | "warning" | "critical" }[];
  suggestions: { title: string; detail: string }[];
  model: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
};

export type JourneySimulationDto = {
  simulation: {
    samples: number;
    exitedCount: number;
    truncatedCount: number;
    endedEarlyCount: number;
    branches: { nodeId: string; type: string; outcomes: { value: string; count: number }[] }[];
    nodeReach: { nodeId: string; count: number }[];
    dropOffs: { nodeId: string; count: number }[];
    exitReasons: { reason: string; count: number }[];
    warnings: { message: string; count: number }[];
    errors: { nodeId: string; error: string; count: number }[];
  };
  perContact: {
    contactId: string;
    pathLength: number;
    exited: boolean;
    truncated: boolean;
    warnings: string[];
    errors: { nodeId: string; error: string }[];
  }[];
  insights: SimulationInsightDto | null;
};

export type DlqEntryDto = {
  id?: string;
  [key: string]: unknown;
};

/* ------------------------------------------------------------------ */
/* Audiences                                                           */
/* ------------------------------------------------------------------ */

export type AudienceDto = {
  id: string;
  name: string;
  filter: SegmentFilterDto;
  createdAt: string;
  updatedAt: string;
};

export type AudienceWithCountsDto = AudienceDto & {
  memberCount: number;
  sendableCount: number;
  summary: string;
};

export type AudienceCopilotResultDto = {
  name: string;
  /** One-line summary from core describeSegmentFilter (not the model). */
  summary: string;
  /** Model's own restatement, for the review card. */
  modelSummary: string;
  filter: SegmentFilterDto;
  model: string;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
};

/* ------------------------------------------------------------------ */
/* Campaigns                                                           */
/* ------------------------------------------------------------------ */

export type CampaignStatusDto =
  | "draft"
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "paused"
  | "cancelled"
  | "failed";

export type CampaignDto = {
  id: string;
  name: string;
  status: CampaignStatusDto;
  templateId: string | null;
  audienceId: string | null;
  subject: string | null;
  preheader: string | null;
  fromName: string | null;
  replyTo: string | null;
  audienceMemberCount: number | null;
  audienceSendableCount: number | null;
  scheduledAt: string | null;
  optimizeSendTime?: boolean;
  recipientCount: number;
  queuedCount: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  launchedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CampaignStatsDto = {
  recipients: number;
  pending: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  providerAccepted: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
};

export type CampaignRecipientDto = {
  id: string;
  contactId: string;
  email: string;
  status: "pending" | "queued" | "sent" | "skipped" | "failed";
  skipReason: string | null;
  error: string | null;
  sentAt: string | null;
};

/* ------------------------------------------------------------------ */
/* Compliance                                                          */
/* ------------------------------------------------------------------ */

export type SuppressionReasonDto = "hard_bounce" | "complaint" | "manual" | "unsubscribe";

export type SuppressionDto = {
  id: string;
  email: string;
  reason: SuppressionReasonDto;
  source: string | null;
  note: string | null;
  createdAt: string;
};

export type SuppressionCountsDto = Record<SuppressionReasonDto, number>;

export type UnsubscribeContextDto = {
  valid: boolean;
  email: string;
  workspaceName: string | null;
  subscribed: boolean;
  suppressed: boolean;
  suppressionReason: SuppressionReasonDto | null;
  canResubscribe: boolean;
};

/* ------------------------------------------------------------------ */
/* Migration / instance search                                         */
/* ------------------------------------------------------------------ */

export type RunMigrationResultDto = {
  runId: string;
  instanceId: string;
  contactId: string;
  fromVersion: number;
  toVersion: number;
  strategy: string;
  previousNodes: string[];
  currentNodes: string[];
};

export type BulkJourneyMigrationResultDto = {
  journeyId: string;
  fromVersions: number[];
  toVersion: number;
  strategy: string;
  migrated: number;
  alreadyOnTarget: number;
  failed: number;
  pending: number;
  results: RunMigrationResultDto[];
  failures: { runId: string; code: string; error: string }[];
};

export type InFlightVersionCountDto = {
  version: number;
  runs: number;
  pending: number;
};

export type MigrationInput = {
  strategy: "strict" | "remap" | "restart";
  nodeMapping?: Record<string, string>;
  targetVersion?: number;
};

export type InstanceSearchRowDto = {
  run: {
    id: string;
    instanceId: string;
    status: string;
    journeyVersion: number;
    enteredAt: string;
    exitedAt: string | null;
    exitReason: string | null;
  };
  journey: { id: string; name: string };
  contact: { id: string; email: string | null };
  currentNodes: string[] | null;
  engineStatus: string | null;
  waitingFor: { nodeId: string; eventType: string }[];
};

export type InstanceSearchParams = {
  email?: string;
  contactId?: string;
  journeyId?: string;
  status?: string;
  waitingEvent?: string;
  limit?: number;
};

/* ------------------------------------------------------------------ */
/* API keys                                                            */
/* ------------------------------------------------------------------ */

export type ApiKeyDto = {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

export type IssuedApiKeyDto = ApiKeyDto & { key: string };

export type ApiKeyMeta = {
  auth: {
    scheme: string;
    header: string;
    prefix: string;
    note: string;
  };
  scopes: { id: string; label: string; description: string; endpoints: string[] }[];
  defaultScopes: string[];
  presets: {
    id: string;
    label: string;
    description: string;
    scopes: string[];
  }[];
  endpoints: {
    method: string;
    path: string;
    summary: string;
    scopes: string[];
    body?: Record<string, string>;
  }[];
};

/* ------------------------------------------------------------------ */
/* Platform: forms, domains, billing, topics, team, audit, channels    */
/* ------------------------------------------------------------------ */

export type FormFieldDto = {
  key: string;
  label: string;
  type: "email" | "text" | "select" | "checkbox";
  required?: boolean;
  options?: string[];
  mapsTo?: string;
};

export type FormStyleDto = {
  primaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  buttonText?: string;
  title?: string;
  description?: string;
};

export type FormDto = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  status: "draft" | "published" | "archived";
  kind: "inline" | "popup" | "floating";
  fields: FormFieldDto[];
  topicIds: string[];
  audienceId: string | null;
  successMessage: string | null;
  doubleOptIn: boolean;
  redirectUrl: string | null;
  style: FormStyleDto;
  embedKey: string;
  views: number;
  submissions: number;
  createdAt: string;
  updatedAt: string;
};

export type DnsRecordDto = {
  type: "TXT" | "CNAME" | "MX";
  host: string;
  value: string;
  purpose: "spf" | "dkim" | "dmarc" | "return-path" | "tracking";
  status: "pending" | "verified";
};

export type SendingDomainDto = {
  id: string;
  workspaceId: string;
  domain: string;
  status: "pending" | "verifying" | "verified" | "failed";
  provider: string;
  providerDomainId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  dnsRecords: DnsRecordDto[];
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlanTierDto = "free" | "starter" | "growth" | "scale";

export type BillingSubscriptionDto = {
  id: string;
  workspaceId: string;
  plan: PlanTierDto;
  status: "trialing" | "active" | "past_due" | "canceled" | "paused";
  provider: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  seats: number;
  monthlyEmailQuota: number;
  monthlyContactQuota: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UsageDto = {
  period: string;
  byMetric: Record<string, number>;
};

export type PlanQuotaDto = {
  monthlyEmailQuota: number;
  monthlyContactQuota: number;
  seats: number;
};

export type PreferenceTopicDto = {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  category: "marketing" | "product" | "transactional";
  active: boolean;
  sortOrder: number;
  createdAt: string;
};

export type ContactTopicDto = {
  topic: PreferenceTopicDto;
  subscribed: boolean;
};

export type WorkspaceMemberDto = {
  id: string;
  userId: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
  email?: string | null;
  name?: string | null;
};

export type WorkspaceInviteDto = {
  id: string;
  workspaceId: string;
  email: string;
  role: "owner" | "admin" | "member";
  invitedBy: string | null;
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
};

export type AuditLogDto = {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  actorType: "user" | "api_key" | "system" | "integration";
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

export type ChannelKindDto = "email" | "sms" | "whatsapp" | "push" | "inapp";

export type ChannelConnectionDto = {
  id: string;
  workspaceId: string;
  channel: ChannelKindDto;
  provider: string;
  status: "disabled" | "enabled" | "error";
  name: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MessageSendDto = {
  id: string;
  workspaceId: string;
  channel: ChannelKindDto;
  contactId: string | null;
  to: string;
  subject: string | null;
  body: string | null;
  status: "queued" | "sent" | "failed" | "skipped";
  idempotencyKey: string;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
};

export type IntegrationKindDto = "stripe" | "shopify" | "segment" | "webhook" | "custom";

export type IntegrationDto = {
  id: string;
  workspaceId: string;
  kind: IntegrationKindDto;
  name: string;
  status: "disabled" | "enabled" | "error";
  slug: string;
  config: Record<string, unknown>;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IssuedIntegrationDto = IntegrationDto & { secret?: string };

export type RevenueReportRowDto = {
  journeyId: string | null;
  journeyName: string | null;
  count: number;
  amountCents: number;
};

export type ContactLtvDto = {
  contactId: string;
  ltvCents: number;
  orderCount: number;
  currency: string;
};

export type RevenueEventDto = {
  id: string;
  workspaceId: string;
  contactId: string;
  type: string;
  orderId: string | null;
  currency: string;
  amountCents: number;
  occurredAt: string;
  attributedJourneyId: string | null;
  attributedRunId: string | null;
  attributionSource: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SendExperimentVariantDto = {
  id: string;
  label: string;
  weight: number;
  subject?: string;
  sendHourLocal?: number;
  sendWeekday?: number;
};

export type SendExperimentDto = {
  id: string;
  workspaceId: string;
  name: string;
  kind: "subject" | "send_time" | "content";
  status: "draft" | "running" | "completed" | "canceled";
  emailTemplateId: string | null;
  journeyId: string | null;
  variants: SendExperimentVariantDto[];
  winnerVariantId: string | null;
  metric: "open" | "click" | "conversion";
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SendExperimentResultDto = {
  id: string;
  experimentId: string;
  variantId: string;
  emailSendId: string | null;
  opened: boolean;
  clicked: boolean;
  converted: boolean;
  createdAt: string;
};

export type JourneyExportDto = {
  id: string;
  workspaceId: string;
  journeyId: string;
  journeyVersion: number | null;
  format: "yaml" | "json";
  document: string;
  checksum: string;
  createdAt: string;
  createdBy: string | null;
};

export type PrivacyJobDto = {
  id: string;
  workspaceId: string;
  contactId: string | null;
  email: string;
  kind: "export" | "erasure";
  status: "pending" | "processing" | "completed" | "failed";
  requestedBy: string | null;
  resultPath: string | null;
  error: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type InvitePreviewDto = {
  valid: boolean;
  email?: string;
  role?: "owner" | "admin" | "member";
  workspaceId?: string;
  error?: string;
};

/* ------------------------------------------------------------------ */
/* Intelligence: lead scoring, plays, website signals                  */
/* ------------------------------------------------------------------ */

export type LeadScoreRuleKindDto = "property" | "event" | "page";
export type LeadScoreOperatorDto =
  | "eq"
  | "neq"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "missing";

export type LeadScoreRuleDto = {
  id: string;
  workspaceId: string;
  name: string;
  active: boolean;
  kind: LeadScoreRuleKindDto;
  propertyKey: string | null;
  operator: LeadScoreOperatorDto | null;
  propertyValue: string | null;
  eventName: string | null;
  pathContains: string | null;
  windowHours: number | null;
  maxHits: number | null;
  points: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type LeadScoreRuleInputDto = {
  name: string;
  active?: boolean;
  kind: LeadScoreRuleKindDto;
  propertyKey?: string | null;
  operator?: LeadScoreOperatorDto | null;
  propertyValue?: string | null;
  eventName?: string | null;
  pathContains?: string | null;
  windowHours?: number | null;
  maxHits?: number | null;
  points: number;
  sortOrder?: number;
};

export type PlayTriggerDto =
  | { kind: "contact_created" }
  | { kind: "event"; name: string; pathContains?: string }
  | { kind: "score_threshold"; min: number; max?: number };

export type PlayActionDto =
  | { type: "set_property"; key: string; value: unknown }
  | { type: "add_tag"; tag: string }
  | { type: "notify"; url: string; message?: string }
  | { type: "start_journey"; journeyId: string };

export type PlayDto = {
  id: string;
  workspaceId: string;
  name: string;
  active: boolean;
  trigger: PlayTriggerDto;
  conditions?: unknown;
  actions: PlayActionDto[];
  runCount: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlayInputDto = {
  name: string;
  active?: boolean;
  trigger: PlayTriggerDto;
  conditions?: unknown;
  actions: PlayActionDto[];
};

export type SignalSettingsDto = {
  workspaceId: string;
  trackingKey: string;
  highIntentPaths: string[];
  intentWebhookUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PageViewDto = {
  id: string;
  contactId: string;
  email: string | null;
  path: Record<string, unknown>;
  occurredAt: string;
};

/* ------------------------------------------------------------------ */
/* GTM: meetings, tasks, companies                                     */
/* ------------------------------------------------------------------ */

export type MeetingSettingsDto = {
  workspaceId: string;
  bookingUrl: string | null;
  meetingTitle: string;
  meetingDescription: string | null;
  durationMinutes: number;
  ctaLabel: string;
  timezone: string;
  availableWeekdays: number[];
  dayStartMinute: number;
  dayEndMinute: number;
  bufferMinutes: number;
  leadDays: number;
  bookingSlug: string | null;
  calendarToken: string | null;
  reminderHoursBefore: number[];
  sendBookingConfirmation: boolean;
  sendReminders: boolean;
  assignmentMode: "round_robin" | "fixed" | "none";
  fixedHostEmail: string | null;
  organizerName: string | null;
  organizerEmail: string | null;
  postMeetingJourneyId: string | null;
  noShowJourneyId: string | null;
  cancellationJourneyId: string | null;
  prepBriefHoursBefore: number;
  createdAt: string;
  updatedAt: string;
};

export type MeetingHostDto = {
  id: string;
  workspaceId: string;
  userId: string | null;
  name: string;
  email: string;
  active: boolean;
  sortOrder: number;
  lastAssignedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MeetingTypeDto = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  durationMinutes: number;
  bookingUrl: string | null;
  ctaLabel: string;
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type SlotDto = {
  startsAt: string;
  endsAt: string;
  available: boolean;
};

export type MeetingStatusDto = "scheduled" | "held" | "cancelled" | "no_show";

export type MeetingDto = {
  id: string;
  contactId: string | null;
  meetingTypeId: string | null;
  title: string;
  guestEmail: string | null;
  guestName: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: MeetingStatusDto;
  source: string;
  notes: string | null;
  outcome: string | null;
  hostUserId?: string | null;
  hostName?: string | null;
  hostEmail?: string | null;
  remindersSent?: number[];
  prepBriefSentAt?: string | null;
  createdAt: string;
  contactEmail?: string | null;
};

export type MeetingPrepBriefDto = {
  meeting: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
    status: string;
    source: string;
    notes: string | null;
    hostName: string | null;
    hostEmail: string | null;
  };
  contact: {
    id: string | null;
    email: string | null;
    name: string | null;
    leadScore: number;
    leadTier: string;
    tags: string[];
    ltvCents: number;
  };
  company: {
    name: string;
    domain: string;
    contactCount: number;
    hotLeadCount: number;
    totalLtvCents: number;
  } | null;
  signals: Array<{ name: string; path?: string; occurredAt: string }>;
  timeline: Array<{ name: string; occurredAt: string; properties: Record<string, unknown> }>;
  history: Array<{ title: string; startsAt: string; status: string; outcome: string | null }>;
  openTasks: Array<{ title: string; kind: string; dueAt: string | null; priority: number }>;
  talkingPoints: string[];
};

export type MeetingOutcomeIntelDto = {
  leadScore?: number;
  leadTier?: string;
  tasksCreated: string[];
  journeyStarts: string[];
  playsFired: string[];
  outcomeScoreDelta: number;
} | null;

export type RankedSlotDto = {
  startsAt: string;
  endsAt: string;
  available: boolean;
  score: number;
  reasons: string[];
  hostEmail: string | null;
};

export type PublicBookingPayloadDto = {
  workspaceId: string;
  settings: {
    meetingTitle?: string;
    meetingDescription?: string | null;
    ctaLabel?: string;
    timezone?: string;
    durationMinutes?: number;
    bookingUrl?: string | null;
  };
  types: Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    durationMinutes: number;
    ctaLabel: string;
    isDefault: boolean;
    bookingUrl: string | null;
  }>;
  slots: SlotDto[];
};

export type TaskKindDto = "call" | "email" | "meeting" | "review" | "custom";
export type TaskStatusDto = "open" | "done" | "dismissed";

export type TaskDto = {
  id: string;
  contactId: string;
  email: string;
  title: string;
  body: string | null;
  kind: TaskKindDto;
  status: TaskStatusDto;
  priority: number;
  dueAt: string | null;
  source: string;
  sourceId: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type TaskStatsDto = {
  open: number;
  done: number;
  dismissed: number;
  total: number;
};

export type CompanyDto = {
  id: string;
  workspaceId: string;
  domain: string;
  name: string;
  properties: Record<string, unknown>;
  contactCount: number;
  hotLeadCount: number;
  totalLeadScore: number;
  totalLtvCents: number;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompanyContactDto = {
  id: string;
  email: string;
  properties: Record<string, unknown>;
  subscribed: boolean;
  createdAt: string;
};
