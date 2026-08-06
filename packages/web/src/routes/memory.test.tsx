import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "~/lib/hooks";
import { routeTree } from "~/routes/../routeTree.gen";

// Capture props passed to PierreTree so tests can assert on them and call callbacks.
type PierreTreeCaptured = {
  paths: string[];
  onSelect: (path: string, kind: "file" | "directory") => void;
  initialExpandedPaths?: string[];
  onExpansionChange?: (expandedPaths: string[]) => void;
  initialExpansion?: "open" | "closed";
};
let capturedPierreTreeProps: PierreTreeCaptured | null = null;

vi.mock("~/components/PierreTree", () => ({
  PierreTree: (props: PierreTreeCaptured) => {
    capturedPierreTreeProps = props;
    // Render buttons for each path so tests can click leaves by path
    return (
      <div data-testid="pierre-tree-mock">
        {props.paths.map((p) => (
          <button
            type="button"
            key={p}
            data-testid={`pt-path-${p}`}
            onClick={() => props.onSelect(p, p.endsWith("/") ? "directory" : "file")}
          >
            {p}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock("~/lib/hooks", () => ({
  usePending: vi.fn(),
  useRecall: vi.fn(),
  useRecentMemories: vi.fn(),
  useMemoryIndex: vi.fn(),
  useMemoryGraph: vi.fn(),
  useUpdateMemory: vi.fn(),
  usePrincipals: vi.fn(),
  useVerify: vi.fn(),
  useSchema: vi.fn(),
  useEntity: vi.fn(),
  useSession: vi.fn(),
  useGraphs: vi.fn().mockReturnValue({ graphs: [], defaultGraph: "main" }),
  useActiveGraph: vi.fn().mockReturnValue({ activeGraphId: "main", setActiveGraphId: vi.fn() }),
  useGitProposals: vi
    .fn()
    .mockReturnValue({ data: { proposals: [] }, isLoading: false, isError: false, error: null }),
}));

vi.mock("~/lib/api", () => ({
  GRAPH_STORAGE_KEY: "freehold-graph",
  setActiveGraph: vi.fn(),
  apiClient: {
    proposals: vi.fn(),
    recall: vi.fn(),
    memoryIndex: vi.fn(),
    graph: vi.fn(),
    updateEntity: vi.fn(),
    principals: vi.fn(),
    getEntity: vi.fn(),
    schema: vi.fn(),
  },
}));

const sampleEntry = {
  id: "note-1",
  type: "memory/Note@1",
  title: "Standup moved to 2pm",
  approval: "saved",
  author: "claude",
  updatedAt: "2026-08-04T10:00:00.000Z",
  terms: ["workspace/scratch@1"],
};

const personEntry = {
  id: "person-1",
  type: "claude-workspace/Colleague@1",
  title: "Sam Okafor",
  approval: "saved",
  author: "claude",
  updatedAt: "2026-08-03T10:00:00.000Z",
  terms: [],
};

const pendingEntry = {
  id: "pending-1",
  type: "memory/Note@1",
  title: "Proposed note",
  approval: "pending",
  author: "claude",
  updatedAt: "2026-08-04T12:00:00.000Z",
  terms: [],
};

const sampleResult = {
  id: "note-1",
  type: "memory/Note@1",
  content: { attributes: { content: "Standup moved to 2pm" } },
  author: "claude",
  approval: "saved",
  changeset: "deadbeef1234",
  score: 0.9,
};

type Entries = (typeof sampleEntry)[];

function setupHooks(
  overrides: {
    entries?: Entries;
    results?: (typeof sampleResult)[];
  } = {}
) {
  const queryStub = {
    isLoading: false,
    isError: false,
    error: null,
  };
  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: [] },
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.usePending>);
  vi.mocked(hooks.useMemoryIndex).mockReturnValue({
    data: { results: overrides.entries ?? [] },
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.useMemoryIndex>);
  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: overrides.results ?? [] },
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.useRecall>);
  vi.mocked(hooks.useMemoryGraph).mockReturnValue({
    data: { nodes: [], edges: [], truncated: false },
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.useMemoryGraph>);
  vi.mocked(hooks.useUpdateMemory).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useUpdateMemory>);
  vi.mocked(hooks.useRecentMemories).mockReturnValue({
    data: { results: [] },
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.useRecentMemories>);
  vi.mocked(hooks.useSchema).mockReturnValue({
    data: { entityTypes: [], edgeTypes: [], terms: [] },
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.useSchema>);
  vi.mocked(hooks.usePrincipals).mockReturnValue({
    data: {
      principals: [
        { name: "owner", kind: "user" },
        { name: "claude", kind: "agent" },
      ],
    },
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.usePrincipals>);
  vi.mocked(hooks.useEntity).mockReturnValue({
    data: undefined,
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.useEntity>);
  vi.mocked(hooks.useSession).mockReturnValue({
    data: { defaultAgent: "claude", embedder: "hash", port: 8710, owner: "owner" },
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.useSession>);
  vi.mocked(hooks.useVerify).mockReturnValue({
    data: undefined,
    ...queryStub,
  } as unknown as ReturnType<typeof hooks.useVerify>);
}

async function renderMemory(
  overrides: Parameters<typeof setupHooks>[0] = {},
  initialPath = "/memory"
) {
  setupHooks(overrides);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  });
  return router;
}

describe("Memory workspace", () => {
  // happy-dom's localStorage lacks Storage methods in this version; stub it.
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.clearAllMocks();
    capturedPierreTreeProps = null;
    store.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, String(v)),
        removeItem: (k: string) => store.delete(k),
      },
    });
  });

  it("renders search input", async () => {
    await renderMemory();
    expect(screen.getByRole("searchbox", { name: /search memories/i })).toBeInTheDocument();
  });

  it("empty index shows the mcp setup snippet", async () => {
    await renderMemory();
    expect(screen.getByText(/freehold mcp setup claude-code/)).toBeInTheDocument();
  });

  it("tree renders PierreTree with synthetic paths from the ontology", async () => {
    await renderMemory({ entries: [sampleEntry, personEntry] });
    expect(screen.getByTestId("pierre-tree-mock")).toBeInTheDocument();
    if (capturedPierreTreeProps === null) throw new Error("PierreTree was not rendered");
    // Paths include the type folder directories and leaf paths
    const { paths } = capturedPierreTreeProps;
    expect(paths.some((p) => p.startsWith("Notes/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("People/"))).toBe(true);
    expect(paths).toContain("Notes/Standup moved to 2pm");
    expect(paths).toContain("People/Sam Okafor");
    expect(screen.queryByText(/freehold mcp setup claude-code/)).not.toBeInTheDocument();
  });

  it("clicking a leaf path in PierreTree navigates to /memory/$id", async () => {
    const router = await renderMemory({ entries: [sampleEntry] });
    // Find the PierreTree leaf button for the note and click it
    const leafBtn = screen.getByTestId("pt-path-Notes/Standup moved to 2pm");
    await act(async () => {
      fireEvent.click(leafBtn);
    });
    expect(router.state.location.pathname).toBe("/memory/note-1");
  });

  it("clicking a directory path in PierreTree does not navigate", async () => {
    const router = await renderMemory({ entries: [sampleEntry] });
    // Find a directory button (paths ending in /)
    const dirBtn = screen.getByTestId("pt-path-Notes/");
    await act(async () => {
      fireEvent.click(dirBtn);
    });
    // Should stay on /memory
    expect(router.state.location.pathname).toBe("/memory");
  });

  it("seeds initialExpandedPaths from localStorage freehold:memory-tree-open", async () => {
    store.set("freehold:memory-tree-open", JSON.stringify(["Notes/", "Notes/projects/"]));
    await renderMemory({ entries: [sampleEntry] });
    if (capturedPierreTreeProps === null) throw new Error("PierreTree was not rendered");
    expect(capturedPierreTreeProps.initialExpandedPaths).toEqual(["Notes/", "Notes/projects/"]);
  });

  it("onExpansionChange writes expanded paths as JSON array to freehold:memory-tree-open", async () => {
    await renderMemory({ entries: [sampleEntry] });
    if (capturedPierreTreeProps === null) throw new Error("PierreTree was not rendered");
    const { onExpansionChange } = capturedPierreTreeProps;
    await act(async () => {
      if (onExpansionChange) onExpansionChange(["Notes/", "People/"]);
    });
    expect(store.get("freehold:memory-tree-open")).toBe(JSON.stringify(["Notes/", "People/"]));
  });

  it("uses initialExpansion=open when total leaves ≤ 15", async () => {
    await renderMemory({ entries: [sampleEntry] });
    if (capturedPierreTreeProps === null) throw new Error("PierreTree was not rendered");
    expect(capturedPierreTreeProps.initialExpansion).toBe("open");
  });

  it("uses initialExpansion=closed when total leaves > 15", async () => {
    // Build 16 entries
    const many = Array.from({ length: 16 }, (_, i) => ({
      id: `n${i}`,
      type: "memory/Note@1",
      title: `Note ${i}`,
      approval: "saved",
      author: "claude",
      updatedAt: "2026-08-04T10:00:00.000Z",
      terms: [],
    }));
    await renderMemory({ entries: many });
    if (capturedPierreTreeProps === null) throw new Error("PierreTree was not rendered");
    expect(capturedPierreTreeProps.initialExpansion).toBe("closed");
  });

  it("typing a query swaps the tree for search results", async () => {
    await renderMemory({ entries: [sampleEntry], results: [sampleResult] });
    const input = screen.getByRole("searchbox", { name: /search memories/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: "standup" } });
    });
    expect(screen.getByTestId("search-result-note-1")).toBeInTheDocument();
    // PierreTree hidden while searching
    expect(screen.queryByTestId("pierre-tree-mock")).not.toBeInTheDocument();
  });

  it("shows no results message for a query with no matches", async () => {
    await renderMemory({ results: [] });
    const input = screen.getByRole("searchbox", { name: /search memories/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: "nothing" } });
    });
    expect(screen.getByText(/No memories match your search/)).toBeInTheDocument();
  });

  it("author filter composes into the recall query", async () => {
    await renderMemory({ results: [sampleResult] });
    const input = screen.getByRole("searchbox", { name: /search memories/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: "standup" } });
    });
    const authorBtn = screen.getByTestId("author-filter-claude");
    await act(async () => {
      fireEvent.click(authorBtn);
    });
    expect(vi.mocked(hooks.useRecall)).toHaveBeenCalledWith(
      "standup",
      expect.objectContaining({ author: "claude" }),
      true
    );
  });
});
