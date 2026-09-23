import type { EmailDocJson } from "@loopkit/email-doc";

import { qs, request } from "./http";
import type {
  AcceptOptimizationInput,
  AcceptOptimizationResultDto,
  ApiKeyDto,
  ApiKeyMeta,
  AudienceCopilotResultDto,
  AudienceDto,
  AudienceWithCountsDto,
  BulkJourneyMigrationResultDto,
  CampaignDto,
  CampaignRecipientDto,
  CampaignStatsDto,
  CanaryComparisonDto,
  ContactActivityDto,
  ContactDto,
  ContactEventDto,
  CopilotEmailResultDto,
  CopilotResultDto,
  EmailEngagementDto,
  EmailPreviewDto,
  EmailTemplateDto,
  FullEmailTemplateDto,
  FunnelEntryDto,
  InFlightVersionCountDto,
  InstanceSearchParams,
  InstanceSearchRowDto,
  IssuedApiKeyDto,
  JourneyCanaryRowDto,
  JourneyCanaryStatusDto,
  JourneyDryRunResultDto,
  JourneyDto,
  JourneyGraphDto,
  JourneyOptimizationDto,
  JourneyOptimizationProposeDto,
  JourneyRunDto,
  JourneySimulationDto,
  MigrationInput,
  NodeEmailEngagementDto,
  RunMigrationResultDto,
  SegmentFilterDto,
  SuppressionCountsDto,
  SuppressionDto,
  UnsubscribeContextDto,
  ValidationResult,
} from "./types";

export const api = {
  /* Ops --------------------------------------------------------------- */
  stats: () => request<{ stats: Record<string, unknown> }>("/v1/ops/stats"),
  dlq: () => request<{ entries: unknown[] }>("/v1/ops/dlq"),
  searchInstances: (params: InstanceSearchParams = {}) =>
    request<{ runs: InstanceSearchRowDto[] }>(`/v1/runs${qs(params)}`),

  /* Journeys ---------------------------------------------------------- */
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
  pauseJourney: (id: string) =>
    request<{ ok: true }>(`/v1/journeys/${id}/pause`, { method: "POST" }),
  archiveJourney: (id: string) =>
    request<{ ok: true }>(`/v1/journeys/${id}/archive`, { method: "POST" }),
  deleteJourney: (id: string) => request<{ ok: true }>(`/v1/journeys/${id}`, { method: "DELETE" }),
  journeyRuns: (id: string) => request<{ runs: JourneyRunDto[] }>(`/v1/journeys/${id}/runs`),
  journeyFunnel: (id: string) =>
    request<{
      funnel: FunnelEntryDto[];
      runCounts: Record<string, number>;
      emailEngagement: NodeEmailEngagementDto[];
    }>(`/v1/journeys/${id}/funnel`),

  /* Lab: dry-run / simulate / optimize / canary / migrate --------------- */
  journeyDryRun: (id: string, body: { contactId: string; stopAfterNode?: string }) =>
    request<JourneyDryRunResultDto>(`/v1/journeys/${id}/dry-run`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  journeySimulate: (id: string, body: { sampleSize?: number; insight?: boolean }) =>
    request<JourneySimulationDto>(`/v1/journeys/${id}/simulate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
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
  runDetail: (instanceId: string) =>
    request<{ run: JourneyRunDto; instance: unknown }>(`/v1/runs/${instanceId}`),
  cancelRun: (instanceId: string) =>
    request<{ ok: true }>(`/v1/runs/${instanceId}/cancel`, { method: "POST" }),

  /* Contacts ----------------------------------------------------------- */
  contacts: (params: { query?: string; status?: "all" | "subscribed" | "unsubscribed" } = {}) =>
    request<{ contacts: ContactDto[]; total: number }>(
      `/v1/contacts${qs({
        query: params.query,
        status: params.status && params.status !== "all" ? params.status : undefined,
      })}`,
    ),
  contact: (id: string) =>
    request<{ contact: ContactDto; events: ContactEventDto[] }>(`/v1/contacts/${id}`),
  contactActivity: (id: string) => request<ContactActivityDto>(`/v1/contacts/${id}/activity`),
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

  /* Email templates ---------------------------------------------------- */
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
  getTemplateUsage: (id: string) =>
    request<{
      usage: {
        campaigns: { id: string; name: string; status: string }[];
        journeys: { id: string; name: string; status: string }[];
      };
    }>(`/v1/email-templates/${id}/usage`),
  deleteTemplate: (id: string) =>
    request<{ ok: true }>(`/v1/email-templates/${id}`, { method: "DELETE" }),
  getTemplateEngagement: (id: string) =>
    request<{ engagement: EmailEngagementDto }>(`/v1/email-templates/${id}/engagement`),
  getTemplate: (id: string) =>
    request<{ template: FullEmailTemplateDto }>(`/v1/email-templates/${id}`),
  previewEmailTemplate: (doc: EmailDocJson) =>
    request<EmailPreviewDto>("/v1/email-templates/preview", {
      method: "POST",
      body: JSON.stringify({ doc }),
    }),
  updateTemplateDoc: (id: string, input: { doc: EmailDocJson; name?: string; subject?: string }) =>
    request<{ template: FullEmailTemplateDto }>(`/v1/email-templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  createTemplateFromDoc: (input: { name: string; subject: string; doc: EmailDocJson }) =>
    request<{ template: FullEmailTemplateDto }>("/v1/email-templates", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  copilotEmailTemplate: (input: { request: string; tone?: string; audience?: string }) =>
    request<CopilotEmailResultDto>("/v1/email-templates/copilot", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* API keys ----------------------------------------------------------- */
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

  /* Audiences ---------------------------------------------------------- */
  audiences: () => request<{ audiences: AudienceWithCountsDto[]; total: number }>("/v1/audiences"),
  audience: (id: string) =>
    request<{
      audience: AudienceDto;
      memberCount: number;
      sendableCount: number;
      contacts: ContactDto[];
      matching: number;
    }>(`/v1/audiences/${id}`),
  audienceContacts: (id: string, params: { limit?: number; offset?: number } = {}) =>
    request<{ contacts: ContactDto[]; total: number; truncated: boolean }>(
      `/v1/audiences/${id}/contacts${qs(params)}`,
    ),
  createAudience: (input: { name: string; filter: SegmentFilterDto }) =>
    request<{ audience: AudienceDto; memberCount: number; sendableCount: number }>(
      "/v1/audiences",
      { method: "POST", body: JSON.stringify(input) },
    ),
  updateAudience: (id: string, input: { name?: string; filter?: SegmentFilterDto }) =>
    request<{ audience: AudienceWithCountsDto }>(`/v1/audiences/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteAudience: (id: string) =>
    request<{ ok: true }>(`/v1/audiences/${id}`, { method: "DELETE" }),
  previewAudience: (filter: SegmentFilterDto) =>
    request<{ memberCount: number; sendableCount: number }>("/v1/audiences/preview", {
      method: "POST",
      body: JSON.stringify({ filter }),
    }),
  audienceCopilot: (input: { request: string; today?: string }) =>
    request<AudienceCopilotResultDto>("/v1/audiences/copilot", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* Campaigns ---------------------------------------------------------- */
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
  launchCampaign: (id: string) =>
    request<{ campaign: CampaignDto; recipients: number; excludedUnsendable: number }>(
      `/v1/campaigns/${id}/launch`,
      { method: "POST" },
    ),
  scheduleCampaign: (id: string, scheduledAt: Date) =>
    request<{ campaign: CampaignDto; recipients: number; excludedUnsendable: number }>(
      `/v1/campaigns/${id}/schedule`,
      { method: "POST", body: JSON.stringify({ scheduledAt: scheduledAt.toISOString() }) },
    ),
  unscheduleCampaign: (id: string) =>
    request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}/unschedule`, { method: "POST" }),
  resumeCampaign: (id: string) =>
    request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}/resume`, { method: "POST" }),
  pauseCampaign: (id: string) =>
    request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}/pause`, { method: "POST" }),
  cancelCampaign: (id: string) =>
    request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}/cancel`, { method: "POST" }),
  campaignRecipients: (id: string, params: { status?: string; page?: number } = {}) =>
    request<{ recipients: CampaignRecipientDto[]; total: number }>(
      `/v1/campaigns/${id}/recipients${qs(params)}`,
    ),

  /* Compliance --------------------------------------------------------- */
  suppressions: (params: { query?: string; reason?: string; page?: number } = {}) =>
    request<{
      suppressions: SuppressionDto[];
      total: number;
      counts: SuppressionCountsDto;
    }>(`/v1/suppressions${qs(params)}`),
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

  /* Public (signed token is the capability) ---------------------------- */
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

export type Api = typeof api;
