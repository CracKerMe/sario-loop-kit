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
