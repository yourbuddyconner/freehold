/**
 * Tests for /review/$sha — full-page commit review.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "~/lib/hooks";
import { routeTree } from "~/routes/../routeTree.gen";

// Mock hooks — include all hooks used by the page and by AppShell
vi.mock("~/lib/hooks", () => ({
  useGitProposal: vi.fn(),
  useGitProposalDiff: vi.fn(),
  useDecideProposal: vi.fn(),
  useSession: vi.fn(),
  useActiveGraph: vi.fn(),
  useGraphs: vi.fn(),
  // AppShell uses these:
  usePending: vi.fn().mockReturnValue({ data: { proposals: [] }, isLoading: false }),
  useGitProposals: vi.fn().mockReturnValue({ data: { proposals: [] }, isLoading: false }),
}));

// Mock api (needed by ReviewComposer)
vi.mock("~/lib/api", () => ({
  GRAPH_STORAGE_KEY: "freehold-graph",
  setActiveGraph: vi.fn(),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  apiClient: {
    postGitReview: vi.fn().mockResolvedValue({ reviewId: "rv-1", commentIds: [], status: "saved" }),
    decideGitProposal: vi.fn().mockResolvedValue({ outcome: "approved", pushed: true }),
    pushGitNotes: vi.fn().mockResolvedValue({ pushed: true }),
  },
}));

// Stub PierreDiff
vi.mock("~/components/PierreDiff", () => ({
  PierreDiff: () => <pre data-testid="pierre-diff" />,
}));

// Stub PierreTree — renders a button per path so tests can simulate tree-row clicks
const mockScrollToPath = vi.fn();
vi.mock("~/components/PierreTree", () => ({
  PierreTree: ({
    paths,
    onSelect,
    scrollToRef,
  }: {
    paths: string[];
    onSelect: (path: string, kind: string) => void;
    scrollToRef?: React.Ref<{ scrollToPath: (path: string) => void }>;
  }) => {
    // Expose scrollToPath handle via the ref so tests can verify it's wired
    if (scrollToRef && typeof scrollToRef === "object" && "current" in scrollToRef) {
      (scrollToRef as React.MutableRefObject<{ scrollToPath: (path: string) => void }>).current = {
        scrollToPath: mockScrollToPath,
      };
    }
    return (
      <div data-testid="pierre-tree">
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

// Stub CodeView from @pierre/diffs/react — renders one pre per item keyed by id
const mockCodeViewScrollTo = vi.fn();
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({
    items,
    options,
    ref,
  }: {
    items: Array<{ id: string; type: string }>;
    options?: { diffStyle?: string };
    ref?: React.Ref<{ scrollTo: (target: { type: string; id: string }) => void }>;
  }) => {
    if (ref && typeof ref === "object" && "current" in ref) {
      (
        ref as React.MutableRefObject<{ scrollTo: (target: { type: string; id: string }) => void }>
      ).current = { scrollTo: mockCodeViewScrollTo };
    }
    return (
      <div data-testid="code-view" data-diff-style={options?.diffStyle ?? "split"}>
        {(items ?? []).map((i) => (
          <pre key={i.id} data-testid="diff-file">
            {i.id}
          </pre>
        ))}
      </div>
    );
  },
  FileDiff: () => <div data-testid="file-diff" />,
}));

const SHA = "deadbeef1234567890000000000000000000000";
const SHORT_SHA = SHA.slice(0, 7);

const baseProposal = {
  sha: SHA,
  ref: "refs/heads/main",
  author: "alice",
  timestamp: "2026-01-01T00:00:00Z",
  message: "feat: add new feature",
  target: "refs/heads/main",
  matched: ["require-reviewer"],
  checklist: [{ role: "reviewer" }],
  unmet: ["reviewer"],
  decided: "undecided" as const,
  paths: [{ verb: "M", path: "src/lib.rs", regions: ["lib"], indexed: true }],
  checks: [],
};

const baseDiff = {
  files: [
    {
      path: "src/lib.rs",
      verb: "M",
      binary: false,
      oldContent: "fn old() {}\n",
      newContent: "fn new() {}\n",
      truncated: false,
    },
  ],
  truncated: false,
};

const defaultDecideMock = {
  decideMut: { mutate: vi.fn(), isPending: false, variables: undefined },
  decideOutcome: null,
  keyMissingReason: null,
  savedLocally: false,
  pushSkippedNotice: false,
  retrying: false,
  handleRetry: vi.fn(),
};

function setupDefaults(
  overrides: {
    proposal?: ReturnType<typeof hooks.useGitProposal>["data"] | null;
    diff?: { files: unknown[]; truncated: boolean } | null;
    kind?: string;
    // biome-ignore lint/suspicious/noExplicitAny: test helper, flexible shape
    decide?: Record<string, any>;
  } = {}
) {
  const proposal = overrides.proposal !== undefined ? overrides.proposal : baseProposal;
  const diff = overrides.diff !== undefined ? overrides.diff : baseDiff;
  const kind = overrides.kind ?? "repo";

  vi.mocked(hooks.useGitProposal).mockReturnValue({
    data: proposal as never,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useGitProposal>);

  vi.mocked(hooks.useGitProposalDiff).mockReturnValue({
    data: diff as never,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useGitProposalDiff>);

  vi.mocked(hooks.useSession).mockReturnValue({
    data: { owner: "alice", defaultAgent: "claude", port: 8710, graphs: [], defaultGraph: "main" },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useSession>);

  vi.mocked(hooks.useGraphs).mockReturnValue({
    graphs: [{ id: "repo-1", name: "my-repo", kind: kind as "repo" | "memory" }],
    defaultGraph: "repo-1",
  });

  vi.mocked(hooks.useActiveGraph).mockReturnValue({
    activeGraphId: "repo-1",
    setActiveGraphId: vi.fn(),
  });

  vi.mocked(hooks.useDecideProposal).mockReturnValue({
    ...defaultDecideMock,
    ...overrides.decide,
  } as unknown as ReturnType<typeof hooks.useDecideProposal>);
}

async function renderReviewPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/review/${SHA}`] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  });
}

// happy-dom's localStorage lacks full API in this version; stub with a Map.
const localStore = new Map<string, string>();

describe("/review/$sha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStore.clear();
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

  it("renders short sha, message, author, decided chip", async () => {
    setupDefaults();
    await renderReviewPage();
    expect(screen.getByText(SHORT_SHA)).toBeInTheDocument();
    expect(screen.getByText("feat: add new feature")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByTestId("decided-chip")).toBeInTheDocument();
    expect(screen.getByTestId("decided-chip")).toHaveTextContent("undecided");
  });

  it("renders per-file diff section for text file", async () => {
    setupDefaults();
    await renderReviewPage();
    // File path appears in both paths section and diff section — just check diff exists
    expect(screen.getAllByText("src/lib.rs").length).toBeGreaterThan(0);
    expect(screen.getByTestId("diff-file")).toBeInTheDocument();
  });

  it("renders binary caption for binary files", async () => {
    setupDefaults({
      diff: {
        files: [
          {
            path: "image.png",
            verb: "A",
            binary: true,
            oldContent: "",
            newContent: "",
            truncated: false,
          },
        ],
        truncated: false,
      },
    });
    await renderReviewPage();
    expect(screen.getByText("Binary file.")).toBeInTheDocument();
  });

  it("renders review composer", async () => {
    setupDefaults();
    await renderReviewPage();
    expect(screen.getByTestId("review-composer")).toBeInTheDocument();
  });

  it("shows repo-only notice for memory graph", async () => {
    setupDefaults({ kind: "memory" });
    await renderReviewPage();
    expect(screen.getByText(/repo graph/i)).toBeInTheDocument();
  });

  it("approve button calls decideMut.mutate with approve", async () => {
    const mutate = vi.fn();
    setupDefaults({
      decide: {
        decideMut: { mutate, isPending: false, variables: undefined } as never,
      },
    });
    await renderReviewPage();
    // Click the outer trigger button
    const approveBtn = screen.getByRole("button", { name: /^approve$/i });
    await act(async () => {
      approveBtn.click();
    });
    // Click the confirm button inside the dialog
    const confirmBtn = screen
      .getAllByRole("button", { name: /^approve$/i })
      .find((b) => b.closest("[role=dialog]"));
    expect(confirmBtn).toBeDefined();
    await act(async () => {
      confirmBtn?.click();
    });
    expect(mutate).toHaveBeenCalledWith("approve");
  });

  it("key-missing: shows notice and disables governance buttons", async () => {
    setupDefaults({
      decide: { keyMissingReason: "no signing key for alice" },
    });
    await renderReviewPage();
    expect(screen.getByTestId("key-missing-notice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reject/i })).toBeDisabled();
  });

  it("checklist rows render met/unmet", async () => {
    setupDefaults();
    await renderReviewPage();
    const unmet = screen.getByLabelText("unmet");
    expect(unmet).toBeInTheDocument();
  });

  it("touched paths section renders region badges", async () => {
    setupDefaults();
    await renderReviewPage();
    expect(screen.getByText("lib")).toBeInTheDocument();
  });

  it("truncated notice shows plain prose when envelope is truncated", async () => {
    setupDefaults({
      diff: {
        files: baseDiff.files,
        truncated: true,
      },
    });
    await renderReviewPage();
    expect(screen.getByTestId("truncated-notice")).toBeInTheDocument();
    expect(screen.getByTestId("truncated-notice")).toHaveTextContent(
      "Some files were too large to display."
    );
  });

  it("renders one diff-file item per file in CodeView", async () => {
    setupDefaults({
      diff: {
        files: [
          {
            path: "src/foo.rs",
            verb: "M",
            binary: false,
            oldContent: "old\n",
            newContent: "new\n",
            truncated: false,
          },
          {
            path: "src/bar.rs",
            verb: "A",
            binary: false,
            oldContent: "",
            newContent: "new\n",
            truncated: false,
          },
        ],
        truncated: false,
      },
    });
    await renderReviewPage();
    const diffItems = screen.getAllByTestId("diff-file");
    expect(diffItems).toHaveLength(2);
    expect(diffItems[0]).toHaveTextContent("src/foo.rs");
    expect(diffItems[1]).toHaveTextContent("src/bar.rs");
  });

  it("split/unified toggle switches diffStyle and persists to localStorage", async () => {
    setupDefaults();
    await renderReviewPage();
    // Default is split
    const codeView = screen.getByTestId("code-view");
    expect(codeView).toHaveAttribute("data-diff-style", "split");

    // Click Unified
    const unifiedBtn = screen.getByRole("button", { name: /unified/i });
    await act(async () => {
      unifiedBtn.click();
    });
    expect(screen.getByTestId("code-view")).toHaveAttribute("data-diff-style", "unified");
    expect(localStorage.getItem("freehold-diff-view")).toBe("unified");

    // Click Split
    const splitBtn = screen.getByRole("button", { name: /split/i });
    await act(async () => {
      splitBtn.click();
    });
    expect(screen.getByTestId("code-view")).toHaveAttribute("data-diff-style", "split");
    expect(localStorage.getItem("freehold-diff-view")).toBe("split");
  });

  it("per-file truncated renders 'File too large to display.'", async () => {
    setupDefaults({
      diff: {
        files: [
          {
            path: "big.rs",
            verb: "M",
            binary: false,
            oldContent: "",
            newContent: "",
            truncated: true,
          },
        ],
        truncated: false,
      },
    });
    await renderReviewPage();
    expect(screen.getByText("File too large to display.")).toBeInTheDocument();
  });

  it("tree row click triggers CodeView scroll", async () => {
    setupDefaults();
    await renderReviewPage();
    const treeRow = screen.getByTestId("tree-row");
    await act(async () => {
      treeRow.click();
    });
    expect(mockCodeViewScrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ type: "item", id: "src/lib.rs" })
    );
  });
});
