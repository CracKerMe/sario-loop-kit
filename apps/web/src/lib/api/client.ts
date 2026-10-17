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
  JourneyLiftReportDto,
  JourneyOptimizationDto,
  JourneyOptimizationProposeDto,
  JourneyRunDto,
  JourneySimulationDto,
  MigrationInput,
  NodeEmailEngagementDto,
  OpsAlertDto,
  OpsHealthSnapshotDto,
  RunMigrationResultDto,
  SegmentFilterDto,
  AuditLogDto,
  BillingSubscriptionDto,
  ChannelConnectionDto,
  ChannelKindDto,
  ContactLtvDto,
  ContactTopicDto,
  FormDto,
  FormFieldDto,
  FormStyleDto,
  IntegrationDto,
  IntegrationKindDto,
  InvitePreviewDto,
  IssuedIntegrationDto,
  JourneyExportDto,
  MessageSendDto,
  PlanQuotaDto,
  PlanTierDto,
  PreferenceTopicDto,
  PrivacyJobDto,
  RevenueEventDto,
  RevenueReportRowDto,
  SendExperimentDto,
  SendExperimentResultDto,
  SendExperimentVariantDto,
  SendingDomainDto,
  SuppressionCountsDto,
  SuppressionDto,
  UnsubscribeContextDto,
  UsageDto,
  ValidationResult,
  WorkspaceInviteDto,
  WorkspaceMemberDto,
  LeadScoreRuleDto,
  LeadScoreRuleInputDto,
  MeetingHostDto,
  MeetingOutcomeIntelDto,
  MeetingPrepBriefDto,
  MeetingSettingsDto,
  MeetingTypeDto,
  MeetingDto,
  PageViewDto,
  CompanyContactDto,
  CompanyDto,
  PlayDto,
  PlayInputDto,
  PublicBookingPayloadDto,
  SignalSettingsDto,
  SlotDto,
  TaskDto,
  TaskKindDto,
  TaskStatsDto,
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

  /* Holdout & incremental lift ---------------------------------------- */
  journeyLift: (id: string, params: { since?: string; goalEvent?: string } = {}) =>
    request<JourneyLiftReportDto>(`/v1/journeys/${id}/lift${qs(params)}`),
  updateJourneyHoldout: (
    id: string,
    body: { holdoutPercent?: number; holdoutGoalEvent?: string | null },
  ) =>
    request<{ ok: true; report: JourneyLiftReportDto | null }>(`/v1/journeys/${id}/holdout`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /* Ops health --------------------------------------------------------- */
  opsHealth: (windowHours = 24) =>
    request<OpsHealthSnapshotDto>(`/v1/ops/health${qs({ windowHours })}`),
  opsAlerts: (limit = 50) => request<{ alerts: OpsAlertDto[] }>(`/v1/ops/alerts${qs({ limit })}`),
  resolveOpsAlert: (id: string, note?: string) =>
    request<{ ok: true }>(`/v1/ops/alerts/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),

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
    optimizeSendTime?: boolean;
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
      optimizeSendTime?: boolean;
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
  submitUnsubscribe: (
    token: string,
    action: "unsubscribe" | "resubscribe",
    topics?: { topicId: string; subscribed: boolean }[],
  ) =>
    request<{
      ok: boolean;
      subscribed?: boolean;
      topics?: ContactTopicDto[];
      error?: string;
      message?: string;
    }>("/v1/public/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ token, action, topics }),
    }),

  /* Platform: forms --------------------------------------------------- */
  forms: () => request<{ forms: FormDto[] }>("/v1/forms"),
  form: (id: string) => request<{ form: FormDto }>(`/v1/forms/${id}`),
  createForm: (input: {
    name: string;
    slug: string;
    kind?: "inline" | "popup" | "floating";
    fields?: FormFieldDto[];
    topicIds?: string[];
    doubleOptIn?: boolean;
    successMessage?: string;
    redirectUrl?: string | null;
    style?: FormStyleDto;
  }) => request<{ form: FormDto }>("/v1/forms", { method: "POST", body: JSON.stringify(input) }),
  updateForm: (
    id: string,
    input: Partial<{
      name: string;
      status: "draft" | "published" | "archived";
      kind: "inline" | "popup" | "floating";
      fields: FormFieldDto[];
      topicIds: string[];
      doubleOptIn: boolean;
      successMessage: string;
      redirectUrl: string | null;
      style: FormStyleDto;
    }>,
  ) =>
    request<{ form: FormDto }>(`/v1/forms/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteForm: (id: string) => request<{ ok: true }>(`/v1/forms/${id}`, { method: "DELETE" }),

  /* Platform: sending domains ------------------------------------------ */
  domains: () => request<{ domains: SendingDomainDto[] }>("/v1/domains"),
  createDomain: (input: {
    domain: string;
    fromName?: string;
    fromEmail?: string;
    replyTo?: string;
  }) =>
    request<{ domain: SendingDomainDto }>("/v1/domains", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  verifyDomain: (id: string, body: { manual?: boolean; resolvedHosts?: string[] } = {}) =>
    request<{ domain: SendingDomainDto }>(`/v1/domains/${id}/verify`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteDomain: (id: string) => request<{ ok: true }>(`/v1/domains/${id}`, { method: "DELETE" }),

  /* Platform: billing -------------------------------------------------- */
  billing: () =>
    request<{
      subscription: BillingSubscriptionDto;
      usage: UsageDto;
      plans: Record<PlanTierDto, PlanQuotaDto>;
    }>("/v1/billing"),
  changePlan: (plan: PlanTierDto) =>
    request<{ subscription: BillingSubscriptionDto }>("/v1/billing/plan", {
      method: "POST",
      body: JSON.stringify({ plan }),
    }),

  /* Platform: preference topics ---------------------------------------- */
  topics: () => request<{ topics: PreferenceTopicDto[] }>("/v1/topics"),
  createTopic: (input: {
    key: string;
    name: string;
    description?: string | null;
    category?: "marketing" | "product" | "transactional";
    sortOrder?: number;
    active?: boolean;
  }) =>
    request<{ topic: PreferenceTopicDto }>("/v1/topics", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTopic: (
    id: string,
    input: {
      key: string;
      name: string;
      description?: string | null;
      category?: "marketing" | "product" | "transactional";
      sortOrder?: number;
      active?: boolean;
    },
  ) =>
    request<{ topic: PreferenceTopicDto }>(`/v1/topics/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteTopic: (id: string) => request<{ ok: true }>(`/v1/topics/${id}`, { method: "DELETE" }),

  /* Platform: contact topics ------------------------------------------- */
  contactTopics: (contactId: string) =>
    request<{ topics: ContactTopicDto[] }>(`/v1/contacts/${contactId}/topics`),
  updateContactTopics: (contactId: string, topics: { topicId: string; subscribed: boolean }[]) =>
    request<{ topics: ContactTopicDto[] }>(`/v1/contacts/${contactId}/topics`, {
      method: "PUT",
      body: JSON.stringify({ topics }),
    }),

  /* Platform: members / invites ---------------------------------------- */
  members: () =>
    request<{ members: WorkspaceMemberDto[]; invites: WorkspaceInviteDto[] }>("/v1/members"),
  inviteMember: (input: { email: string; role: "owner" | "admin" | "member" }) =>
    request<{ invite: WorkspaceInviteDto; token: string }>("/v1/members/invites", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateMemberRole: (id: string, role: "owner" | "admin" | "member") =>
    request<{ member: WorkspaceMemberDto }>(`/v1/members/${id}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  invitePreview: (token: string) =>
    request<InvitePreviewDto>(`/v1/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string) =>
    request<{ member: unknown }>(`/v1/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
    }),

  /* Platform: audit ---------------------------------------------------- */
  auditLogs: (params: { action?: string; limit?: number } = {}) =>
    request<{ logs: AuditLogDto[] }>(`/v1/audit${qs(params)}`),

  /* Platform: channels ------------------------------------------------- */
  channels: () => request<{ channels: ChannelConnectionDto[] }>("/v1/channels"),
  upsertChannel: (input: {
    channel: ChannelKindDto;
    provider?: string;
    name?: string;
    status?: "disabled" | "enabled" | "error";
    config?: Record<string, unknown>;
  }) =>
    request<{ channel: ChannelConnectionDto }>("/v1/channels", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  testChannel: (input: { channel: ChannelKindDto; to: string; body: string; subject?: string }) =>
    request<{ message: MessageSendDto }>("/v1/channels/test", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* Platform: integrations --------------------------------------------- */
  integrations: () => request<{ integrations: IntegrationDto[] }>("/v1/integrations"),
  integration: (id: string) =>
    request<{ integration: IntegrationDto; webhookPath: string }>(`/v1/integrations/${id}`),
  createIntegration: (input: {
    kind: IntegrationKindDto;
    name: string;
    slug: string;
    config?: Record<string, unknown>;
  }) =>
    request<{ integration: IssuedIntegrationDto; secret: string; webhookPath: string }>(
      "/v1/integrations",
      { method: "POST", body: JSON.stringify(input) },
    ),
  updateIntegration: (
    id: string,
    input: {
      name?: string;
      status?: "disabled" | "enabled" | "error";
      config?: Record<string, unknown>;
    },
  ) =>
    request<{ integration: IntegrationDto }>(`/v1/integrations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteIntegration: (id: string) =>
    request<{ ok: true }>(`/v1/integrations/${id}`, { method: "DELETE" }),

  /* Platform: revenue -------------------------------------------------- */
  revenueReport: (params: { since?: string } = {}) =>
    request<{ rows: RevenueReportRowDto[] }>(`/v1/revenue/report${qs(params)}`),
  contactLtv: (contactId: string) =>
    request<{ ltv: ContactLtvDto }>(`/v1/revenue/ltv/${contactId}`),
  recordRevenueEvent: (input: {
    contactId: string;
    type: string;
    orderId?: string;
    currency?: string;
    amountCents: number;
    metadata?: Record<string, unknown>;
  }) =>
    request<{ event: RevenueEventDto }>("/v1/revenue/events", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* Platform: send experiments ----------------------------------------- */
  experiments: () => request<{ experiments: SendExperimentDto[] }>("/v1/experiments"),
  experiment: (id: string) =>
    request<{
      experiment: SendExperimentDto;
      results: SendExperimentResultDto[];
    }>(`/v1/experiments/${id}`),
  createExperiment: (input: {
    name: string;
    kind: "subject" | "send_time" | "content";
    metric?: "open" | "click" | "conversion";
    journeyId?: string;
    variants: Omit<SendExperimentVariantDto, "id">[] & { id?: string }[];
  }) =>
    request<{ experiment: SendExperimentDto }>("/v1/experiments", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  startExperiment: (id: string) =>
    request<{ experiment: SendExperimentDto }>(`/v1/experiments/${id}/start`, {
      method: "POST",
    }),
  recordExperimentOutcome: (
    id: string,
    input: {
      variantId: string;
      emailSendId?: string;
      opened?: boolean;
      clicked?: boolean;
      converted?: boolean;
    },
  ) =>
    request<{ result: SendExperimentResultDto }>(`/v1/experiments/${id}/outcome`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  pickExperimentWinner: (id: string, metric: "open" | "click" | "conversion" = "open") =>
    request<{ experiment: SendExperimentDto; winnerVariantId: string | null }>(
      `/v1/experiments/${id}/pick-winner${qs({ metric })}`,
      { method: "POST" },
    ),

  /* Platform: journey as code ------------------------------------------ */
  exportJourney: (id: string, format: "json" | "yaml" = "json") =>
    request<{ export: JourneyExportDto; document: string }>(
      `/v1/journeys/${id}/export${qs({ format })}`,
    ),
  importJourney: (document: string) =>
    request<{ journeyId: string; name: string }>("/v1/journeys/import", {
      method: "POST",
      body: JSON.stringify({ document }),
    }),

  /* Platform: compliance ----------------------------------------------- */
  privacyJobs: () => request<{ jobs: PrivacyJobDto[] }>("/v1/compliance/privacy-jobs"),
  privacyJob: (id: string) => request<{ job: PrivacyJobDto }>(`/v1/compliance/privacy-jobs/${id}`),
  createPrivacyJob: (input: { email: string; kind: "export" | "erasure" }) =>
    request<{ job: PrivacyJobDto }>("/v1/compliance/privacy-jobs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** Returns the raw JSON payload text for a completed export job. */
  privacyJobDownloadPath: (id: string) => `/v1/compliance/privacy-jobs/${id}/download`,
  issueDoubleOptIn: (input: {
    email: string;
    contactId?: string | null;
    formId?: string | null;
    topicIds?: string[];
  }) =>
    request<{ token: string; confirmUrl: string }>("/v1/compliance/double-opt-in", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* Intelligence: lead scoring ----------------------------------------- */
  scoreRules: () => request<{ rules: LeadScoreRuleDto[] }>("/v1/scoring/rules"),
  createScoreRule: (input: LeadScoreRuleInputDto) =>
    request<{ rule: LeadScoreRuleDto }>("/v1/scoring/rules", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateScoreRule: (id: string, input: Partial<LeadScoreRuleInputDto>) =>
    request<{ rule: LeadScoreRuleDto }>(`/v1/scoring/rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteScoreRule: (id: string) =>
    request<{ ok: true }>(`/v1/scoring/rules/${id}`, { method: "DELETE" }),
  scoreDistribution: () =>
    request<{ distribution: { hot: number; warm: number; cold: number; total: number } }>(
      "/v1/scoring/distribution",
    ),
  recomputeScore: (contactId: string) =>
    request<{
      score: number;
      tier: "hot" | "warm" | "cold";
      contributions: Array<{ ruleId: string; ruleName: string; hits: number; points: number }>;
    }>(`/v1/scoring/recompute/${contactId}`, { method: "POST" }),

  /* Intelligence: plays ------------------------------------------------ */
  plays: () => request<{ plays: PlayDto[] }>("/v1/plays"),
  createPlay: (input: PlayInputDto) =>
    request<{ play: PlayDto }>("/v1/plays", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updatePlay: (id: string, input: Partial<PlayInputDto>) =>
    request<{ play: PlayDto }>(`/v1/plays/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deletePlay: (id: string) => request<{ ok: true }>(`/v1/plays/${id}`, { method: "DELETE" }),

  /* Intelligence: website signals -------------------------------------- */
  signalSettings: () => request<{ settings: SignalSettingsDto }>("/v1/signals/settings"),
  updateSignalSettings: (input: { highIntentPaths?: string[]; intentWebhookUrl?: string | null }) =>
    request<{ settings: SignalSettingsDto }>("/v1/signals/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  pageViews: (limit = 50) =>
    request<{ pageViews: PageViewDto[] }>(`/v1/signals/page-views${qs({ limit })}`),

  /* GTM: meetings ------------------------------------------------------ */
  meetingSettings: () => request<{ settings: MeetingSettingsDto }>("/v1/meetings/settings"),
  updateMeetingSettings: (input: {
    bookingUrl?: string | null;
    meetingTitle?: string;
    meetingDescription?: string | null;
    durationMinutes?: number;
    ctaLabel?: string;
    timezone?: string;
    availableWeekdays?: number[];
    dayStartMinute?: number;
    dayEndMinute?: number;
    bufferMinutes?: number;
    leadDays?: number;
    bookingSlug?: string | null;
    reminderHoursBefore?: number[];
    sendBookingConfirmation?: boolean;
    sendReminders?: boolean;
    assignmentMode?: "round_robin" | "fixed" | "none";
    fixedHostEmail?: string | null;
    organizerName?: string | null;
    organizerEmail?: string | null;
    postMeetingJourneyId?: string | null;
    noShowJourneyId?: string | null;
    cancellationJourneyId?: string | null;
    prepBriefHoursBefore?: number;
  }) =>
    request<{ settings: MeetingSettingsDto }>("/v1/meetings/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  meetingCalendarToken: () =>
    request<{ token: string; feedPath: string }>("/v1/meetings/calendar-token", {
      method: "POST",
    }),
  meetingBrief: (id: string) => request<{ brief: MeetingPrepBriefDto }>(`/v1/meetings/${id}/brief`),
  meetingHosts: () => request<{ hosts: MeetingHostDto[] }>("/v1/meetings/hosts"),
  createMeetingHost: (input: {
    name: string;
    email: string;
    userId?: string | null;
    active?: boolean;
    sortOrder?: number;
  }) =>
    request<{ host: MeetingHostDto }>("/v1/meetings/hosts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateMeetingHost: (
    id: string,
    input: {
      name?: string;
      email?: string;
      userId?: string | null;
      active?: boolean;
      sortOrder?: number;
    },
  ) =>
    request<{ host: MeetingHostDto }>(`/v1/meetings/hosts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteMeetingHost: (id: string) =>
    request<{ ok: true }>(`/v1/meetings/hosts/${id}`, { method: "DELETE" }),
  meetingEmailVars: () => request<{ variables: Record<string, string> }>("/v1/meetings/email-vars"),
  meetingTypes: () => request<{ types: MeetingTypeDto[] }>("/v1/meetings/types"),
  createMeetingType: (input: {
    name: string;
    slug: string;
    description?: string | null;
    durationMinutes?: number;
    bookingUrl?: string | null;
    ctaLabel?: string;
    isDefault?: boolean;
    active?: boolean;
    sortOrder?: number;
  }) =>
    request<{ type: MeetingTypeDto }>("/v1/meetings/types", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteMeetingType: (id: string) =>
    request<{ ok: true }>(`/v1/meetings/types/${id}`, { method: "DELETE" }),
  meetingSlots: (
    params: {
      meetingTypeId?: string;
      days?: number;
      contactId?: string;
      timezone?: string;
      smart?: boolean;
    } = {},
  ) =>
    request<{ slots: Array<SlotDto & { score?: number; reasons?: string[] }>; smart?: boolean }>(
      `/v1/meetings/slots${qs({
        meetingTypeId: params.meetingTypeId,
        days: params.days,
        contactId: params.contactId,
        timezone: params.timezone,
        smart: params.smart ? "1" : undefined,
      })}`,
    ),
  bookMeeting: (input: {
    contactId?: string;
    email?: string;
    name?: string;
    meetingTypeId?: string;
    startsAt: string;
    notes?: string;
    source?: string;
    timezone?: string;
    hostEmail?: string;
  }) =>
    request<{
      meeting: MeetingDto;
      contactId: string | null;
      reminderTaskId: string | null;
      leadScore?: number;
      leadTier?: string;
    }>("/v1/meetings", { method: "POST", body: JSON.stringify(input) }),
  meetings: (
    params: {
      status?: string;
      contactId?: string;
      upcoming?: boolean;
      limit?: number;
    } = {},
  ) =>
    request<{ meetings: MeetingDto[] }>(
      `/v1/meetings${qs({ ...params, upcoming: params.upcoming ? "1" : undefined })}`,
    ),
  meeting: (id: string) => request<{ meeting: MeetingDto }>(`/v1/meetings/${id}`),
  updateMeetingStatus: (
    id: string,
    status: "scheduled" | "held" | "cancelled" | "no_show",
    outcome?: string | null,
  ) =>
    request<{ meeting: MeetingDto; intelligence: MeetingOutcomeIntelDto }>(
      `/v1/meetings/${id}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status, outcome }),
      },
    ),
  recordMeetingBooked: (input: {
    contactId?: string;
    email?: string;
    startsAt?: string;
    endsAt?: string;
    notes?: string;
    source?: string;
  }) =>
    request<{ eventId: string | null; leadScore?: number; leadTier?: string }>(
      "/v1/meetings/booked",
      { method: "POST", body: JSON.stringify(input) },
    ),

  /* Public booking page (no session) ----------------------------------- */
  publicBooking: (slug: string) =>
    request<PublicBookingPayloadDto>(`/v1/book/${encodeURIComponent(slug)}`),
  publicBook: (input: {
    slug: string;
    meetingTypeId?: string;
    email: string;
    name?: string;
    startsAt: string;
    notes?: string;
    timezone?: string;
  }) =>
    request<{
      ok: true;
      meeting: { id: string; title: string; startsAt: string; endsAt: string; timezone: string };
    }>("/v1/book", { method: "POST", body: JSON.stringify(input) }),

  /* GTM: tasks --------------------------------------------------------- */
  tasks: (params: { status?: string; contactId?: string; limit?: number } = {}) =>
    request<{ tasks: TaskDto[]; stats: TaskStatsDto }>(`/v1/tasks${qs(params)}`),
  createTask: (input: {
    contactId: string;
    title: string;
    body?: string | null;
    kind?: TaskKindDto;
    priority?: number;
    dueAt?: string | null;
    source?: string;
    sourceId?: string | null;
  }) => request<{ task: TaskDto }>("/v1/tasks", { method: "POST", body: JSON.stringify(input) }),
  completeTask: (id: string, status: "done" | "dismissed" = "done") =>
    request<{ task: TaskDto }>(`/v1/tasks/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),

  /* GTM: companies ----------------------------------------------------- */
  companies: (limit = 100) => request<{ companies: CompanyDto[] }>(`/v1/companies${qs({ limit })}`),
  company: (id: string) =>
    request<{ company: CompanyDto; contacts: CompanyContactDto[] }>(`/v1/companies/${id}`),
  recomputeCompany: (id: string) =>
    request<{ company: CompanyDto }>(`/v1/companies/${id}/recompute`, { method: "POST" }),
  syncContactCompany: (contactId: string, name?: string) =>
    request<{ company: CompanyDto | null }>(`/v1/companies/sync-contact`, {
      method: "POST",
      body: JSON.stringify({ contactId, name }),
    }),
};

export type Api = typeof api;
