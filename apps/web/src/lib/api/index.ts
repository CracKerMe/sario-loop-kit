/**
 * API surface for the dashboard.
 *
 * - `http` — fetch wrapper, ApiError, query-string helper
 * - `types` — wire DTOs + shared domain types re-exported from packages
 * - `client` — imperative `api.*` methods (stable for existing call sites)
 * - `hooks` — TanStack Query wrappers for list/detail reads
 */
export { ApiError, baseUrl, qs, request } from "./http";
export { AppQueryProvider } from "./provider";
export { api, type Api } from "./client";
export {
  queryKeys,
  useApiMutation,
  useApiQuery,
  useAudiences,
  useCampaigns,
  useContacts,
  useInvalidate,
  useJourneys,
  useTemplates,
} from "./hooks";
export type * from "./types";
export { baseUrl as getApiBaseUrl } from "./http";
