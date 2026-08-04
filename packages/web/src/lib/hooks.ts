import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

/** Recent memories for the no-query browse view. */
export function useRecentMemories(
  filters: { type?: string; author?: string; status?: string } = {},
  enabled = true
) {
  return useQuery({
    queryKey: ["recent-memories", filters],
    queryFn: () => apiClient.recentMemories(filters),
    enabled,
  });
}

/** Full workspace index — every non-meta node, for the tree. */
export function useMemoryIndex(enabled = true) {
  return useQuery({
    queryKey: ["memory-index"],
    queryFn: () => apiClient.memoryIndex(),
    enabled,
  });
}

/** Graph export for the canvas. */
export function useMemoryGraph(enabled = true) {
  return useQuery({
    queryKey: ["memory-graph"],
    queryFn: () => apiClient.graph(),
    enabled,
  });
}

/** Owner update of a node's attributes; invalidates the entity and listings. */
export function useUpdateMemory(id: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      agent: string;
      type: string;
      attributes: Record<string, unknown>;
      prior?: string;
    }) =>
      // biome-ignore lint/style/noNonNullAssertion: callers only mutate with a loaded entity
      apiClient.updateEntity(id!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity", id] });
      queryClient.invalidateQueries({ queryKey: ["memory-index"] });
      queryClient.invalidateQueries({ queryKey: ["memory-graph"] });
      queryClient.invalidateQueries({ queryKey: ["recent-memories"] });
    },
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

/** Daemon session config (defaultAgent, embedder, port). */
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => apiClient.session(),
  });
}
