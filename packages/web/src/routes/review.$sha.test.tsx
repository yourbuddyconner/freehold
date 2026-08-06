/**
 * Tests for /review/$sha — full-page commit review.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import React from "react";
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
  useReviewsForSha: vi.fn(),
  useListGraphs: vi.fn(),
  useActiveGraphPrincipal: vi.fn().mockReturnValue("alice"),
  // AppShell uses these:
  usePending: vi.fn().mockReturnValue({ data: { proposals: [] }, isLoading: false }),
  useGitProposals: vi.fn().mockReturnValue({ data: { proposals: [] }, isLoading: false }),
}));

// Mock api (needed by ReviewComposer and the review page submit flow)
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
    listGitReviews: vi.fn().mockResolvedValue({ reviews: [] }),
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

// Stub CodeView from @pierre/diffs/react — renders one pre per item keyed by id,
// and supports renderAnnotation to surface annotation content in tests.
// No ref needed: scrolling is now done via scrollIntoView on per-file wrapper divs.
let mockOnSelectedLinesChange:
  | ((
      sel: {
        id: string;
        range: { start: number; end: number; side?: string };
      } | null
    ) => void)
  | undefined;
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({
    items,
    options,
    renderAnnotation,
    onSelectedLinesChange,
  }: {
    items: Array<{
      id: string;
      type: string;
      annotations?: Array<{
        side: string;
        lineNumber: number;
        metadata: Record<string, unknown>;
      }>;
    }>;
    options?: { diffStyle?: string };
    renderAnnotation?: (
      ann: { side: string; lineNumber: number; metadata: Record<string, unknown> },
      item: { id: string }
    ) => React.ReactNode;
    onSelectedLinesChange?: (
      sel: {
        id: string;
        range: { start: number; end: number; side?: string };
      } | null
    ) => void;
  }) => {
    mockOnSelectedLinesChange = onSelectedLinesChange;
    return (
      <div data-testid="code-view" data-diff-style={options?.diffStyle ?? "split"}>
        {(items ?? []).map((i) => (
          <div key={i.id}>
            <pre data-testid="diff-file">{i.id}</pre>
            {i.annotations?.map((ann, idx) =>
              renderAnnotation ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: test mock
                <React.Fragment key={idx}>
                  {renderAnnotation(ann as never, i as never)}
                </React.Fragment>
              ) : (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: test mock
                  key={idx}
                  data-testid="annotation"
                  data-path={i.id}
                  data-span={ann.metadata?.span}
                  data-status={ann.metadata?.status}
                  data-author={ann.metadata?.author}
                >
                  {String(ann.metadata?.body ?? "")}
                </div>
              )
            )}
          </div>
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
    reviews?: { reviews: unknown[] };
    graphs?: { graphs: unknown[] };
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

  vi.mocked(hooks.useReviewsForSha).mockReturnValue({
    data: overrides.reviews ?? { reviews: [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useReviewsForSha>);

  vi.mocked(hooks.useListGraphs).mockReturnValue({
    data: overrides.graphs ?? {
      graphs: [{ id: "repo-1", name: "my-repo", path: "/repos/my-repo", kind: "repo" }],
    },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useListGraphs>);
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
    expect(screen.getByRole("button", { name: /request changes/i })).toBeDisabled();
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

  it("tree row click scrolls to the file wrapper via scrollIntoView", async () => {
    // Spy on Element.prototype.scrollIntoView — happy-dom supports this
    const scrollIntoViewSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    // Also stub window.scrollBy so the header-offset call is a no-op
    const scrollBySpy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});

    setupDefaults();
    await renderReviewPage();

    const treeRow = screen.getByTestId("tree-row");
    await act(async () => {
      treeRow.click();
    });

    // scrollIntoView should have been called with block: "start"
    expect(scrollIntoViewSpy).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
    // The wrapper div for src/lib.rs should exist in the DOM
    const wrapperEl = document.querySelector('[data-path="src/lib.rs"]');
    expect(wrapperEl).not.toBeNull();

    scrollIntoViewSpy.mockRestore();
    scrollBySpy.mockRestore();
  });

  it("tree row click for binary file scrolls via scrollIntoView on id-based caption", async () => {
    const scrollIntoViewSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    const scrollBySpy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});

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

    const treeRow = screen.getByTestId("tree-row");
    await act(async () => {
      treeRow.click();
    });

    expect(scrollIntoViewSpy).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
    const captionEl = document.getElementById("image.png");
    expect(captionEl).not.toBeNull();

    scrollIntoViewSpy.mockRestore();
    scrollBySpy.mockRestore();
  });

  // ---- New tests: saved review comments as annotations ----

  it("saved review comments render as annotations on the correct file", async () => {
    setupDefaults({
      reviews: {
        reviews: [
          {
            reviewId: "rv-1",
            verdict: "approve",
            commit: `git:my-repo#${SHA}`,
            author: "bob",
            status: "saved",
            comments: [
              {
                commentId: "c-1",
                body: "looks good",
                anchor: `git:my-repo#${SHA}:src/lib.rs`,
                span: "L5",
                status: "saved",
              },
            ],
          },
        ],
      },
    });
    await renderReviewPage();
    const annotation = screen.getByTestId("annotation");
    expect(annotation).toHaveAttribute("data-path", "src/lib.rs");
    expect(annotation).toHaveAttribute("data-span", "L5");
    expect(annotation).toHaveAttribute("data-status", "saved");
    expect(annotation).toHaveAttribute("data-author", "bob");
    expect(annotation).toHaveTextContent("looks good");
  });

  it("saved comment with external_source shows 'via github'", async () => {
    setupDefaults({
      reviews: {
        reviews: [
          {
            reviewId: "rv-2",
            verdict: "request-changes",
            commit: `git:my-repo#${SHA}`,
            author: "external-bot",
            status: "saved",
            comments: [
              {
                commentId: "c-2",
                body: "style fix needed",
                anchor: `git:my-repo#${SHA}:src/lib.rs`,
                span: "L10",
                status: "saved",
                external_source: "github",
              },
            ],
          },
        ],
      },
    });
    await renderReviewPage();
    expect(screen.getByText("via github")).toBeInTheDocument();
  });

  it("pre-populated drafts render as pending annotations", async () => {
    // Pre-populate localStorage with a draft before render
    localStore.set(
      `freehold:review-drafts:${SHA}`,
      JSON.stringify([{ path: "src/lib.rs", span: "L5", body: "my draft comment" }])
    );
    setupDefaults();
    await renderReviewPage();
    const annotation = screen.getByTestId("annotation");
    expect(annotation).toHaveAttribute("data-path", "src/lib.rs");
    expect(annotation).toHaveAttribute("data-span", "L5");
    expect(annotation).toHaveAttribute("data-status", "pending");
    expect(annotation).toHaveTextContent("my draft comment");
  });

  it("decision panel shows N comments pending when drafts exist", async () => {
    localStore.set(
      `freehold:review-drafts:${SHA}`,
      JSON.stringify([
        { path: "src/lib.rs", span: "L5", body: "first comment" },
        { path: "src/lib.rs", span: "L10", body: "second comment" },
      ])
    );
    setupDefaults();
    await renderReviewPage();
    expect(screen.getByTestId("pending-count")).toHaveTextContent("2 comments pending");
  });

  it("submit with drafts calls postGitReview then decide then clears drafts", async () => {
    localStore.set(
      `freehold:review-drafts:${SHA}`,
      JSON.stringify([{ path: "src/lib.rs", span: "L5", body: "test comment" }])
    );
    const mutate = vi.fn();
    setupDefaults({
      decide: {
        decideMut: { mutate, isPending: false, variables: undefined } as never,
      },
    });
    await renderReviewPage();

    // Import apiClient from the mock
    const { apiClient } = await import("~/lib/api");

    // Click Approve trigger
    const approveBtn = screen.getByRole("button", { name: /^approve$/i });
    await act(async () => {
      approveBtn.click();
    });
    // Click confirm in dialog
    const confirmBtn = screen
      .getAllByRole("button", { name: /^approve$/i })
      .find((b) => b.closest("[role=dialog]"));
    await act(async () => {
      confirmBtn?.click();
    });

    await waitFor(() => {
      expect(apiClient.postGitReview).toHaveBeenCalledWith(
        SHA,
        expect.objectContaining({
          verdict: "approve-with-comments",
          by: "alice",
          comments: [
            expect.objectContaining({
              body: "test comment",
              anchor: expect.stringContaining("src/lib.rs"),
              span: "L5",
            }),
          ],
        })
      );
    });
    expect(mutate).toHaveBeenCalledWith("approve");
    // Drafts should be cleared from localStorage
    expect(localStore.get(`freehold:review-drafts:${SHA}`)).toBeUndefined();
  });

  it("reject maps to request-changes in postGitReview", async () => {
    localStore.set(
      `freehold:review-drafts:${SHA}`,
      JSON.stringify([{ path: "src/lib.rs", span: "L5", body: "needs work" }])
    );
    const mutate = vi.fn();
    setupDefaults({
      decide: {
        decideMut: { mutate, isPending: false, variables: undefined } as never,
      },
    });
    await renderReviewPage();

    const { apiClient } = await import("~/lib/api");

    const rejectBtn = screen.getByRole("button", { name: /^request changes$/i });
    await act(async () => {
      rejectBtn.click();
    });

    await waitFor(() => {
      expect(apiClient.postGitReview).toHaveBeenCalledWith(
        SHA,
        expect.objectContaining({ verdict: "request-changes" })
      );
    });
    expect(mutate).toHaveBeenCalledWith("reject");
  });

  it("zero drafts: approve calls only decide, not postGitReview", async () => {
    // No drafts in localStorage
    const mutate = vi.fn();
    setupDefaults({
      decide: {
        decideMut: { mutate, isPending: false, variables: undefined } as never,
      },
    });
    await renderReviewPage();

    const { apiClient } = await import("~/lib/api");

    const approveBtn = screen.getByRole("button", { name: /^approve$/i });
    await act(async () => {
      approveBtn.click();
    });
    const confirmBtn = screen
      .getAllByRole("button", { name: /^approve$/i })
      .find((b) => b.closest("[role=dialog]"));
    await act(async () => {
      confirmBtn?.click();
    });

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith("approve");
    });
    expect(apiClient.postGitReview).not.toHaveBeenCalled();
  });

  it("postGitReview failure surfaces error and does not call decide", async () => {
    localStore.set(
      `freehold:review-drafts:${SHA}`,
      JSON.stringify([{ path: "src/lib.rs", span: "L5", body: "failing draft" }])
    );
    const mutate = vi.fn();
    setupDefaults({
      decide: {
        decideMut: { mutate, isPending: false, variables: undefined } as never,
      },
    });

    const { apiClient } = await import("~/lib/api");
    vi.mocked(apiClient.postGitReview).mockRejectedValueOnce(new Error("server error"));

    await renderReviewPage();

    const approveBtn = screen.getByRole("button", { name: /^approve$/i });
    await act(async () => {
      approveBtn.click();
    });
    const confirmBtn = screen
      .getAllByRole("button", { name: /^approve$/i })
      .find((b) => b.closest("[role=dialog]"));
    await act(async () => {
      confirmBtn?.click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("review-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("review-error")).toHaveTextContent("server error");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("opens composer when a line range is selected", async () => {
    setupDefaults();
    await renderReviewPage();

    // Fire the selection callback captured from the CodeView mock
    await act(async () => {
      mockOnSelectedLinesChange?.({
        id: "src/lib.rs",
        range: { start: 10, end: 15, side: "additions" },
      });
    });

    // The composer should now be visible with the correct path and span
    expect(screen.getByTestId("line-composer")).toBeInTheDocument();
    expect(screen.getByTestId("line-composer")).toHaveTextContent("src/lib.rs");
    expect(screen.getByTestId("line-composer")).toHaveTextContent("L10-L15");
  });

  it("diff fetch failure renders diff-error notice", async () => {
    const diffErr = new Error("network timeout");
    vi.mocked(hooks.useGitProposalDiff).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: diffErr,
    } as unknown as ReturnType<typeof hooks.useGitProposalDiff>);
    vi.mocked(hooks.useGitProposal).mockReturnValue({
      data: baseProposal as never,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useGitProposal>);
    vi.mocked(hooks.useSession).mockReturnValue({
      data: {
        owner: "alice",
        defaultAgent: "claude",
        port: 8710,
        graphs: [],
        defaultGraph: "main",
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useSession>);
    vi.mocked(hooks.useGraphs).mockReturnValue({
      graphs: [{ id: "repo-1", name: "my-repo", kind: "repo" as "repo" | "memory" }],
      defaultGraph: "repo-1",
    });
    vi.mocked(hooks.useActiveGraph).mockReturnValue({
      activeGraphId: "repo-1",
      setActiveGraphId: vi.fn(),
    });
    vi.mocked(hooks.useDecideProposal).mockReturnValue(
      defaultDecideMock as unknown as ReturnType<typeof hooks.useDecideProposal>
    );
    vi.mocked(hooks.useReviewsForSha).mockReturnValue({
      data: { reviews: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useReviewsForSha>);
    vi.mocked(hooks.useListGraphs).mockReturnValue({
      data: { graphs: [{ id: "repo-1", name: "my-repo", path: "/repos/my-repo", kind: "repo" }] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useListGraphs>);

    await renderReviewPage();
    expect(screen.getByTestId("diff-error")).toBeInTheDocument();
    expect(screen.getByTestId("diff-error")).toHaveTextContent("Could not load diff.");
    expect(screen.getByTestId("diff-error")).toHaveTextContent("network timeout");
  });

  it("reviews fetch failure shows reviews-error notice but still renders diff files", async () => {
    const reviewsErr = new Error("fetch failed");
    vi.mocked(hooks.useGitProposal).mockReturnValue({
      data: baseProposal as never,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useGitProposal>);
    vi.mocked(hooks.useGitProposalDiff).mockReturnValue({
      data: baseDiff as never,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useGitProposalDiff>);
    vi.mocked(hooks.useSession).mockReturnValue({
      data: {
        owner: "alice",
        defaultAgent: "claude",
        port: 8710,
        graphs: [],
        defaultGraph: "main",
      },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useSession>);
    vi.mocked(hooks.useGraphs).mockReturnValue({
      graphs: [{ id: "repo-1", name: "my-repo", kind: "repo" as "repo" | "memory" }],
      defaultGraph: "repo-1",
    });
    vi.mocked(hooks.useActiveGraph).mockReturnValue({
      activeGraphId: "repo-1",
      setActiveGraphId: vi.fn(),
    });
    vi.mocked(hooks.useDecideProposal).mockReturnValue(
      defaultDecideMock as unknown as ReturnType<typeof hooks.useDecideProposal>
    );
    vi.mocked(hooks.useReviewsForSha).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: reviewsErr,
    } as unknown as ReturnType<typeof hooks.useReviewsForSha>);
    vi.mocked(hooks.useListGraphs).mockReturnValue({
      data: { graphs: [{ id: "repo-1", name: "my-repo", path: "/repos/my-repo", kind: "repo" }] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useListGraphs>);

    await renderReviewPage();
    expect(screen.getByTestId("reviews-error")).toBeInTheDocument();
    expect(screen.getByTestId("reviews-error")).toHaveTextContent(
      "Could not load review comments."
    );
    // Diff files still render
    expect(screen.getByTestId("diff-file")).toBeInTheDocument();
    expect(screen.getByTestId("diff-file")).toHaveTextContent("src/lib.rs");
  });

  it("Save-draft persists to localStorage after line selection", async () => {
    setupDefaults();
    await renderReviewPage();

    // Open composer via selection callback
    await act(async () => {
      mockOnSelectedLinesChange?.({
        id: "src/lib.rs",
        range: { start: 7, end: 7, side: "deletions" },
      });
    });

    // Fill in the comment body
    const textarea = screen.getByRole("textbox", { name: /comment body/i });
    await act(async () => {
      textarea.focus();
      // Use fireEvent-style property assignment since userEvent is not imported
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "draft text"
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      (textarea as HTMLTextAreaElement).value = "draft text";
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Click Save draft
    const saveDraftBtn = screen.getByRole("button", { name: /save draft/i });
    await act(async () => {
      saveDraftBtn.click();
    });

    // Assert localStorage has a draft entry for the path+span
    const raw = localStore.get(`freehold:review-drafts:${SHA}`);
    expect(raw).toBeDefined();
    const drafts = JSON.parse(raw as string);
    expect(drafts).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/lib.rs", span: "old:L7" })])
    );
  });
});
