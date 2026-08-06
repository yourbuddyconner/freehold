import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "~/lib/hooks";
import { routeTree } from "~/routes/../routeTree.gen";

// Capture options passed to PierreFile so hover-card tests can trigger callbacks.
const fileOptionsRef = vi.hoisted(() => ({
  current: {} as {
    onLineEnter?: (p: {
      lineNumber: number;
      type: "line";
      lineElement: HTMLElement;
      numberElement: HTMLElement;
      numberColumn: boolean;
      event: PointerEvent;
    }) => void;
    onLineLeave?: (p: {
      lineNumber: number;
      type: "line";
      lineElement: HTMLElement;
      numberElement: HTMLElement;
      numberColumn: boolean;
      event: PointerEvent;
    }) => void;
  },
}));

// Capture props passed to PierreTree so we can assert on initialExpansion.
const treePropsRef = vi.hoisted(() => ({
  current: { initialExpansion: undefined as string | undefined },
}));

// Mock @pierre/diffs/react File component — renders contents as a <pre> so tests can
// assert on source content without the web-component shadow DOM.
vi.mock("@pierre/diffs/react", () => ({
  File: ({
    file,
    options,
  }: {
    file: { name: string; contents: string };
    options?: typeof fileOptionsRef.current;
  }) => {
    fileOptionsRef.current = (options ?? {}) as typeof fileOptionsRef.current;
    return <pre data-testid="pierre-file">{file.contents}</pre>;
  },
}));

// Route-level mock for PierreTree — renders a flat button per path so tests can
// assert on paths prop and simulate file selection without @pierre/trees internals.
vi.mock("~/components/PierreTree", () => ({
  PierreTree: ({
    paths,
    onSelect,
    initialExpansion,
  }: {
    paths: string[];
    onSelect: (path: string, kind: "file" | "directory") => void;
    initialExpansion?: string;
  }) => {
    treePropsRef.current = { initialExpansion };
    return (
      <div data-testid="pierre-tree-root">
        {paths.map((p) => (
          <button
            key={p}
            type="button"
            data-testid="tree-row"
            data-path={p}
            onClick={() => onSelect(p, "file")}
          >
            {p}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock("~/components/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => (
    <div data-testid="markdown-view">{children}</div>
  ),
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
  useCodeTree: vi.fn(),
  useCodeFile: vi.fn(),
  useCodeItem: vi.fn(),
  useCodeRegions: vi.fn(),
  useCodeSource: vi.fn(),
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
    codeSource: vi.fn(),
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

const treeWithReadme = [
  { name: "README.md", path: "README.md", kind: "file" as const },
  {
    name: "src",
    path: "src",
    kind: "dir" as const,
    children: [
      {
        name: "main.ts",
        path: "src/main.ts",
        kind: "file" as const,
        language: "typescript",
        terms: [],
      },
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

const sampleSource = {
  path: "src/main.ts",
  content: "function main() {\n  console.log('hello');\n}\n",
  truncated: false,
  binary: false,
  size: 44,
};

const markdownSource = {
  path: "README.md",
  content: "# Hello\n\nThis is markdown.",
  truncated: false,
  binary: false,
  size: 30,
};

const binarySource = {
  path: "src/main.ts",
  content: "",
  truncated: false,
  binary: true,
  size: 100,
};

const truncatedSource = {
  path: "src/main.ts",
  content: "a".repeat(512 * 1024),
  truncated: true,
  binary: false,
  size: 700 * 1024,
};

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
    source?: typeof sampleSource | null;
    sourceLoading?: boolean;
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
  vi.mocked(hooks.useCodeSource).mockReturnValue({
    data: overrides.source === null ? undefined : (overrides.source ?? sampleSource),
    isLoading: overrides.sourceLoading ?? false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCodeSource>);
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
    fileOptionsRef.current = {};
    treePropsRef.current = { initialExpansion: undefined };
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
    it("passes flattened file paths from the nested tree to PierreTree", async () => {
      await renderCode();
      // sampleTree has two files: src/main.ts and src/utils.ts (dir "src" is not a file)
      const rows = screen.getAllByTestId("tree-row");
      const paths = rows.map((r) => r.getAttribute("data-path"));
      expect(paths).toContain("src/main.ts");
      expect(paths).toContain("src/utils.ts");
      // Directory paths are NOT included
      expect(paths).not.toContain("src");
    });

    it("shows resting state message when no file is selected", async () => {
      await renderCode();
      expect(screen.getByText(/select a file/i)).toBeInTheDocument();
    });

    it("clicking a file row navigates to the code file route", async () => {
      await renderCode();
      const mainRow = screen
        .getAllByTestId("tree-row")
        .find((r) => r.getAttribute("data-path") === "src/main.ts");
      expect(mainRow).toBeDefined();
      await act(async () => {
        mainRow?.click();
      });
      // After navigation the file view (src/main.ts) heading should be visible
      expect(screen.getAllByText("src/main.ts").length).toBeGreaterThan(0);
      // The "select a file" resting state should no longer be shown
      expect(screen.queryByText(/select a file/i)).not.toBeInTheDocument();
    });
  });

  describe("File page", () => {
    it("shows the file path and declared items", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      // The path appears in the file heading (and also in the sidebar tree mock)
      expect(screen.getAllByText("src/main.ts").length).toBeGreaterThan(0);
      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("helper")).toBeInTheDocument();
    });

    it("shows item signatures when present", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByText("function main(): void")).toBeInTheDocument();
    });

    it("shows the not-yet-indexed hint for a 404 file", async () => {
      await renderCode({ fileView: null, source: null }, "/code/file?path=src%2Funknown.ts");
      expect(screen.getByText(/allod git index/)).toBeInTheDocument();
    });

    it("renders source with syntax highlighting when source data is present", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      // Source section heading
      expect(screen.getByText("Source")).toBeInTheDocument();
      // Some code content — scoped to source panel to avoid matching item signature
      const sourcePanel = screen.getByTestId("source-panel");
      const { getByText } = within(sourcePanel);
      expect(getByText(/function main/)).toBeInTheDocument();
    });

    it("shows binary caption when source is a binary file", async () => {
      await renderCode({ source: binarySource }, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByText(/binary file — not rendered/)).toBeInTheDocument();
    });

    it("shows truncated caption when source was truncated", async () => {
      await renderCode({ source: truncatedSource }, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByText(/truncated at 512 KB/)).toBeInTheDocument();
    });

    it("shows source + not-indexed hint when file is on disk but not indexed", async () => {
      // fileView: null → codeFile 404; source succeeds
      await renderCode(
        { fileView: null, source: sampleSource },
        "/code/file?path=src%2Funknown.ts"
      );
      // The not-indexed inline hint (not the full-page fallback)
      expect(screen.getByText(/allod git index/)).toBeInTheDocument();
      // Still shows source
      expect(screen.getByText("Source")).toBeInTheDocument();
    });

    it("shows full not-indexed page when both codeFile and codeSource are unavailable", async () => {
      await renderCode({ fileView: null, source: null }, "/code/file?path=src%2Funknown.ts");
      expect(screen.getByText(/allod git index/)).toBeInTheDocument();
      // Source heading should NOT appear
      expect(screen.queryByText("Source")).not.toBeInTheDocument();
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
      // (path also appears in the sidebar tree mock, so use getAllByText)
      expect(screen.getAllByText("src/main.ts").length).toBeGreaterThan(0);
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

    it("clicking a tree-row file navigates to the code file route with the correct path", async () => {
      await renderCode();
      const mainRow = screen
        .getAllByTestId("tree-row")
        .find((r) => r.getAttribute("data-path") === "src/main.ts");
      expect(mainRow).toBeDefined();
      await act(async () => {
        mainRow?.click();
      });
      // The file page heading for src/main.ts is now displayed (resting state gone)
      expect(screen.queryByText(/select a file/i)).not.toBeInTheDocument();
      expect(screen.getAllByText("src/main.ts").length).toBeGreaterThan(0);
    });
  });

  describe("Markdown toggle", () => {
    it("Raw | Rendered toggle is shown for .md files", async () => {
      await renderCode({ source: markdownSource }, "/code/file?path=README.md");
      expect(screen.getByTestId("md-toggle-raw")).toBeInTheDocument();
      expect(screen.getByTestId("md-toggle-rendered")).toBeInTheDocument();
    });

    it("defaults to Rendered view for .md files", async () => {
      await renderCode({ source: markdownSource }, "/code/file?path=README.md");
      expect(screen.getByTestId("markdown-view")).toBeInTheDocument();
      expect(screen.queryByTestId("pierre-file")).not.toBeInTheDocument();
    });

    it("toggle switches to Raw view", async () => {
      await renderCode({ source: markdownSource }, "/code/file?path=README.md");
      await act(async () => {
        fireEvent.click(screen.getByTestId("md-toggle-raw"));
      });
      expect(screen.getByTestId("pierre-file")).toBeInTheDocument();
      expect(screen.queryByTestId("markdown-view")).not.toBeInTheDocument();
    });

    it("persists Raw choice to localStorage", async () => {
      await renderCode({ source: markdownSource }, "/code/file?path=README.md");
      await act(async () => {
        fireEvent.click(screen.getByTestId("md-toggle-raw"));
      });
      expect(store.get("freehold-md-view")).toBe("raw");
    });

    it("restores Raw from localStorage on mount", async () => {
      store.set("freehold-md-view", "raw");
      await renderCode({ source: markdownSource }, "/code/file?path=README.md");
      expect(screen.getByTestId("pierre-file")).toBeInTheDocument();
      expect(screen.queryByTestId("markdown-view")).not.toBeInTheDocument();
    });

    it("does not show toggle for non-markdown files", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      expect(screen.queryByTestId("md-toggle-raw")).not.toBeInTheDocument();
    });
  });

  describe("Tree defaults", () => {
    it("PierreTree receives initialExpansion=closed", async () => {
      await renderCode();
      expect(treePropsRef.current.initialExpansion).toBe("closed");
    });

    it("shows ReadmePreview when tree has a root README and no path selected", async () => {
      await renderCode({ tree: treeWithReadme, source: markdownSource });
      // README caption should be visible
      expect(screen.getByText("README")).toBeInTheDocument();
      // MarkdownView should render the content
      expect(screen.getByTestId("markdown-view")).toBeInTheDocument();
    });

    it("does not show ReadmePreview when a path is already selected", async () => {
      await renderCode(
        { tree: treeWithReadme, source: markdownSource },
        "/code/file?path=README.md"
      );
      // On the file route, we're not on isExact path, so ReadmePreview won't show
      expect(screen.queryByText("README")).not.toBeInTheDocument();
    });

    it("shows resting state when no README in tree root", async () => {
      await renderCode({ tree: sampleTree });
      expect(screen.getByText(/select a file/i)).toBeInTheDocument();
    });
  });

  describe("Hover context cards", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("no hover card shown initially", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      expect(screen.queryByTestId("hover-card")).not.toBeInTheDocument();
    });

    it("hover card appears when onLineEnter fires for a line within an item span", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      await act(async () => {
        fileOptionsRef.current.onLineEnter?.({
          lineNumber: 1,
          type: "line",
          lineElement: document.createElement("div"),
          numberElement: document.createElement("div"),
          numberColumn: false,
          event: new PointerEvent("pointerenter"),
        });
        vi.advanceTimersByTime(150);
      });
      expect(screen.getByTestId("hover-card")).toBeInTheDocument();
      expect(screen.getByTestId("hover-card")).toHaveTextContent("main");
    });

    it("hover card dismisses when onLineLeave fires", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      // First show the card
      await act(async () => {
        fileOptionsRef.current.onLineEnter?.({
          lineNumber: 1,
          type: "line",
          lineElement: document.createElement("div"),
          numberElement: document.createElement("div"),
          numberColumn: false,
          event: new PointerEvent("pointerenter"),
        });
        vi.advanceTimersByTime(150);
      });
      expect(screen.getByTestId("hover-card")).toBeInTheDocument();
      // Then dismiss it
      await act(async () => {
        fileOptionsRef.current.onLineLeave?.({
          lineNumber: 1,
          type: "line",
          lineElement: document.createElement("div"),
          numberElement: document.createElement("div"),
          numberColumn: false,
          event: new PointerEvent("pointerleave"),
        });
        vi.advanceTimersByTime(150);
      });
      expect(screen.queryByTestId("hover-card")).not.toBeInTheDocument();
    });

    it("hover card links to item detail page", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      await act(async () => {
        fileOptionsRef.current.onLineEnter?.({
          lineNumber: 1,
          type: "line",
          lineElement: document.createElement("div"),
          numberElement: document.createElement("div"),
          numberColumn: false,
          event: new PointerEvent("pointerenter"),
        });
        vi.advanceTimersByTime(150);
      });
      const card = screen.getByTestId("hover-card");
      const link = within(card).getByRole("link");
      expect(link).toHaveAttribute("href", expect.stringContaining("nodeId=node-item-1"));
    });

    it("hover card shows correct item for line 12 (helper function)", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      await act(async () => {
        fileOptionsRef.current.onLineEnter?.({
          lineNumber: 12,
          type: "line",
          lineElement: document.createElement("div"),
          numberElement: document.createElement("div"),
          numberColumn: false,
          event: new PointerEvent("pointerenter"),
        });
        vi.advanceTimersByTime(150);
      });
      const card = screen.getByTestId("hover-card");
      expect(card).toHaveTextContent("helper");
    });

    it("no hover card when line has no matching item", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      await act(async () => {
        fileOptionsRef.current.onLineEnter?.({
          lineNumber: 11, // gap between spans
          type: "line",
          lineElement: document.createElement("div"),
          numberElement: document.createElement("div"),
          numberColumn: false,
          event: new PointerEvent("pointerenter"),
        });
        vi.advanceTimersByTime(150);
      });
      expect(screen.queryByTestId("hover-card")).not.toBeInTheDocument();
    });
  });
});
