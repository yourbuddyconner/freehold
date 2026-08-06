/**
 * Tests for carry-forward chip and button relabel in the review page header.
 */

import type { GitProposal } from "@freehold/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewPage } from "./review.$sha";

// Mock Pierre components (shadow DOM, cannot render in happy-dom)
vi.mock("~/components/PierreDiff", () => ({
  PierreDiff: ({ name }: { name: string }) => (
    <pre data-testid="pierre-diff" data-name={name} />
  ),
}));
vi.mock("~/components/PierreTree", () => ({
  PierreTree: ({ paths }: { paths: string[] }) => (
    <div data-testid="pierre-tree">
      {paths.map((p) => (
        <button key={p} type="button">
          {p}
        </button>
      ))}
    </div>
  ),
}));

// Mock @pierre/diffs
vi.mock("@pierre/diffs", () => ({
  parseDiffFromFile: vi.fn(() => ({})),
}));
vi.mock("@pierre/diffs/edit", () => ({
  Editor: vi.fn(),
}));
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: unknown[] }) => (
    <pre data-testid="pierre-diff">{JSON.stringify(items)}</pre>
  ),
  EditProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  File: () => <div data-testid="pierre-file" />,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, createRoute: vi.fn(() => ({ useParams: vi.fn() })) };
});

import type React from "react";

const mockProposal = (overrides: Partial<GitProposal> = {}): GitProposal => ({
  sha: "abc1234567890000000000000000000000000000",
  ref: "refs/heads/feature",
  author: "test-author",
  timestamp: "2026-01-01T00:00:00Z",
  message: "test commit",
  target: "refs/heads/feature",
  matched: [],
  checklist: [],
  unmet: [],
  decided: "undecided",
  paths: [],
  checks: [],
  ...overrides,
});

vi.mock("~/lib/hooks", () => ({
  useSession: vi.fn().mockReturnValue({ data: null }),
  useActiveGraph: vi.fn().mockReturnValue({ activeGraphId: "g1", setActiveGraphId: vi.fn() }),
  useActiveGraphPrincipal: vi.fn().mockReturnValue("owner"),
  useGraphs: vi.fn().mockReturnValue({
    graphs: [{ id: "g1", kind: "repo", name: "testrepo" }],
  }),
  useListGraphs: vi.fn().mockReturnValue({
    data: { graphs: [{ id: "g1", path: "/repos/testrepo", name: "testrepo" }] },
  }),
  useGitProposal: vi.fn().mockReturnValue({ data: undefined, isLoading: false }),
  useGitProposalDiff: vi.fn().mockReturnValue({ data: undefined, isLoading: false, error: null }),
  useReviewsForSha: vi.fn().mockReturnValue({ data: { reviews: [] }, error: null }),
  useDecideProposal: vi.fn().mockReturnValue({
    decideMut: { mutate: vi.fn(), isPending: false, variables: undefined },
    decideOutcome: null,
    keyMissingReason: null,
    savedLocally: false,
    pushSkippedNotice: false,
    retrying: false,
    handleRetry: vi.fn(),
  }),
  keyFor: (graphId: string, ...parts: unknown[]) => ["graph", graphId, ...parts],
}));

vi.mock("~/lib/api", () => ({
  GRAPH_STORAGE_KEY: "freehold-graph",
  setActiveGraph: vi.fn(),
  apiClient: { decideGitProposal: vi.fn(), pushGitNotes: vi.fn(), postGitReview: vi.fn(), applyGitSuggestion: vi.fn() },
  ApiError: class ApiError extends Error { code?: string; },
}));

vi.mock("~/lib/reviewDrafts", () => ({
  loadDrafts: vi.fn(() => []),
  saveDrafts: vi.fn(),
  clearDrafts: vi.fn(),
  parseSuggestionBody: vi.fn((body: string) => ({ prose: body, suggestion: null })),
  serializeSuggestionBody: vi.fn((prose: string) => prose),
}));

import { useGitProposal } from "~/lib/hooks";

function renderReview(sha: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReviewPage sha={sha} />
    </QueryClientProvider>
  );
}

describe("ReviewPage — carry-forward chip", () => {
  it("renders chip in header when proposal has priorDecision with approve verdict", () => {
    const proposal = mockProposal({
      priorDecision: { sha: "def5678901234567890123456789012345678901", verdict: "approve" },
    });
    vi.mocked(useGitProposal).mockReturnValue({ data: proposal, isLoading: false } as ReturnType<typeof useGitProposal>);

    renderReview("abc1234567890000000000000000000000000000");
    const chip = screen.getByTestId("prior-decision-chip");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("same content approved as def5678");
  });

  it("relabels approve trigger button when prior verdict is approve", () => {
    const proposal = mockProposal({
      priorDecision: { sha: "def5678901234567890123456789012345678901", verdict: "approve" },
    });
    vi.mocked(useGitProposal).mockReturnValue({ data: proposal, isLoading: false } as ReturnType<typeof useGitProposal>);

    renderReview("abc1234567890000000000000000000000000000");
    const approveBtn = screen.getByRole("button", { name: /approve again/i });
    expect(approveBtn).toBeInTheDocument();
  });
});
