import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { api } from "./client";

type QueryOpts<T> = Omit<UseQueryOptions<T, Error, T, QueryKey>, "queryKey" | "queryFn">;

export function useApiQuery<T>(key: QueryKey, fn: () => Promise<T>, opts?: QueryOpts<T>) {
  return useQuery<T, Error, T, QueryKey>({
    queryKey: key,
    queryFn: fn,
    ...opts,
  });
}

type MutationOpts<TData, TVariables> = Omit<
  UseMutationOptions<TData, Error, TVariables>,
  "mutationFn"
>;

export function useApiMutation<TData, TVariables>(
  fn: (variables: TVariables) => Promise<TData>,
  opts?: MutationOpts<TData, TVariables>,
) {
  return useMutation<TData, Error, TVariables>({ mutationFn: fn, ...opts });
}

/** Shared query keys — keep cache identity stable across pages. */
export const queryKeys = {
  journeys: {
    all: ["journeys"] as const,
    detail: (id: string) => ["journeys", id] as const,
    runs: (id: string) => ["journeys", id, "runs"] as const,
    funnel: (id: string) => ["journeys", id, "funnel"] as const,
    canary: (id: string) => ["journeys", id, "canary"] as const,
    optimizations: (id: string) => ["journeys", id, "optimizations"] as const,
  },
  contacts: {
    all: ["contacts"] as const,
    detail: (id: string) => ["contacts", id] as const,
    activity: (id: string) => ["contacts", id, "activity"] as const,
  },
  templates: {
    all: ["templates"] as const,
    detail: (id: string) => ["templates", id] as const,
  },
  audiences: {
    all: ["audiences"] as const,
    detail: (id: string) => ["audiences", id] as const,
  },
  campaigns: {
    all: ["campaigns"] as const,
    detail: (id: string) => ["campaigns", id] as const,
  },
  apiKeys: {
    all: ["api-keys"] as const,
    meta: ["api-keys", "meta"] as const,
  },
  suppressions: {
    all: ["suppressions"] as const,
  },
  platform: {
    forms: ["platform", "forms"] as const,
    domains: ["platform", "domains"] as const,
    billing: ["platform", "billing"] as const,
    topics: ["platform", "topics"] as const,
    members: ["platform", "members"] as const,
    audit: (params: Record<string, unknown>) => ["platform", "audit", params] as const,
    channels: ["platform", "channels"] as const,
    integrations: ["platform", "integrations"] as const,
    revenue: (params: Record<string, unknown>) => ["platform", "revenue", params] as const,
    contactLtv: (contactId: string) => ["platform", "revenue", "ltv", contactId] as const,
    experiments: ["platform", "experiments"] as const,
    experiment: (id: string) => ["platform", "experiments", id] as const,
    privacyJobs: ["platform", "privacy-jobs"] as const,
    contactTopics: (contactId: string) => ["platform", "contact-topics", contactId] as const,
  },
  ops: {
    stats: ["ops", "stats"] as const,
    dlq: ["ops", "dlq"] as const,
    instances: (params: Record<string, unknown>) => ["ops", "instances", params] as const,
  },
};

/** Convenience wrappers for the hottest list reads. */
export function useJourneys(opts?: QueryOpts<{ journeys: import("./types").JourneyDto[] }>) {
  return useApiQuery(queryKeys.journeys.all, () => api.journeys(), opts);
}

export function useContacts(
  params: { query?: string; status?: "all" | "subscribed" | "unsubscribed" } = {},
  opts?: QueryOpts<{ contacts: import("./types").ContactDto[]; total: number }>,
) {
  return useApiQuery([...queryKeys.contacts.all, params], () => api.contacts(params), opts);
}

export function useTemplates(
  opts?: QueryOpts<{ templates: import("./types").EmailTemplateDto[] }>,
) {
  return useApiQuery(queryKeys.templates.all, () => api.templates(), opts);
}

export function useAudiences(
  opts?: QueryOpts<{
    audiences: import("./types").AudienceWithCountsDto[];
    total: number;
  }>,
) {
  return useApiQuery(queryKeys.audiences.all, () => api.audiences(), opts);
}

export function useCampaigns(
  opts?: QueryOpts<{ campaigns: import("./types").CampaignDto[]; total: number }>,
) {
  return useApiQuery(queryKeys.campaigns.all, () => api.campaigns(), opts);
}

/** Invalidate after mutations that change a list. */
export function useInvalidate(keys: QueryKey[]) {
  const qc = useQueryClient();
  return () => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
}
