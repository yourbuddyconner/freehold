import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./api";

/** Pending proposals (the Inbox). */
export function usePending() {
  return useQuery({
    queryKey: ["proposals"],
    queryFn: () => apiClient.proposals(),
  });
}

/** Recall search with optional filters. */
export function useRecall(
  query: string,
  filters: { type?: string; author?: string; status?: string } = {},
  enabled = true
) {
  return useQuery({
    queryKey: ["recall", query, filters],
    queryFn: () => apiClient.recall(query, filters),
    enabled: enabled && query.length > 0,
  });
}

/** Single entity detail. */
export function useEntity(id: string | undefined) {
  return useQuery({
    queryKey: ["entity", id],
    // biome-ignore lint/style/noNonNullAssertion: enabled guard above ensures id is defined
    queryFn: () => apiClient.getEntity(id!),
    enabled: !!id,
  });
}

/** Verify report. */
export function useVerify(enabled = false) {
  return useQuery({
    queryKey: ["verify"],
    queryFn: () => apiClient.verify(),
    enabled,
  });
}

/** Schema description. */
export function useSchema() {
  return useQuery({
    queryKey: ["schema"],
    queryFn: () => apiClient.schema(),
  });
}

/** Policy rules (raw JSON from server). */
export function usePolicy() {
  return useQuery({
    queryKey: ["policy"],
    queryFn: () => apiClient.getPolicy() as Promise<unknown>,
  });
}

/** Changeset log (raw JSON from server). */
export function useLog() {
  return useQuery({
    queryKey: ["log"],
    queryFn: () => apiClient.log() as Promise<unknown>,
  });
}

/** Principals list (raw JSON from server). */
export function usePrincipals() {
  return useQuery({
    queryKey: ["principals"],
    queryFn: () => apiClient.principals() as Promise<unknown>,
  });
}
