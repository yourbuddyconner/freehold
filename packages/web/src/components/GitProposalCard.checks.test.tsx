/**
 * Tests for the CI checks section in GitProposalCard.
 *
 * Verifies that:
 * - A proposal with a non-empty checks array renders the checks-section
 * - A proposal with an empty or absent checks array does NOT render the checks section
 */

import type { GitProposal } from "@freehold/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitProposalCard } from "./GitProposalCard";

// Mock hooks used by GitProposalCard
vi.mock("~/lib/hooks", () => ({
  useSession: vi.fn().mockReturnValue({ data: null }),
}));

// Mock api client to avoid module-level side effects
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

describe("GitProposalCard — checks section", () => {
  it("renders checks-section when proposal has checks", () => {
    const proposal = makeProposal({
      checks: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "lint", status: "completed", conclusion: "failure" },
      ],
    });
    renderCard(proposal);

    expect(screen.getByTestId("checks-section")).toBeInTheDocument();
    const rows = screen.getAllByTestId("check-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
    expect(screen.getByText("success")).toBeInTheDocument();
    expect(screen.getByText("failure")).toBeInTheDocument();
  });

  it("renders in_progress status text when conclusion is absent", () => {
    const proposal = makeProposal({
      checks: [{ name: "test", status: "in_progress" }],
    });
    renderCard(proposal);

    expect(screen.getByTestId("checks-section")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("in_progress")).toBeInTheDocument();
  });

  it("does NOT render checks-section when checks is empty", () => {
    const proposal = makeProposal({ checks: [] });
    renderCard(proposal);
    expect(screen.queryByTestId("checks-section")).not.toBeInTheDocument();
  });

  it("does NOT render checks-section when checks is absent", () => {
    const proposal = makeProposal({ checks: undefined });
    renderCard(proposal);
    expect(screen.queryByTestId("checks-section")).not.toBeInTheDocument();
  });

  it("governance check is highlighted first with governance-check-row testid", () => {
    const proposal = makeProposal({
      checks: [
        { name: "ci/build", status: "completed", conclusion: "success" },
        { name: "governance", status: "completed", conclusion: "success" },
      ],
    });
    renderCard(proposal);

    const govRow = screen.getByTestId("governance-check-row");
    expect(govRow).toBeInTheDocument();

    // The governance badge (distinct from the check name) appears inside the governance row
    const { getByText: getByTextInRow, getAllByText: getAllByTextInRow } = within(govRow);
    const governanceMatches = getAllByTextInRow("governance");
    expect(governanceMatches).toHaveLength(2); // check name span + badge
    // Verify the badge exists specifically
    const badge = govRow.querySelector("span.inline-flex.border.border-purple-400");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("governance");

    // Governance row appears before other check-rows in the DOM
    const checksSection = screen.getByTestId("checks-section");
    const allRows = checksSection.querySelectorAll(
      "[data-testid='governance-check-row'], [data-testid='check-row']"
    );
    expect(allRows[0]).toHaveAttribute("data-testid", "governance-check-row");
  });
});
