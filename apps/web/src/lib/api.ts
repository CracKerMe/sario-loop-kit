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
  updatedAt: string;
};

export type JourneyRunDto = {
  id: string;
  instanceId: string;
  contactId: string;
  status: string;
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

export type DlqEntryDto = {
  id?: string;
  [key: string]: unknown;
};

export const api = {
  stats: () => request<{ stats: Record<string, unknown> }>("/v1/ops/stats"),
  dlq: () => request<{ entries: unknown[] }>("/v1/ops/dlq"),
  journeys: () => request<{ journeys: JourneyDto[] }>("/v1/journeys"),
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
  journeyRuns: (id: string) => request<{ runs: JourneyRunDto[] }>(`/v1/journeys/${id}/runs`),
  journeyFunnel: (id: string) =>
    request<{ funnel: FunnelEntryDto[]; runCounts: Record<string, number> }>(
      `/v1/journeys/${id}/funnel`,
    ),
  runDetail: (instanceId: string) =>
    request<{ run: JourneyRunDto; instance: unknown }>(`/v1/runs/${instanceId}`),
  cancelRun: (instanceId: string) =>
    request<{ ok: true }>(`/v1/runs/${instanceId}/cancel`, { method: "POST" }),
  contacts: () => request<{ contacts: ContactDto[] }>("/v1/contacts"),
  contact: (id: string) =>
    request<{ contact: ContactDto; events: ContactEventDto[] }>(`/v1/contacts/${id}`),
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
