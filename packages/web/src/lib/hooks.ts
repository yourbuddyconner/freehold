import type {
  CodeFileView,
  CodeItemView,
  CodeNeighborhood,
  CodeSource,
  DecideResult,
  DiffResponse,
  GitProposal,
  RegionRule,
  SessionGraphEntry,
} from "@freehold/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, GRAPH_STORAGE_KEY, apiClient, setActiveGraph } from "./api";

/**
 * Build a query key for graph-scoped queries.
 * Including the activeGraphId ensures the cache is keyed separately per graph,
 * so switching graphs in the UI does not serve stale data from the previous graph.
 */
export function keyFor(graphId: string, ...parts: unknown[]): [string, string, ...unknown[]] {
  return ["graph", graphId, ...parts];
}

/** Pending proposals (the Inbox). */
export function usePending() {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "proposals"),
    queryFn: () => apiClient.proposals(),
  });
}

/** Recall search with optional filters. */
export function useRecall(
  query: string,
  filters: { type?: string; author?: string; status?: string } = {},
  enabled = true
) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "recall", query, filters),
    queryFn: () => apiClient.recall(query, filters),
    enabled: enabled && query.length > 0,
  });
}

/** Recent memories for the no-query browse view. */
export function useRecentMemories(
  filters: { type?: string; author?: string; status?: string } = {},
  enabled = true
) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "recent-memories", filters),
    queryFn: () => apiClient.recentMemories(filters),
    enabled,
  });
}

/** Full workspace index — every non-meta node, for the tree. */
export function useMemoryIndex(enabled = true) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "memory-index"),
    queryFn: () => apiClient.memoryIndex(),
    enabled,
  });
}

/** Graph export for the canvas. */
export function useMemoryGraph(enabled = true) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "memory-graph"),
    queryFn: () => apiClient.graph(),
    enabled,
  });
}

/** Owner update of a node's attributes; invalidates the entity and listings. */
export function useUpdateMemory(id: string | undefined) {
  const queryClient = useQueryClient();
  const { activeGraphId } = useActiveGraph();
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
      queryClient.invalidateQueries({ queryKey: keyFor(activeGraphId, "entity", id) });
      queryClient.invalidateQueries({ queryKey: keyFor(activeGraphId, "memory-index") });
      queryClient.invalidateQueries({ queryKey: keyFor(activeGraphId, "memory-graph") });
      queryClient.invalidateQueries({ queryKey: keyFor(activeGraphId, "recent-memories") });
    },
  });
}

/** Single entity detail. */
export function useEntity(id: string | undefined) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "entity", id),
    // biome-ignore lint/style/noNonNullAssertion: enabled guard above ensures id is defined
    queryFn: () => apiClient.getEntity(id!),
    enabled: !!id,
    // A 404 is a real answer (the node is gone) — surface it, don't retry
    retry: false,
  });
}

/** Verify report. */
export function useVerify(enabled = false) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "verify"),
    queryFn: () => apiClient.verify(),
    enabled,
  });
}

/** Schema description. */
export function useSchema() {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "schema"),
    queryFn: () => apiClient.schema(),
  });
}

/** Policy rules (raw JSON from server). */
export function usePolicy() {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "policy"),
    queryFn: () => apiClient.getPolicy() as Promise<unknown>,
  });
}

/** Changeset log (raw JSON from server). */
export function useLog() {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "log"),
    queryFn: () => apiClient.log() as Promise<unknown>,
  });
}

/** Principals list (raw JSON from server). */
export function usePrincipals() {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "principals"),
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
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "code-tree"),
    queryFn: () => apiClient.codeTree() as Promise<{ tree: unknown[] }>,
    enabled,
  });
}

/** Single file view with declared items. 404 when not indexed. */
export function useCodeFile(path: string | undefined) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "code-file", path),
    queryFn: () => apiClient.codeFile(path ?? ""),
    enabled: !!path,
    retry: false,
  });
}

/** Single code item (function/class) with callers and callees. */
export function useCodeItem(nodeId: string | undefined) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "code-item", nodeId),
    queryFn: () => apiClient.codeItem(nodeId ?? ""),
    enabled: !!nodeId,
    retry: false,
  });
}

/** Policy region membership rules. */
export function useCodeRegions(enabled = true) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "code-regions"),
    queryFn: () => apiClient.codeRegions(),
    enabled,
  });
}

/** Neighborhood graph for a given file path — nodes and edges one hop out. */
export function useCodeNeighborhood(path: string | undefined) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "code-neighborhood", path),
    queryFn: () => apiClient.codeNeighborhood(path ?? ""),
    enabled: !!path,
    retry: false,
  });
}

/** Working-tree source content for a file path. null → file not on disk (404). */
export function useCodeSource(path: string | undefined) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "code-source", path),
    queryFn: () => apiClient.codeSource(path ?? ""),
    enabled: !!path,
    retry: false,
  });
}

/** Git proposals for the active repo graph. */
export function useGitProposals(enabled = true) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "git-proposals"),
    queryFn: () => apiClient.listGitProposals(),
    enabled,
    staleTime: 30_000,
  });
}

/** Single git proposal by sha. */
export function useGitProposal(sha: string | undefined) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "git-proposal", sha),
    queryFn: () => apiClient.getGitProposal(sha ?? ""),
    enabled: !!sha,
    retry: false,
    staleTime: 30_000,
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
  const repoPath = httpsMatch?.[1] ?? sshMatch?.[1] ?? null;
  if (!repoPath) return null;
  return `https://github.com/${repoPath}/blob/HEAD/${filePath}`;
}

/**
 * Returns the signing principal for the currently-active graph.
 * Falls back to "owner" if the active graph has no signingPrincipal or is not found.
 */
export function useActiveGraphPrincipal(): string {
  const { activeGraphId } = useActiveGraph();
  const { data } = useListGraphs();
  const entry = data?.graphs.find((g) => g.id === activeGraphId);
  return entry?.signingPrincipal ?? "owner";
}

/**
 * Encapsulates all decide-related state and mutation for a git proposal.
 * Extracted from GitProposalCard to allow reuse in the review page.
 *
 * Optimistic update: on mutate, the cached proposal's `decided` field is
 * immediately set in both the list and single-proposal caches so the button
 * never flips back to an undecided state while the query refetch is in flight.
 * The update is rolled back on error.  Invalidation uses refetchType:"none" so
 * the staleTime carries the UI through the slow server-side recompute without
 * triggering an immediate hanging refetch.
 */
export function useDecideProposal(sha: string, by: string) {
  const qc = useQueryClient();
  const { activeGraphId } = useActiveGraph();
  const [decideOutcome, setDecideOutcome] = useState<DecideResult | null>(null);
  const [keyMissingReason, setKeyMissingReason] = useState<string | null>(null);
  const [savedLocally, setSavedLocally] = useState(false);
  const [pushSkippedNotice, setPushSkippedNotice] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const listKey = keyFor(activeGraphId, "git-proposals");
  const singleKey = keyFor(activeGraphId, "git-proposal", sha);

  const decideMut = useMutation({
    mutationFn: (verdict: "approve" | "reject") =>
      apiClient.decideGitProposal(sha, { verdict, by }),
    onMutate: async (verdict) => {
      // Cancel any in-flight refetches that could overwrite the optimistic update.
      await qc.cancelQueries({ queryKey: listKey });
      await qc.cancelQueries({ queryKey: singleKey });

      const optimisticDecided = verdict === "approve" ? "approved" : "rejected";

      // Snapshot previous values for rollback.
      const prevList = qc.getQueryData<{ proposals: GitProposal[] }>(listKey);
      const prevSingle = qc.getQueryData<GitProposal>(singleKey);

      // Apply optimistic decided state to the list cache.
      if (prevList) {
        qc.setQueryData<{ proposals: GitProposal[] }>(listKey, {
          ...prevList,
          proposals: prevList.proposals.map((p) =>
            p.sha === sha ? { ...p, decided: optimisticDecided } : p
          ),
        });
      }

      // Apply optimistic decided state to the single-proposal cache.
      if (prevSingle) {
        qc.setQueryData<GitProposal>(singleKey, { ...prevSingle, decided: optimisticDecided });
      }

      return { prevList, prevSingle };
    },
    onSuccess: (result) => {
      setDecideOutcome(result);
      if ("pushed" in result && !result.pushed) {
        if ("pushError" in result && result.pushError) {
          setSavedLocally(true);
        } else if ("pushSkipped" in result && (result as Record<string, unknown>).pushSkipped) {
          setPushSkippedNotice(true);
        }
      }
      // Mark stale without immediately re-fetching so staleTime carries the UI
      // through the ~60s server-side background recompute after cache eviction.
      qc.invalidateQueries({ queryKey: listKey, refetchType: "none" });
      qc.invalidateQueries({ queryKey: singleKey, refetchType: "none" });
    },
    onError: (err, _verdict, ctx) => {
      // Roll back the optimistic update.
      if (ctx?.prevList !== undefined) {
        qc.setQueryData(listKey, ctx.prevList);
      }
      if (ctx?.prevSingle !== undefined) {
        qc.setQueryData(singleKey, ctx.prevSingle);
      }
      if (err instanceof ApiError && err.code === "key-missing") {
        setKeyMissingReason(err.message);
      }
    },
  });

  async function handleRetry() {
    setRetrying(true);
    try {
      const result = await apiClient.pushGitNotes(sha);
      if (result.pushed) {
        setSavedLocally(false);
        setDecideOutcome(null);
      }
    } finally {
      setRetrying(false);
    }
  }

  return {
    decideMut,
    decideOutcome,
    keyMissingReason,
    savedLocally,
    pushSkippedNotice,
    retrying,
    handleRetry,
  };
}

/** Per-file unified diff for a git proposal. */
export function useGitProposalDiff(sha: string | undefined, enabled = true) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "git-proposal-diff", sha),
    queryFn: () => apiClient.gitProposalDiff(sha ?? ""),
    enabled: enabled && !!sha,
    retry: false,
    staleTime: 30_000,
  });
}

/** Reviews posted for a given commit sha. */
export function useReviewsForSha(sha: string | undefined) {
  const { activeGraphId } = useActiveGraph();
  return useQuery({
    queryKey: keyFor(activeGraphId, "git-reviews", sha),
    queryFn: () => apiClient.listGitReviews(sha ?? ""),
    enabled: !!sha,
    retry: false,
    staleTime: 30_000,
  });
}

// Re-export types for convenience in route components
export type { CodeFileView, CodeItemView, CodeNeighborhood, RegionRule, CodeSource };
export type { DiffResponse };
export type {
  GitProposal,
  DecideResult,
  PostReviewBody,
  PostReviewResult,
  ReviewEntry,
} from "@freehold/client";

/** Mutation to propose a policy change via POST /policy. */
export function useProposePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policyYaml: string) =>
      apiClient.proposePolicy({ policy_yaml: policyYaml }) as Promise<{
        status?: string;
        hash?: string;
      }>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["policy"] });
      qc.invalidateQueries({ queryKey: ["proposals"] });
    },
  });
}
