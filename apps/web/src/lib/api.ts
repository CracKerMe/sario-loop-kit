import type { EmailDocJson } from "@loopkit/email-doc";
import { env } from "@loopkit/env/web";

export function baseUrl(): string {
  const raw = env.VITE_SERVER_URL;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

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

export type ValidationIssue = { nodeId?: string; message: string };
export type ValidationResult = { valid: boolean; issues: ValidationIssue[] };

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

export type EmailTemplateDto = {
  id: string;
  name: string;
  subject: string;
  html: string;
  /**
   * What produced `html`: `"tiptap"` is the visual editor and the only value
   * with a structured `doc` behind it; `"html"` is a hand-written body. The
   * list needs it to label a card "Visual editor / Raw HTML", so it is part of
   * the list payload even though `doc` is not.
   */
  source: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The full template record as stored by the server. `doc` is the structured
 * email document the visual editor reads and writes; `html`/`textBody` are
 * server-rendered products. A template created as raw HTML has `doc: null`
 * and `source: "html"`.
 */
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

/** Response from `POST /v1/email-templates/preview`. */
export type EmailPreviewDto = {
  html: string;
  textBody: string;
  mergeTags: string[];
};

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

/** One walked node from a journey dry-run (publish preview). */
export type DryRunStepDto = {
  nodeId: string;
  type: string;
  description: string;
  detail: Record<string, unknown>;
  next: string[];
};

/** Rendered "what would be sent" preview for one email node in a dry-run. */
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
/* Segments / audiences                                                */
/* ------------------------------------------------------------------ */

export type SegmentOperator =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists";

export type SegmentConditionDto = {
  kind: "condition";
  field: string;
  operator: SegmentOperator;
  value?: string | number | boolean | null | string[] | number[];
};

export type SegmentEventConditionDto = {
  kind: "event";
  name: string;
  occurred: boolean;
  withinDays?: number;
  minCount?: number;
};

export type SegmentFilterDto =
  | SegmentConditionDto
  | SegmentEventConditionDto
  | { op: "and" | "or"; children: SegmentFilterDto[] }
  | { op: "not"; child: SegmentFilterDto };

export type AudienceDto = {
  id: string;
  name: string;
  filter: SegmentFilterDto;
  createdAt: string;
  updatedAt: string;
};

export type AudienceWithCountsDto = AudienceDto & {
  /** Everyone matching the filter. */
  memberCount: number;
  /** Matching AND mailable (subscribed, not suppressed). */
  sendableCount: number;
  summary: string;
};

/** P3.6 audience copilot: NL → guarded SegmentFilter AST. */
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

/** One run moved to another journey version by a migration. */
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

/** Bulk result of migrating every in-flight run of a journey. */
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

/** In-flight run counts per journey version (migration dialog input). */
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

export type UnsubscribeContextDto = {
  valid: boolean;
  email: string;
  workspaceName: string | null;
  subscribed: boolean;
  suppressed: boolean;
  suppressionReason: SuppressionReasonDto | null;
  canResubscribe: boolean;
};

/** One enriched run from the instance search (GET /v1/runs). */
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
  /** Engine's authoritative in-flight nodes ("stuck at"); null when unknown. */
  currentNodes: string[] | null;
  engineStatus: string | null;
  /** Present only while a wait is pending — "parked on node X waiting for event Y". */
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

export const api = {
  stats: () => request<{ stats: Record<string, unknown> }>("/v1/ops/stats"),
  dlq: () => request<{ entries: unknown[] }>("/v1/ops/dlq"),
  searchInstances: (params: InstanceSearchParams = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ runs: InstanceSearchRowDto[] }>(`/v1/runs${suffix}`);
  },
  journeys: () => request<{ journeys: JourneyDto[] }>("/v1/journeys"),
  copilotGenerate: (requestText: string) =>
    request<CopilotResultDto>("/v1/journeys/copilot", {
      method: "POST",
      body: JSON.stringify({ request: requestText }),
    }),
  journey: (id: string) =>
    request<{
      journey: JourneyDto;
      graph: JourneyGraphDto | null;
      version: number | null;
      runCounts: Record<string, number>;
      validation: ValidationResult | null;
    }>(`/v1/journeys/${id}`),
  createJourney: (name: string, graph: JourneyGraphDto) =>
    request<{ journeyId: string; validation: ValidationResult }>("/v1/journeys", {
      method: "POST",
      body: JSON.stringify({ name, graph }),
    }),
  saveDraft: (id: string, graph: JourneyGraphDto) =>
    request<{ version: number; validation: ValidationResult }>(`/v1/journeys/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({ graph }),
    }),
  publishJourney: (id: string) =>
    request<{ ok: true }>(`/v1/journeys/${id}/publish`, { method: "POST" }),
  inflightVersions: (id: string) =>
    request<{ versions: InFlightVersionCountDto[] }>(`/v1/journeys/${id}/inflight-versions`),
  migrateInFlight: (id: string, input: MigrationInput) =>
    request<BulkJourneyMigrationResultDto>(`/v1/journeys/${id}/migrate-inflight`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  migrateRun: (instanceId: string, input: MigrationInput) =>
    request<RunMigrationResultDto>(`/v1/runs/${instanceId}/migrate`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  journeyDryRun: (id: string, body: { contactId: string; stopAfterNode?: string }) =>
    request<JourneyDryRunResultDto>(`/v1/journeys/${id}/dry-run`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Cohort simulation with optional AI interpretation (see SimulateDialog). */
  journeySimulate: (id: string, body: { sampleSize?: number; insight?: boolean }) =>
    request<JourneySimulationDto>(`/v1/journeys/${id}/simulate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** P3.5 — ask the model for a revised graph from live funnel metrics. */
  journeyOptimize: (id: string, body: { request?: string; language?: string } = {}) =>
    request<JourneyOptimizationProposeDto>(`/v1/journeys/${id}/optimize`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  journeyOptimizations: (id: string) =>
    request<{ optimizations: JourneyOptimizationDto[] }>(`/v1/journeys/${id}/optimizations`),
  acceptOptimization: (journeyId: string, optimizationId: string, body: AcceptOptimizationInput) =>
    request<AcceptOptimizationResultDto>(
      `/v1/journeys/${journeyId}/optimizations/${optimizationId}/accept`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  journeyCanary: (id: string) => request<JourneyCanaryStatusDto>(`/v1/journeys/${id}/canary`),
  evaluateCanary: (id: string, body: { force?: boolean; autoApply?: boolean } = {}) =>
    request<{
      canary: JourneyCanaryRowDto;
      comparison: CanaryComparisonDto;
      applied: "promoted" | "rolled_back" | null;
    }>(`/v1/journeys/${id}/canary/evaluate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  promoteCanary: (id: string) =>
    request<{ ok: true; result: "promoted" }>(`/v1/journeys/${id}/canary/promote`, {
      method: "POST",
    }),
  rollbackCanary: (id: string) =>
    request<{ ok: true; result: "rolled_back" }>(`/v1/journeys/${id}/canary/rollback`, {
      method: "POST",
    }),
  pauseJourney: (id: string) =>
    request<{ ok: true }>(`/v1/journeys/${id}/pause`, { method: "POST" }),
  journeyRuns: (id: string) => request<{ runs: JourneyRunDto[] }>(`/v1/journeys/${id}/runs`),
  journeyFunnel: (id: string) =>
    request<{ funnel: FunnelEntryDto[]; runCounts: Record<string, number> }>(
      `/v1/journeys/${id}/funnel`,
    ),
  runDetail: (instanceId: string) =>
    request<{ run: JourneyRunDto; instance: unknown }>(`/v1/runs/${instanceId}`),
  cancelRun: (instanceId: string) =>
    request<{ ok: true }>(`/v1/runs/${instanceId}/cancel`, { method: "POST" }),
  contacts: (params: { query?: string; status?: "all" | "subscribed" | "unsubscribed" } = {}) => {
    const search = new URLSearchParams();
    if (params.query) search.set("query", params.query);
    if (params.status && params.status !== "all") search.set("status", params.status);
    const query = search.toString();
    return request<{ contacts: ContactDto[]; total: number }>(
      `/v1/contacts${query ? `?${query}` : ""}`,
    );
  },
  contact: (id: string) =>
    request<{ contact: ContactDto; events: ContactEventDto[] }>(`/v1/contacts/${id}`),
  /** Contact 360 — deliverability + recent runs/sends. */
  contactActivity: (id: string) =>
    request<{
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
      }[];
    }>(`/v1/contacts/${id}/activity`),
  /** Dashboard test-send for transactional path (session auth). */
  sendTransactional: (input: {
    to: string;
    templateId: string;
    subject?: string;
    variables?: Record<string, unknown>;
    idempotencyKey: string;
  }) =>
    request<{
      send: { id: string; status: string; to: string; subject: string } | null;
      outcome?: string;
      duplicate?: boolean;
    }>("/v1/transactional", { method: "POST", body: JSON.stringify(input) }),
  contactPropertyKeys: () => request<{ keys: string[] }>("/v1/contacts/property-keys"),
  replaceContactProperties: (id: string, properties: Record<string, unknown>) =>
    request<{ contact: ContactDto }>(`/v1/contacts/${id}/properties`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    }),
  createContact: (input: {
    email: string;
    userId?: string;
    properties?: Record<string, unknown>;
  }) =>
    request<{ contact: ContactDto }>("/v1/contacts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  importContacts: (input: {
    rows: {
      email: string;
      userId?: string;
      properties?: Record<string, unknown>;
      subscribed?: boolean;
    }[];
    signalTriggers?: boolean;
  }) =>
    request<{
      total: number;
      created: number;
      updated: number;
      failed: number;
      errors: { line: number; email?: string; message: string }[];
    }>("/v1/contacts/import", { method: "POST", body: JSON.stringify(input) }),
  bulkUpdateContacts: (input: {
    action: "unsubscribe" | "resubscribe" | "delete";
    ids: string[];
  }) =>
    request<{ affected: number }>("/v1/contacts/bulk", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  unsubscribeContact: (id: string) =>
    request<{ ok: true }>(`/v1/contacts/${id}/unsubscribe`, { method: "POST" }),
  templates: () => request<{ templates: EmailTemplateDto[] }>("/v1/email-templates"),
  createTemplate: (input: { name: string; subject: string; html: string }) =>
    request<{ template: EmailTemplateDto }>("/v1/email-templates", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTemplate: (id: string, input: { name?: string; subject?: string; html?: string }) =>
    request<{ template: EmailTemplateDto }>(`/v1/email-templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  /** Pre-flight usage check: which campaigns/journeys reference this template. */
  getTemplateUsage: (id: string) =>
    request<{
      usage: {
        campaigns: { id: string; name: string; status: string }[];
        journeys: { id: string; name: string; status: string }[];
      };
    }>(`/v1/email-templates/${id}/usage`),
  /** Delete an email template. Client should call getTemplateUsage first. */
  deleteTemplate: (id: string) =>
    request<{ ok: true }>(`/v1/email-templates/${id}`, { method: "DELETE" }),

  /* Visual (doc-based) email editor -------------------------------- */
  /** Fetch a single template with its structured `doc` (may be null for HTML-only templates). */
  getTemplate: (id: string) =>
    request<{ template: FullEmailTemplateDto }>(`/v1/email-templates/${id}`),
  /**
   * Render a document to email HTML the same way the server will when sending.
   * On an invalid document the server responds 400 with `{ error: "invalid_doc",
   * details: [{ path, message }] }`; `ApiError.body` carries that payload.
   */
  previewEmailTemplate: (doc: EmailDocJson) =>
    request<EmailPreviewDto>("/v1/email-templates/preview", {
      method: "POST",
      body: JSON.stringify({ doc }),
    }),
  /** Save a structured document (optionally with name/subject). Server renders `html` itself. */
  updateTemplateDoc: (id: string, input: { doc: EmailDocJson; name?: string; subject?: string }) =>
    request<{ template: FullEmailTemplateDto }>(`/v1/email-templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  /** Create a new template from a structured document; `source` becomes "tiptap". */
  createTemplateFromDoc: (input: { name: string; subject: string; doc: EmailDocJson }) =>
    request<{ template: FullEmailTemplateDto }>("/v1/email-templates", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /**
   * Email copilot: natural language to a guarded `{subject, doc}`. Error
   * semantics: 503 ai_not_configured, 502 ai_guard_rejected (issues only),
   * 400 invalid_request — `ApiError.body` carries them.
   */
  copilotEmailTemplate: (input: { request: string; tone?: string; audience?: string }) =>
    request<CopilotEmailResultDto>("/v1/email-templates/copilot", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  apiKeys: () => request<{ apiKeys: ApiKeyDto[] }>("/v1/api-keys"),
  apiKeyMeta: () => request<ApiKeyMeta>("/v1/api-keys/meta"),
  createApiKey: (input: {
    name: string;
    description?: string | null;
    scopes?: string[];
    expiresInDays?: number | null;
  }) =>
    request<{ apiKey: IssuedApiKeyDto }>("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateApiKey: (
    id: string,
    input: { name?: string; description?: string | null; scopes?: string[] },
  ) =>
    request<{ apiKey: ApiKeyDto }>(`/v1/api-keys/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  rotateApiKey: (id: string) =>
    request<{ apiKey: IssuedApiKeyDto }>(`/v1/api-keys/${id}/rotate`, { method: "POST" }),
  revokeApiKey: (id: string) => request<{ ok: true }>(`/v1/api-keys/${id}`, { method: "DELETE" }),

  /* Audiences ------------------------------------------------------- */
  audiences: () => request<{ audiences: AudienceWithCountsDto[]; total: number }>("/v1/audiences"),
  audience: (id: string) =>
    request<{
      audience: AudienceDto;
      memberCount: number;
      sendableCount: number;
      contacts: ContactDto[];
      matching: number;
    }>(`/v1/audiences/${id}`),
  audienceContacts: (id: string, params: { limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.limit) search.set("limit", String(params.limit));
    if (params.offset) search.set("offset", String(params.offset));
    const query = search.toString();
    return request<{ contacts: ContactDto[]; total: number; truncated: boolean }>(
      `/v1/audiences/${id}/contacts${query ? `?${query}` : ""}`,
    );
  },
  createAudience: (input: { name: string; filter: SegmentFilterDto }) =>
    request<{ audience: AudienceDto; memberCount: number; sendableCount: number }>(
      "/v1/audiences",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  updateAudience: (id: string, input: { name?: string; filter?: SegmentFilterDto }) =>
    request<{ audience: AudienceWithCountsDto }>(`/v1/audiences/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteAudience: (id: string) =>
    request<{ ok: true }>(`/v1/audiences/${id}`, { method: "DELETE" }),
  /** Live "N contacts match" for an unsaved filter. */
  previewAudience: (filter: SegmentFilterDto) =>
    request<{ memberCount: number; sendableCount: number }>("/v1/audiences/preview", {
      method: "POST",
      body: JSON.stringify({ filter }),
    }),
  /** Natural language → guarded SegmentFilter (P3.6). */
  audienceCopilot: (input: { request: string; today?: string }) =>
    request<AudienceCopilotResultDto>("/v1/audiences/copilot", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* Campaigns ------------------------------------------------------- */
  campaigns: () => request<{ campaigns: CampaignDto[]; total: number }>("/v1/campaigns"),
  campaign: (id: string) =>
    request<{ campaign: CampaignDto; stats: CampaignStatsDto }>(`/v1/campaigns/${id}`),
  createCampaign: (input: {
    name: string;
    templateId: string;
    audienceId: string;
    subject?: string;
    preheader?: string;
    fromName?: string;
    replyTo?: string;
  }) =>
    request<{ campaign: CampaignDto }>("/v1/campaigns", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateCampaign: (
    id: string,
    input: {
      name?: string;
      templateId?: string;
      audienceId?: string;
      subject?: string;
      preheader?: string;
      fromName?: string;
      replyTo?: string;
    },
  ) =>
    request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteCampaign: (id: string) =>
    request<{ ok: true }>(`/v1/campaigns/${id}`, { method: "DELETE" }),
  duplicateCampaign: (id: string, name?: string) =>
    request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}/duplicate`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    }),
  /** Resolve + materialize the audience, then start draining. */
  launchCampaign: (id: string) =>
    request<{ campaign: CampaignDto; recipients: number; excludedUnsendable: number }>(
      `/v1/campaigns/${id}/launch`,
      { method: "POST" },
    ),
  resumeCampaign: (id: string) =>
    request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}/resume`, { method: "POST" }),
  pauseCampaign: (id: string) =>
    request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}/pause`, { method: "POST" }),
  cancelCampaign: (id: string) =>
    request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}/cancel`, { method: "POST" }),
  campaignRecipients: (id: string, params: { status?: string; page?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set("status", params.status);
    if (params.page) search.set("page", String(params.page));
    const query = search.toString();
    return request<{ recipients: CampaignRecipientDto[]; total: number }>(
      `/v1/campaigns/${id}/recipients${query ? `?${query}` : ""}`,
    );
  },

  /* Compliance ------------------------------------------------------ */
  suppressions: (params: { query?: string; reason?: string; page?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.query) search.set("query", params.query);
    if (params.reason) search.set("reason", params.reason);
    if (params.page) search.set("page", String(params.page));
    const query = search.toString();
    return request<{
      suppressions: SuppressionDto[];
      total: number;
      counts: SuppressionCountsDto;
    }>(`/v1/suppressions${query ? `?${query}` : ""}`);
  },
  addSuppression: (input: { email: string; reason?: "manual" | "unsubscribe"; note?: string }) =>
    request<{ suppression: SuppressionDto | null; created: boolean }>("/v1/suppressions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  importSuppressions: (addresses: string, note?: string) =>
    request<{
      submitted: number;
      added: number;
      alreadyPresent: number;
      skipped: number;
    }>("/v1/suppressions/import", {
      method: "POST",
      body: JSON.stringify({ addresses, note }),
    }),
  removeSuppression: (id: string) =>
    request<{ ok: true }>(`/v1/suppressions/${id}`, { method: "DELETE" }),

  /* Public (no session — the signed token is the capability) -------- */
  unsubscribeContext: (token: string) =>
    request<UnsubscribeContextDto>(`/v1/public/unsubscribe?token=${encodeURIComponent(token)}`),
  submitUnsubscribe: (token: string, action: "unsubscribe" | "resubscribe") =>
    request<{ ok: boolean; subscribed?: boolean; error?: string; message?: string }>(
      "/v1/public/unsubscribe",
      {
        method: "POST",
        body: JSON.stringify({ token, action }),
      },
    ),
};

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

export { baseUrl as getApiBaseUrl };
