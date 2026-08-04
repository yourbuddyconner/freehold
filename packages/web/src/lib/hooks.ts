import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./api";

/** Pending proposals (the Inbox). */
export function usePending() {
  return useQuery({
    queryKey: ["proposals"],
    queryFn: () => apiClient.proposals(),
  });
}

/** Recall search. */
export function useRecall(query: string, enabled = true) {
  return useQuery({
    queryKey: ["recall", query],
    queryFn: () => apiClient.recall(query),
    enabled: enabled && query.length > 0,
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
