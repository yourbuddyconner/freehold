/**
 * Tests for GitProposalCard review composer — segmented verdict control and
 * button visibility when composer is open/closed.
 */
import type { GitProposal } from "@freehold/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
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
      <a
        className={className as string}
        {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
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

describe("GitProposalCard — composer open/closed visibility", () => {
  it("shows Approve and Reject buttons when composer is closed", () => {
    renderCard(makeProposal());
    // Approve button is visible (not hidden)
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  it("hides Approve and Reject buttons when composer is open", () => {
    renderCard(makeProposal());
    // Open the composer
    fireEvent.click(screen.getByRole("button", { name: /write review/i }));
    // Decision buttons should be hidden (aria-hidden or not rendered or hidden class).
    // The verdict segmented control also has an "Approve" button (aria-pressed="true"),
    // so we use { hidden: true } to find the decision-row Approve (no aria-pressed) in the
    // aria-hidden subtree, then verify it is not visible.
    const decisionApprove = screen
      .queryAllByRole("button", { name: /^approve$/i, hidden: true })
      .find((b) => !b.hasAttribute("aria-pressed"));
    expect(decisionApprove).not.toBeVisible();
    expect(screen.queryByRole("button", { name: /^reject$/i, hidden: true })).not.toBeVisible();
  });

  it("restores Approve and Reject buttons when composer is cancelled", () => {
    renderCard(makeProposal());
    fireEvent.click(screen.getByRole("button", { name: /write review/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByRole("button", { name: /approve/i })).toBeVisible();
  });
});

describe("GitProposalCard — segmented verdict control", () => {
  it("renders segmented verdict buttons (Approve, Approve with comments, Request changes) when composer is open", () => {
    renderCard(makeProposal());
    fireEvent.click(screen.getByRole("button", { name: /write review/i }));

    expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve with comments/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request changes/i })).toBeInTheDocument();
  });

  it("does not render a select element for verdict", () => {
    renderCard(makeProposal());
    fireEvent.click(screen.getByRole("button", { name: /write review/i }));
    expect(screen.queryByRole("combobox", { name: /verdict/i })).not.toBeInTheDocument();
  });

  it("Approve is selected by default (active styling)", () => {
    renderCard(makeProposal());
    fireEvent.click(screen.getByRole("button", { name: /write review/i }));
    const approveBtn = screen.getByRole("button", { name: /^approve$/i });
    expect(approveBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking Request changes changes active button", () => {
    renderCard(makeProposal());
    fireEvent.click(screen.getByRole("button", { name: /write review/i }));
    fireEvent.click(screen.getByRole("button", { name: /request changes/i }));
    expect(screen.getByRole("button", { name: /request changes/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: /^approve$/i })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });
});

describe("GitProposalCard — composer layout", () => {
  it("renders SUBMIT REVIEW and CANCEL buttons in the composer", () => {
    renderCard(makeProposal());
    fireEvent.click(screen.getByRole("button", { name: /write review/i }));
    expect(screen.getByRole("button", { name: /submit review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("renders Add path comment as a button", () => {
    renderCard(makeProposal());
    fireEvent.click(screen.getByRole("button", { name: /write review/i }));
    expect(screen.getByRole("button", { name: /add path comment/i })).toBeInTheDocument();
  });
});
