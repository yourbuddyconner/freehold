/**
 * Tests for carry-forward chip and approve button relabel in GitProposalCard.
 */

import type { GitProposal } from "@freehold/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitProposalCard } from "./GitProposalCard";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      className,
      ...rest
    }: React.HTMLAttributes<HTMLAnchorElement> & { to?: string; params?: unknown }) => (
      <a className={className as string} {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    ),
  };
});

import type React from "react";

vi.mock("~/lib/hooks", () => ({
  useSession: vi.fn().mockReturnValue({ data: null }),
  useActiveGraph: vi.fn().mockReturnValue({ activeGraphId: "main", setActiveGraphId: vi.fn() }),
  keyFor: (graphId: string, ...parts: unknown[]) => ["graph", graphId, ...parts],
  useDecideProposal: vi.fn().mockReturnValue({
    decideMut: { mutate: vi.fn(), isPending: false, variables: undefined },
    decideOutcome: null,
    keyMissingReason: null,
    savedLocally: false,
    pushSkippedNotice: false,
    retrying: false,
    handleRetry: vi.fn(),
  }),
}));

vi.mock("~/lib/api", () => ({
  GRAPH_STORAGE_KEY: "freehold-graph",
  setActiveGraph: vi.fn(),
  apiClient: {
    decideGitProposal: vi.fn(),
    pushGitNotes: vi.fn(),
    postGitReview: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    code?: string;
  },
}));

function makeProposal(overrides: Partial<GitProposal> = {}): GitProposal {
  return {
    sha: "abc1234567890000000000000000000000000000",
    ref: "refs/heads/main",
    author: "test-author",
    timestamp: "2026-01-01T00:00:00Z",
    message: "test commit",
    target: "refs/heads/main",
    matched: [],
    checklist: [],
    unmet: [],
    decided: "undecided",
    paths: [],
    checks: [],
    ...overrides,
  };
}

function renderCard(proposal: GitProposal) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GitProposalCard proposal={proposal} by="owner" />
    </QueryClientProvider>
  );
}

describe("GitProposalCard — carry-forward chip", () => {
  it("renders carry-forward chip when priorDecision is present with approve verdict", () => {
    const proposal = makeProposal({
      priorDecision: { sha: "def5678901234567890123456789012345678901", verdict: "approve" },
    });
    renderCard(proposal);
    const chip = screen.getByTestId("prior-decision-chip");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("same content approved as def5678");
  });

  it("renders carry-forward chip with 'rejected' text when prior verdict is reject", () => {
    const proposal = makeProposal({
      priorDecision: { sha: "fed1234567890123456789012345678901234567", verdict: "reject" },
    });
    renderCard(proposal);
    const chip = screen.getByTestId("prior-decision-chip");
    expect(chip).toHaveTextContent("same content rejected as fed1234");
  });

  it("does NOT render chip when priorDecision is absent", () => {
    const proposal = makeProposal();
    renderCard(proposal);
    expect(screen.queryByTestId("prior-decision-chip")).not.toBeInTheDocument();
  });

  it("relabels approve button to 'Approve again' when prior verdict is approve", () => {
    const proposal = makeProposal({
      priorDecision: { sha: "def5678901234567890123456789012345678901", verdict: "approve" },
    });
    renderCard(proposal);
    // The trigger button (visible before dialog opens) should say "Approve again"
    const approveBtn = screen.getByRole("button", { name: /approve again/i });
    expect(approveBtn).toBeInTheDocument();
  });

  it("keeps approve button label 'Approve' when priorDecision absent", () => {
    const proposal = makeProposal();
    renderCard(proposal);
    const approveBtn = screen.getByRole("button", { name: /^approve$/i });
    expect(approveBtn).toBeInTheDocument();
  });

  it("keeps approve button label 'Approve' when prior verdict is reject", () => {
    const proposal = makeProposal({
      priorDecision: { sha: "fed1234567890123456789012345678901234567", verdict: "reject" },
    });
    renderCard(proposal);
    const approveBtn = screen.getByRole("button", { name: /^approve$/i });
    expect(approveBtn).toBeInTheDocument();
  });
});
