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
  useCodeTree: vi.fn(),
  useCodeFile: vi.fn(),
  useCodeItem: vi.fn(),
  useCodeRegions: vi.fn(),
  useClassify: vi.fn(),
  useListGraphs: vi.fn(),
  useGitHubBlobUrl: vi.fn().mockReturnValue(null),
  useCodeNeighborhood: vi.fn(),
  useGitProposals: vi
    .fn()
    .mockReturnValue({ data: { proposals: [] }, isLoading: false, isError: false, error: null }),
}));

vi.mock("~/lib/api", () => ({
  GRAPH_STORAGE_KEY: "freehold-graph",
  setActiveGraph: vi.fn(),
  apiClient: {
    proposals: vi.fn(),
    session: vi.fn(),
    codeTree: vi.fn(),
    codeFile: vi.fn(),
    codeItem: vi.fn(),
    codeRegions: vi.fn(),
    classify: vi.fn(),
    listGraphs: vi.fn(),
    codeNeighborhood: vi.fn(),
  },
}));

const emptyQuery = { isLoading: false, isError: false, error: null };

const sampleTree = [
  {
    name: "src",
    path: "src",
    kind: "dir",
    children: [
      {
        name: "main.ts",
        path: "src/main.ts",
        kind: "file",
        language: "typescript",
        terms: ["workspace/core"],
      },
      { name: "utils.ts", path: "src/utils.ts", kind: "file", language: "typescript", terms: [] },
    ],
  },
];

const sampleRegions = [
  {
    rule: "policy/auth-review",
    region: "auth",
    reviewers: ["alice", "bob"],
    paths: ["src/auth/login.ts", "src/auth/middleware.ts"],
  },
  {
    rule: "policy/api-review",
    reviewers: ["charlie"],
    paths: ["src/api/routes.ts"],
  },
];

const sampleFileView = {
  path: "src/main.ts",
  language: "typescript",
  nodeId: "node-file-1",
  blobRef: undefined,
  terms: ["workspace/core@1"],
  items: [
    {
      nodeId: "node-item-1",
      type: "function",
      name: "main",
      signature: "function main(): void",
      span: "1:1-10:1",
      terms: [],
    },
    {
      nodeId: "node-item-2",
      type: "function",
      name: "helper",
      signature: "function helper(x: number): string",
      span: "12:1-20:1",
      terms: ["workspace/util@1"],
    },
  ],
};

type GraphKind = "memory" | "repo";

const sampleNeighborhood = {
  nodes: [
    { id: "node-file-1", label: "src/main.ts", type: "code/SourceFile@1", terms: [] },
    { id: "node-item-1", label: "main", type: "code/Function@1", terms: [] },
  ],
  edges: [{ id: "edge-1", from: "node-file-1", to: "node-item-1", type: "code/declares" }],
};

function setupHooks(
  overrides: {
    tree?: unknown[];
    fileView?: typeof sampleFileView | null;
    fileLoading?: boolean;
    regions?: typeof sampleRegions;
    activeGraphId?: string;
    graphs?: { id: string; name: string; kind: GraphKind }[];
    blobUrl?: string | null;
    neighborhood?: typeof sampleNeighborhood | null;
  } = {}
) {
  const graphs = overrides.graphs ?? [];
  const activeGraphId = overrides.activeGraphId ?? "main";

  vi.mocked(hooks.usePending).mockReturnValue({
    data: { proposals: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.usePending>);
  vi.mocked(hooks.useMemoryIndex).mockReturnValue({
    data: { results: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useMemoryIndex>);
  vi.mocked(hooks.useRecall).mockReturnValue({
    data: { results: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useRecall>);
  vi.mocked(hooks.useMemoryGraph).mockReturnValue({
    data: { nodes: [], edges: [], truncated: false },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useMemoryGraph>);
  vi.mocked(hooks.useUpdateMemory).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useUpdateMemory>);
  vi.mocked(hooks.useRecentMemories).mockReturnValue({
    data: { results: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useRecentMemories>);
  vi.mocked(hooks.useSchema).mockReturnValue({
    data: { entityTypes: [], edgeTypes: [], terms: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useSchema>);
  vi.mocked(hooks.usePrincipals).mockReturnValue({
    data: { principals: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.usePrincipals>);
  vi.mocked(hooks.useEntity).mockReturnValue({
    data: undefined,
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useEntity>);
  vi.mocked(hooks.useSession).mockReturnValue({
    data: { defaultAgent: "claude", embedder: "hash", port: 8710, owner: "owner" },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useSession>);
  vi.mocked(hooks.useVerify).mockReturnValue({
    data: undefined,
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useVerify>);
  vi.mocked(hooks.useGraphs).mockReturnValue({ graphs, defaultGraph: "main" });
  vi.mocked(hooks.useActiveGraph).mockReturnValue({
    activeGraphId,
    setActiveGraphId: vi.fn(),
  });
  vi.mocked(hooks.useCodeTree).mockReturnValue({
    data: { tree: overrides.tree ?? sampleTree },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useCodeTree>);
  vi.mocked(hooks.useCodeFile).mockReturnValue({
    data: overrides.fileView === null ? undefined : (overrides.fileView ?? sampleFileView),
    isLoading: overrides.fileLoading ?? false,
    isError: overrides.fileView === null,
    error: overrides.fileView === null ? { status: 404 } : null,
  } as unknown as ReturnType<typeof hooks.useCodeFile>);
  vi.mocked(hooks.useCodeItem).mockReturnValue({
    data: undefined,
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useCodeItem>);
  vi.mocked(hooks.useCodeRegions).mockReturnValue({
    data: { rules: overrides.regions ?? sampleRegions },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useCodeRegions>);
  vi.mocked(hooks.useClassify).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useClassify>);
  vi.mocked(hooks.useListGraphs).mockReturnValue({
    data: { graphs: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useListGraphs>);
  vi.mocked(hooks.useGitHubBlobUrl).mockReturnValue(
    overrides.blobUrl !== undefined ? overrides.blobUrl : null
  );
  vi.mocked(hooks.useCodeNeighborhood).mockReturnValue({
    data:
      overrides.neighborhood === null ? undefined : (overrides.neighborhood ?? sampleNeighborhood),
    isLoading: false,
    isError: overrides.neighborhood === null,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCodeNeighborhood>);
}

async function renderCode(overrides: Parameters<typeof setupHooks>[0] = {}, initialPath = "/code") {
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

describe("Code workspace", () => {
  // Stub localStorage (happy-dom limitation)
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

  describe("Nav gating", () => {
    it("Code nav item is hidden when active graph is memory kind", async () => {
      const graphs = [{ id: "main", name: "main", kind: "memory" as GraphKind }];
      await renderCode({ graphs, activeGraphId: "main" });
      expect(screen.queryByRole("link", { name: /^code$/i })).not.toBeInTheDocument();
    });

    it("Code nav item is visible when active graph is repo kind", async () => {
      const graphs = [
        { id: "main", name: "main", kind: "memory" as GraphKind },
        { id: "repo-1", name: "my-repo", kind: "repo" as GraphKind },
      ];
      await renderCode({ graphs, activeGraphId: "repo-1" });
      expect(screen.getByRole("link", { name: /^code$/i })).toBeInTheDocument();
    });
  });

  describe("File tree", () => {
    it("renders directory and file nodes from the tree fixture", async () => {
      await renderCode();
      expect(screen.getByText("src")).toBeInTheDocument();
      expect(screen.getByText("main.ts")).toBeInTheDocument();
      expect(screen.getByText("utils.ts")).toBeInTheDocument();
    });

    it("shows resting state message when no file is selected", async () => {
      await renderCode();
      expect(screen.getByText(/select a file/i)).toBeInTheDocument();
    });

    it("renders language chip after file name", async () => {
      await renderCode();
      expect(screen.getAllByText("typescript")).toHaveLength(2);
    });

    it("renders classification chips (node.terms) after language chip", async () => {
      await renderCode();
      expect(screen.getByText("workspace/core")).toBeInTheDocument();
    });
  });

  describe("File page", () => {
    it("shows the file path and declared items", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByText("src/main.ts")).toBeInTheDocument();
      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("helper")).toBeInTheDocument();
    });

    it("shows item signatures when present", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByText("function main(): void")).toBeInTheDocument();
    });

    it("shows the not-yet-indexed hint for a 404 file", async () => {
      await renderCode({ fileView: null }, "/code/file?path=src%2Funknown.ts");
      expect(screen.getByText(/allod git index/)).toBeInTheDocument();
    });
  });

  describe("Regions panel", () => {
    it("renders each region rule with its rule name and paths", async () => {
      await renderCode();
      expect(screen.getByText("policy/auth-review")).toBeInTheDocument();
      expect(screen.getByText("src/auth/login.ts")).toBeInTheDocument();
      expect(screen.getByText("src/auth/middleware.ts")).toBeInTheDocument();
    });

    it("renders rules without a region field", async () => {
      await renderCode();
      expect(screen.getByText("policy/api-review")).toBeInTheDocument();
      expect(screen.getByText("src/api/routes.ts")).toBeInTheDocument();
    });

    it("renders reviewers as a comma-separated string when they arrive as array", async () => {
      await renderCode();
      expect(screen.getByText("alice, bob")).toBeInTheDocument();
    });

    it("renders single reviewer from array", async () => {
      await renderCode();
      expect(screen.getByText("charlie")).toBeInTheDocument();
    });
  });

  describe("Classify affordance", () => {
    it("renders a classification input and Apply button on the file page", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByRole("textbox", { name: /classification term/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /apply/i })).toBeInTheDocument();
    });

    it("Classify section heading is visible on the file page", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByText("Classify")).toBeInTheDocument();
    });
  });

  describe("GitHub blob link", () => {
    it("does not render the link when blobUrl is null", async () => {
      await renderCode({ blobUrl: null }, "/code/file?path=src%2Fmain.ts");
      expect(screen.queryByTestId("github-blob-link")).not.toBeInTheDocument();
    });

    it("renders the link when a GitHub blobUrl is provided", async () => {
      await renderCode(
        { blobUrl: "https://github.com/acme/myrepo/blob/HEAD/src/main.ts" },
        "/code/file?path=src%2Fmain.ts"
      );
      const link = screen.getByTestId("github-blob-link");
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "https://github.com/acme/myrepo/blob/HEAD/src/main.ts");
    });
  });

  describe("Graph tab", () => {
    it("renders the Graph tab link on the file page", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByTestId("graph-tab-link")).toBeInTheDocument();
    });

    it("graph page renders node labels from the neighborhood", async () => {
      await renderCode({}, "/code/graph?path=src%2Fmain.ts");
      // The ReactFlow canvas renders nodes; check that node label text appears
      expect(screen.getByText("src/main.ts")).toBeInTheDocument();
    });

    it("graph page renders empty state when no nodes returned", async () => {
      await renderCode({ neighborhood: null }, "/code/graph?path=src%2Fmain.ts");
      expect(screen.getByText(/no neighborhood data/i)).toBeInTheDocument();
    });
  });

  describe("Governed-path link navigation", () => {
    it("renders governed paths as links in the regions panel", async () => {
      await renderCode();
      const pathLinks = screen.getAllByRole("link", { name: /src\/auth\// });
      expect(pathLinks.length).toBeGreaterThan(0);
      expect(pathLinks[0]).toHaveAttribute("href", expect.stringContaining("path="));
    });

    it("renders file tree links with correct path search param", async () => {
      await renderCode();
      const fileLink = screen.getByTestId("code-file-src/main.ts");
      expect(fileLink).toHaveAttribute("href", expect.stringContaining("path="));
    });
  });
});
