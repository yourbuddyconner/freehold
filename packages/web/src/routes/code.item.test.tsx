import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "~/lib/hooks";
import { routeTree } from "~/routes/../routeTree.gen";

// Mock @pierre/diffs/react File component
vi.mock("@pierre/diffs/react", () => ({
  File: ({ file }: { file: { name: string; contents: string } }) => (
    <pre data-testid="pierre-file">{file.contents}</pre>
  ),
}));

// Stub PierreTree used by the code workspace shell
vi.mock("~/components/PierreTree", () => ({
  PierreTree: ({
    paths,
    onSelect,
  }: {
    paths: string[];
    onSelect: (path: string, kind: "file" | "directory") => void;
  }) => (
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

const sampleSource = {
  path: "src/auth/login.ts",
  content:
    "// preamble\n// preamble\nfunction authenticate(user: string): boolean {\n  return true;\n}\nfunction helper() {}\n",
  truncated: false,
  binary: false,
  size: 120,
};

const sampleItem = {
  nodeId: "node-fn-1",
  type: "code/Function@1",
  name: "authenticate",
  signature: "function authenticate(user: string): boolean",
  span: "3:1-5:1",
  terms: ["workspace/auth@1"],
  filePath: "src/auth/login.ts",
  callersIn: [
    {
      nodeId: "node-caller-1",
      type: "code/Function@1",
      name: "handleLogin",
      signature: "function handleLogin(): void",
      span: "1:1-8:1",
      terms: [],
      filePath: "src/routes/login.ts",
    },
  ],
  callsOut: [
    {
      nodeId: "node-callee-1",
      type: "code/Function@1",
      name: "hashPassword",
      signature: "function hashPassword(pw: string): string",
      span: "10:1-15:1",
      terms: [],
      filePath: "src/auth/crypto.ts",
    },
    {
      nodeId: "node-callee-2",
      type: "code/Function@1",
      name: "logEvent",
      signature: "function logEvent(e: string): void",
      span: "1:1-5:1",
      terms: [],
      filePath: "src/auth/crypto.ts",
    },
  ],
};

const sampleRegions = [
  {
    rule: "policy/auth-review",
    region: "auth",
    reviewers: ["alice"],
    paths: ["src/auth/login.ts", "src/auth/crypto.ts"],
  },
  {
    rule: "policy/api-review",
    reviewers: [],
    paths: ["src/api/routes.ts"],
  },
];

type GraphKind = "memory" | "repo";

function setupHooks(
  overrides: {
    item?: typeof sampleItem | null;
    itemLoading?: boolean;
    regions?: typeof sampleRegions;
    source?: typeof sampleSource | null;
    sourceLoading?: boolean;
    graphs?: { id: string; name: string; kind: GraphKind }[];
  } = {}
) {
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
  vi.mocked(hooks.useGraphs).mockReturnValue({
    graphs: overrides.graphs ?? [],
    defaultGraph: "main",
  });
  vi.mocked(hooks.useActiveGraph).mockReturnValue({
    activeGraphId: "main",
    setActiveGraphId: vi.fn(),
  });
  vi.mocked(hooks.useCodeTree).mockReturnValue({
    data: { tree: [] },
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useCodeTree>);
  vi.mocked(hooks.useCodeFile).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCodeFile>);
  vi.mocked(hooks.useCodeItem).mockReturnValue({
    data: overrides.item === null ? undefined : (overrides.item ?? sampleItem),
    isLoading: overrides.itemLoading ?? false,
    isError: overrides.item === null,
    error: overrides.item === null ? { status: 404 } : null,
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
  vi.mocked(hooks.useGitHubBlobUrl).mockReturnValue(null);
  vi.mocked(hooks.useCodeNeighborhood).mockReturnValue({
    data: undefined,
    ...emptyQuery,
  } as unknown as ReturnType<typeof hooks.useCodeNeighborhood>);
  vi.mocked(hooks.useCodeSource).mockReturnValue({
    data: overrides.source === null ? undefined : (overrides.source ?? sampleSource),
    isLoading: overrides.sourceLoading ?? false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCodeSource>);
}

async function renderItem(
  overrides: Parameters<typeof setupHooks>[0] = {},
  initialPath = "/code/item?nodeId=node-fn-1"
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

describe("Code item detail page", () => {
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

  describe("Header", () => {
    it("renders the item name and signature", async () => {
      await renderItem();
      expect(screen.getByText("authenticate")).toBeInTheDocument();
      expect(screen.getByText("function authenticate(user: string): boolean")).toBeInTheDocument();
    });

    it("renders the span", async () => {
      await renderItem();
      expect(screen.getByTestId("item-span")).toBeInTheDocument();
      expect(screen.getByTestId("item-span")).toHaveTextContent("3:1-5:1");
    });

    it("renders a path breadcrumb linking to the file page", async () => {
      await renderItem();
      const link = screen.getByTestId("breadcrumb-file-link");
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", expect.stringContaining("path="));
    });

    it("shows 'Item not found' when item is missing", async () => {
      await renderItem({ item: null });
      expect(screen.getByText(/item not found/i)).toBeInTheDocument();
    });

    it("shows 'No item specified' when no nodeId is given", async () => {
      await renderItem({}, "/code/item");
      expect(screen.getByText(/no item specified/i)).toBeInTheDocument();
    });
  });

  describe("Inline source", () => {
    it("renders the item source panel when filePath and source are available", async () => {
      await renderItem();
      expect(screen.getByTestId("item-source-panel")).toBeInTheDocument();
    });

    it("shows line range label when span is parseable", async () => {
      await renderItem();
      // span is "3:1-5:1" → lines 3–5
      expect(screen.getByText(/Lines 3–5/)).toBeInTheDocument();
    });

    it("slices the source content to the item's line range", async () => {
      await renderItem();
      // sampleSource has "// preamble\n// preamble\nfunction authenticate..." at lines 3-5
      // The sliced content should contain the function body, not the preamble
      const panel = screen.getByTestId("item-source-panel");
      const pre = within(panel).getByTestId("pierre-file");
      expect(pre.textContent).toContain("function authenticate");
      expect(pre.textContent).not.toContain("// preamble");
    });

    it("renders a 'View full file' link", async () => {
      await renderItem();
      const link = screen.getByTestId("source-full-file-link");
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", expect.stringContaining("path="));
    });

    it("does not render source panel when source is unavailable", async () => {
      await renderItem({ source: null });
      expect(screen.queryByTestId("item-source-panel")).not.toBeInTheDocument();
    });
  });

  describe("Governance context", () => {
    it("shows governance chips when the item's file is covered by a rule", async () => {
      await renderItem();
      const section = screen.getByTestId("governance-context");
      expect(section).toBeInTheDocument();
      // src/auth/login.ts is covered by policy/auth-review
      const chip = within(section).getByTestId("governance-chip");
      expect(chip).toHaveTextContent("policy/auth-review");
    });

    it("shows region name in parentheses when present", async () => {
      await renderItem();
      const chips = screen.getAllByTestId("governance-chip");
      const authChip = chips.find((c) => c.textContent?.includes("policy/auth-review"));
      expect(authChip?.textContent).toContain("auth");
    });

    it("does not show governance section when no rules match the file", async () => {
      // Use regions that don't include the item's filePath
      await renderItem({
        regions: [{ rule: "policy/other", reviewers: [], paths: ["src/other.ts"] }],
      });
      expect(screen.queryByTestId("governance-context")).not.toBeInTheDocument();
    });

    it("does not show governance section when regions list is empty", async () => {
      await renderItem({ regions: [] });
      expect(screen.queryByTestId("governance-context")).not.toBeInTheDocument();
    });
  });

  describe("Relations — callers", () => {
    it("shows the 'Called by' section with count", async () => {
      await renderItem();
      const section = screen.getByTestId("callers-section");
      expect(section).toBeInTheDocument();
      expect(within(section).getByText(/Called by/)).toBeInTheDocument();
      expect(within(section).getAllByText("(1)").length).toBeGreaterThan(0);
    });

    it("renders caller name as a link to its item detail page", async () => {
      await renderItem();
      const section = screen.getByTestId("callers-section");
      const link = within(section).getByTestId("relation-item-link");
      expect(link).toHaveTextContent("handleLogin");
      expect(link).toHaveAttribute("href", expect.stringContaining("nodeId=node-caller-1"));
    });

    it("renders the caller's file path as a link", async () => {
      await renderItem();
      const section = screen.getByTestId("callers-section");
      const fileLink = within(section).getByTestId("relation-file-link");
      expect(fileLink).toHaveTextContent("src/routes/login.ts");
      expect(fileLink).toHaveAttribute("href", expect.stringContaining("path="));
    });

    it("does not show 'Called by' section when callersIn is empty", async () => {
      await renderItem({
        item: { ...sampleItem, callersIn: [] },
      });
      expect(screen.queryByTestId("callers-section")).not.toBeInTheDocument();
    });
  });

  describe("Relations — callees", () => {
    it("shows the 'Calls' section with count", async () => {
      await renderItem();
      const section = screen.getByTestId("callees-section");
      expect(section).toBeInTheDocument();
      expect(within(section).getByText(/^Calls/)).toBeInTheDocument();
      expect(within(section).getAllByText("(2)").length).toBeGreaterThan(0);
    });

    it("groups callees by file with a file group header", async () => {
      await renderItem();
      const section = screen.getByTestId("callees-section");
      // both callees share src/auth/crypto.ts — should appear as group header
      expect(within(section).getAllByText("src/auth/crypto.ts").length).toBeGreaterThan(0);
    });

    it("renders each callee name as a link to its item detail page", async () => {
      await renderItem();
      const section = screen.getByTestId("callees-section");
      const links = within(section).getAllByTestId("relation-item-link");
      const names = links.map((l) => l.textContent);
      expect(names).toContain("hashPassword");
      expect(names).toContain("logEvent");
    });

    it("does not show 'Calls' section when callsOut is empty", async () => {
      await renderItem({
        item: { ...sampleItem, callsOut: [] },
      });
      expect(screen.queryByTestId("callees-section")).not.toBeInTheDocument();
    });
  });

  describe("Classify panel", () => {
    it("renders a classification input on the item page", async () => {
      await renderItem();
      expect(screen.getByRole("textbox", { name: /classification term/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /apply/i })).toBeInTheDocument();
    });
  });
});
