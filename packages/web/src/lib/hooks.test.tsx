/**
 * Tests for useActiveGraph — focusing on stale localStorage id recovery.
 *
 * When the persisted graph id is absent from the session's graphs list
 * (e.g. graph was deleted, or localStorage holds an id from a prior session),
 * the hook must reset to the server-supplied defaultGraph.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock api.ts so localStorage calls work in happy-dom
vi.mock("~/lib/api", () => ({
  GRAPH_STORAGE_KEY: "freehold-graph",
  setActiveGraph: vi.fn(),
  apiClient: { session: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

import * as api from "./api";
import { keyFor, useActiveGraph, useActiveGraphPrincipal } from "./hooks";

type GraphKind = "memory" | "repo";

// happy-dom's localStorage lacks clear() in this version; stub it with a Map.
const localStore = new Map<string, string>();

function makeWrapper(
  graphs: { id: string; name: string; kind: GraphKind }[],
  defaultGraph = "main"
) {
  // Pre-populate session data in the cache so useSession returns it synchronously.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["session"], {
    defaultAgent: null,
    embedder: "hash",
    port: 8710,
    owner: "test",
    graphs,
    defaultGraph,
  });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { wrapper: Wrapper, queryClient: qc };
}

describe("useActiveGraph — stale id recovery", () => {
  beforeEach(() => {
    localStore.clear();
    vi.clearAllMocks();

    // Install localStorage stub; happy-dom may lack clear() and removeItem().
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => localStore.get(k) ?? null,
        setItem: (k: string, v: string) => localStore.set(k, String(v)),
        removeItem: (k: string) => localStore.delete(k),
        clear: () => localStore.clear(),
      },
    });
  });

  it("returns defaultGraph when localStorage is empty", () => {
    const { wrapper } = makeWrapper([{ id: "main", name: "Main", kind: "memory" }]);
    const { result } = renderHook(() => useActiveGraph(), { wrapper });
    expect(result.current.activeGraphId).toBe("main");
  });

  it("returns stored id when it exists in the graphs list", () => {
    localStorage.setItem("freehold-graph", "g-work");
    const graphs = [
      { id: "main", name: "Main", kind: "memory" as GraphKind },
      { id: "g-work", name: "Work", kind: "memory" as GraphKind },
    ];
    const { wrapper } = makeWrapper(graphs);
    const { result } = renderHook(() => useActiveGraph(), { wrapper });
    expect(result.current.activeGraphId).toBe("g-work");
  });

  it("resets to defaultGraph when stored id is absent from graphs list", async () => {
    localStorage.setItem("freehold-graph", "stale-id");
    const graphs = [{ id: "main", name: "Main", kind: "memory" as GraphKind }];
    const { wrapper } = makeWrapper(graphs, "main");

    const { result } = renderHook(() => useActiveGraph(), { wrapper });

    // After mount the effect fires: stale-id not in [main], reset to "main"
    await act(async () => {});

    expect(result.current.activeGraphId).toBe("main");
    expect(vi.mocked(api.setActiveGraph)).toHaveBeenCalledWith("main");
  });

  it("resets to non-'main' defaultGraph when stored id is absent", async () => {
    localStorage.setItem("freehold-graph", "old-graph");
    const graphs = [{ id: "canonical", name: "Canonical", kind: "memory" as GraphKind }];
    const { wrapper } = makeWrapper(graphs, "canonical");

    const { result } = renderHook(() => useActiveGraph(), { wrapper });
    await act(async () => {});

    expect(result.current.activeGraphId).toBe("canonical");
    expect(vi.mocked(api.setActiveGraph)).toHaveBeenCalledWith("canonical");
  });

  it("does not reset when graphs list is empty (session not yet resolved)", async () => {
    localStorage.setItem("freehold-graph", "g-pending");
    const { wrapper } = makeWrapper([]); // empty = session not yet resolved

    const { result } = renderHook(() => useActiveGraph(), { wrapper });
    await act(async () => {});

    // Still holds the persisted value — recovery must not fire on empty list
    expect(result.current.activeGraphId).toBe("g-pending");
    expect(vi.mocked(api.setActiveGraph)).not.toHaveBeenCalled();
  });
});

describe("useActiveGraphPrincipal", () => {
  function makePrincipalWrapper(
    graphId: string,
    listGraphsData: {
      graphs: {
        id: string;
        name: string;
        path: string;
        kind: "memory" | "repo";
        autoPushNotes: boolean;
        embedder: "hash" | "semantic";
        allodGraphId: string;
        originRemote: string | null;
        signingPrincipal: string;
      }[];
    }
  ) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Seed session so useActiveGraph resolves the activeGraphId from localStorage
    qc.setQueryData(["session"], {
      defaultAgent: null,
      embedder: "hash",
      port: 8710,
      owner: "test",
      graphs: listGraphsData.graphs.map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
      defaultGraph: listGraphsData.graphs[0]?.id ?? "main",
    });
    // Seed list-graphs so useListGraphs returns signingPrincipal data
    qc.setQueryData(["list-graphs"], listGraphsData);
    // Set active graph in localStorage
    localStore.set("freehold-graph", graphId);

    function Wrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    }
    return { wrapper: Wrapper };
  }

  it("returns signingPrincipal of the active graph", () => {
    const { wrapper } = makePrincipalWrapper("myrepo", {
      graphs: [
        {
          id: "myrepo",
          name: "My Repo",
          path: "/p",
          kind: "repo",
          autoPushNotes: false,
          embedder: "hash",
          allodGraphId: "a",
          originRemote: null,
          signingPrincipal: "conner",
        },
      ],
    });

    const { result } = renderHook(() => useActiveGraphPrincipal(), { wrapper });
    expect(result.current).toBe("conner");
  });

  it("falls back to 'owner' when graph not found", () => {
    const { wrapper } = makePrincipalWrapper("missing", {
      graphs: [],
    });

    const { result } = renderHook(() => useActiveGraphPrincipal(), { wrapper });
    expect(result.current).toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// keyFor — graph-scoped query key factory
// ---------------------------------------------------------------------------

describe("keyFor — graph-scoped query key factory", () => {
  it("includes the graph id as the second element", () => {
    const key = keyFor("repo-1", "git-proposals");
    expect(key[0]).toBe("graph");
    expect(key[1]).toBe("repo-1");
    expect(key[2]).toBe("git-proposals");
  });

  it("different graph ids produce different keys", () => {
    const key1 = keyFor("graph-a", "proposals");
    const key2 = keyFor("graph-b", "proposals");
    expect(key1).not.toEqual(key2);
    expect(key1[1]).toBe("graph-a");
    expect(key2[1]).toBe("graph-b");
  });

  it("same graph id and same parts produce identical keys", () => {
    const key1 = keyFor("main", "git-proposal", "abc1234");
    const key2 = keyFor("main", "git-proposal", "abc1234");
    expect(key1).toEqual(key2);
  });

  it("switching active graph changes the rendered key", async () => {
    const graphs = [
      { id: "graph-a", name: "A", kind: "memory" as GraphKind },
      { id: "graph-b", name: "B", kind: "memory" as GraphKind },
    ];
    // Start with graph-a
    localStore.set("freehold-graph", "graph-a");
    const { wrapper, queryClient } = makeWrapper(graphs, "graph-a");

    const { result } = renderHook(() => useActiveGraph(), { wrapper });
    expect(result.current.activeGraphId).toBe("graph-a");

    // The key for graph-a proposals
    const keyA = keyFor(result.current.activeGraphId, "proposals");
    expect(keyA).toEqual(["graph", "graph-a", "proposals"]);

    // Switch to graph-b
    await act(async () => {
      result.current.setActiveGraphId("graph-b");
    });

    expect(result.current.activeGraphId).toBe("graph-b");

    // The key for graph-b proposals is different
    const keyB = keyFor(result.current.activeGraphId, "proposals");
    expect(keyB).toEqual(["graph", "graph-b", "proposals"]);
    expect(keyA).not.toEqual(keyB);

    // Switching also invalidated all queries
    expect(vi.mocked(api.setActiveGraph)).toHaveBeenCalledWith("graph-b");
    queryClient.clear();
  });
});
