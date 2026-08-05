import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { CodeFileView, CodeItemView, CodeNeighborhood, RegionRule, SessionGraphEntry } from "@freehold/client";
import { GRAPH_STORAGE_KEY, apiClient, setActiveGraph } from "./api";

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
    // A 404 is a real answer (the node is gone) — surface it, don't retry
    retry: false,
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

/** Daemon session config (defaultAgent, embedder, port, graphs, defaultGraph). */
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => apiClient.session(),
  });
}

/** All registered graphs from the session response. Falls back to empty list. */
export function useGraphs(): { graphs: SessionGraphEntry[]; defaultGraph: string } {
  const { data } = useSession();
  return {
    graphs: data?.graphs ?? [],
    defaultGraph: data?.defaultGraph ?? "main",
  };
}

/**
 * Returns the id of the currently active graph (from localStorage) and a
 * setter that persists the choice and invalidates all queries.
 *
 * Stale-id recovery: the initializer reads localStorage before the session
 * resolves, so defaultGraph is still "main". A useEffect fires once graphs
 * load; if the persisted id is no longer in the graphs list, it resets to
 * defaultGraph. This also handles the case where the canonical default is not
 * "main" — the effect self-corrects on first render after session resolves.
 */
export function useActiveGraph(): {
  activeGraphId: string;
  setActiveGraphId: (id: string) => void;
} {
  const { graphs, defaultGraph } = useGraphs();
  const queryClient = useQueryClient();

  const [activeGraphId, setLocalActiveGraphId] = useState<string>(() => {
    try {
      // localStorage may hold an id that no longer exists in this session.
      // The effect below self-corrects once graphs load.
      return localStorage.getItem(GRAPH_STORAGE_KEY) ?? defaultGraph;
    } catch {
      return defaultGraph;
    }
  });

  // When the graphs list becomes available, verify that the persisted id is
  // still valid. If it has been removed (or was never registered), fall back
  // to the server-supplied default without requiring a manual page reload.
  useEffect(() => {
    if (graphs.length === 0) return; // session not yet resolved
    const known = graphs.some((g) => g.id === activeGraphId);
    if (!known) {
      setLocalActiveGraphId(defaultGraph);
      setActiveGraph(defaultGraph);
      queryClient.invalidateQueries();
    }
  }, [activeGraphId, graphs, defaultGraph, queryClient]);

  function setActiveGraphId(id: string) {
    setLocalActiveGraphId(id);
    setActiveGraph(id);
    queryClient.invalidateQueries();
  }

  return { activeGraphId, setActiveGraphId };
}

/** File tree for the active repo graph. */
export function useCodeTree(enabled = true) {
  return useQuery({
    queryKey: ["code-tree"],
    queryFn: () => apiClient.codeTree() as Promise<{ tree: unknown[] }>,
    enabled,
  });
}

/** Single file view with declared items. 404 when not indexed. */
export function useCodeFile(path: string | undefined) {
  return useQuery({
    queryKey: ["code-file", path],
    queryFn: () => apiClient.codeFile(path!),
    enabled: !!path,
    retry: false,
  });
}

/** Single code item (function/class) with callers and callees. */
export function useCodeItem(nodeId: string | undefined) {
  return useQuery({
    queryKey: ["code-item", nodeId],
    queryFn: () => apiClient.codeItem(nodeId!),
    enabled: !!nodeId,
    retry: false,
  });
}

/** Policy region membership rules. */
export function useCodeRegions(enabled = true) {
  return useQuery({
    queryKey: ["code-regions"],
    queryFn: () => apiClient.codeRegions(),
    enabled,
  });
}

/** Neighborhood graph for a given file path — nodes and edges one hop out. */
export function useCodeNeighborhood(path: string | undefined) {
  return useQuery({
    queryKey: ["code-neighborhood", path],
    queryFn: () => apiClient.codeNeighborhood(path!),
    enabled: !!path,
    retry: false,
  });
}

/** Manual classification of a node by the owner. */
export function useClassify() {
  const { data: sessionData } = useSession();
  const agent = sessionData?.owner ?? "owner";
  return useMutation({
    mutationFn: ({ nodeId, term }: { nodeId: string; term: string }) =>
      apiClient.classify({ agent, nodeId, term, basis: "manual" }),
  });
}

/** Full graph info list from /api/v1/graphs — includes originRemote and path. */
export function useListGraphs() {
  return useQuery({
    queryKey: ["list-graphs"],
    queryFn: () => apiClient.listGraphs(),
  });
}

/** Returns a GitHub blob URL for the given file path if the active graph has a GitHub remote. */
export function useGitHubBlobUrl(filePath: string | undefined): string | null {
  const { activeGraphId } = useActiveGraph();
  const { data } = useListGraphs();
  if (!filePath || !data) return null;
  const entry = data.graphs.find((g) => g.id === activeGraphId);
  if (!entry?.originRemote) return null;
  const remote = entry.originRemote;
  // Parse https://github.com/org/repo.git or git@github.com:org/repo.git
  const httpsMatch = remote.match(/https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  const sshMatch = remote.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  const repoPath = (httpsMatch?.[1] ?? sshMatch?.[1]) ?? null;
  if (!repoPath) return null;
  return `https://github.com/${repoPath}/blob/HEAD/${filePath}`;
}

// Re-export types for convenience in route components
export type { CodeFileView, CodeItemView, CodeNeighborhood, RegionRule };
