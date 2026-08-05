/**
 * Tests for /review/$sha — full-page commit review.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
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
  PierreDiff: () => <div data-testid="pierre-diff" />,
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
  files: [{ path: "src/lib.rs", verb: "M", patch: "@@ -1 +1 @@\n-old\n+new\n", binary: false }],
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

describe("/review/$sha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        files: [{ path: "image.png", verb: "A", patch: "", binary: true }],
        truncated: false,
      },
    });
    await renderReviewPage();
    expect(screen.getByText(/binary/i)).toBeInTheDocument();
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

  it("truncated notice shows when diff is truncated", async () => {
    setupDefaults({
      diff: {
        files: baseDiff.files,
        truncated: true,
      },
    });
    await renderReviewPage();
    expect(screen.getByTestId("truncated-notice")).toBeInTheDocument();
    expect(screen.getByTestId("truncated-notice")).toHaveTextContent(/truncated/i);
  });
});
