import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "~/lib/hooks";
import { routeTree } from "~/routes/../routeTree.gen";

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
  useGitProposals: vi.fn().mockReturnValue({ data: { proposals: [] }, isLoading: false, isError: false, error: null }),
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
}

describe("Memory workspace", () => {
  // happy-dom's localStorage lacks Storage methods in this version; stub it.
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("tree renders folders from the ontology with items inside", async () => {
    await renderMemory({ entries: [sampleEntry, personEntry] });
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("People")).toBeInTheDocument();
    expect(screen.getByText("Standup moved to 2pm")).toBeInTheDocument();
    expect(screen.getByText("Sam Okafor")).toBeInTheDocument();
    expect(screen.queryByText(/freehold mcp setup claude-code/)).not.toBeInTheDocument();
  });

  it("pending items show a pending marker in the tree", async () => {
    await renderMemory({ entries: [pendingEntry] });
    const row = screen.getByTestId("tree-item-pending-1");
    expect(row).toHaveTextContent("Proposed note");
    expect(row.querySelector('[title="Pending"]')).not.toBeNull();
  });

  it("typing a query swaps the tree for search results", async () => {
    await renderMemory({ entries: [sampleEntry], results: [sampleResult] });
    const input = screen.getByRole("searchbox", { name: /search memories/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: "standup" } });
    });
    expect(screen.getByTestId("search-result-note-1")).toBeInTheDocument();
    // Tree folders hidden while searching
    expect(screen.queryByText("Notes")).not.toBeInTheDocument();
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

  it("collapsing a folder hides its items", async () => {
    await renderMemory({ entries: [sampleEntry] });
    const folderBtn = screen.getByRole("button", { name: /Notes/ });
    await act(async () => {
      fireEvent.click(folderBtn);
    });
    expect(screen.queryByText("Standup moved to 2pm")).not.toBeInTheDocument();
  });
});
