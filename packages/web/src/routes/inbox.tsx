import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { GitProposalCard } from "~/components/GitProposalCard";
import { ProposalCard } from "~/components/ProposalCard";
import { apiClient } from "~/lib/api";
import {
  keyFor,
  useActiveGraph,
  useActiveGraphPrincipal,
  useGitProposals,
  useGraphs,
  usePending,
} from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/inbox",
  component: InboxPage,
});

/**
 * A bundle is all commits on a single branch ref.
 * A bundle is fully decided when every commit in the bundle is decided (not "undecided").
 */
function isBundleDecided(proposals: { decided: string }[]): boolean {
  return proposals.length > 0 && proposals.every((p) => p.decided !== "undecided");
}

function InboxPage() {
  const { data, isLoading } = usePending();
  const qc = useQueryClient();
  const proposals = data?.proposals ?? [];

  const { graphs } = useGraphs();
  const { activeGraphId } = useActiveGraph();
  const activeGraph = graphs.find((g) => g.id === activeGraphId) ?? null;
  const isRepoGraph = activeGraph?.kind === "repo";

  const { data: gitData, isLoading: gitLoading } = useGitProposals(isRepoGraph);
  const gitProposals = gitData?.proposals ?? [];

  const by = useActiveGraphPrincipal();

  // Decided-proposals filter state
  const [showDecided, setShowDecided] = useState(false);

  // Group git proposals by ref to determine bundle decided-ness.
  // A bundle (all commits on one branch) is hidden when every commit in it is decided.
  const proposalsByRef = new Map<string, typeof gitProposals>();
  for (const p of gitProposals) {
    const group = proposalsByRef.get(p.ref) ?? [];
    group.push(p);
    proposalsByRef.set(p.ref, group);
  }

  const visibleGitProposals = showDecided
    ? gitProposals
    : gitProposals.filter((p) => {
        const bundle = proposalsByRef.get(p.ref) ?? [p];
        return !isBundleDecided(bundle);
      });

  const decidedBundleCount = [...proposalsByRef.values()].filter(isBundleDecided).length;

  const approveMut = useMutation({
    mutationFn: (hash: string) => apiClient.approve(hash),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "proposals") });
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "recall") });
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "schema") });
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "verify") });
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "policy") });
    },
  });

  const rejectMut = useMutation({
    mutationFn: (hash: string) => apiClient.reject(hash),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "proposals") });
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "recall") });
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "schema") });
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "verify") });
      qc.invalidateQueries({ queryKey: keyFor(activeGraphId, "policy") });
    },
  });

  const totalCount = proposals.length + (isRepoGraph ? visibleGitProposals.length : 0);

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 3,
            background: "var(--color-accent)",
          }}
          aria-hidden
        />
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
          PENDING PROPOSALS
        </span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight mb-6">
        Inbox{totalCount > 0 ? ` (${totalCount})` : ""}
      </h2>

      {isRepoGraph && (
        <section className="mb-8" aria-label="Commits">
          <div className="flex items-center gap-1.5 mb-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
              Commits
            </span>
            {visibleGitProposals.length > 0 && (
              <span className="font-mono text-[11px] text-(--fg-muted)">
                ({visibleGitProposals.length})
              </span>
            )}
          </div>

          {gitLoading && <p className="text-(--fg-muted) text-sm">Loading commits…</p>}

          {!gitLoading && visibleGitProposals.length === 0 && decidedBundleCount === 0 && (
            <p className="text-sm text-(--fg-muted)">
              No commit proposals. Branch heads are listed here when there are unresolved governance
              requirements.
            </p>
          )}

          {!gitLoading && visibleGitProposals.length === 0 && decidedBundleCount > 0 && (
            <p className="text-sm text-(--fg-muted)">No open commit proposals.</p>
          )}

          {!gitLoading && visibleGitProposals.length > 0 && (
            <ul className="space-y-4 max-w-2xl">
              {visibleGitProposals.map((proposal, index) => {
                const bundle = proposalsByRef.get(proposal.ref) ?? [proposal];
                return (
                  <li key={proposal.sha} className={`reveal reveal-${(index % 6) + 1}`}>
                    <GitProposalCard
                      proposal={proposal}
                      by={by}
                      bundleSize={bundle.length}
                      bundleIndex={bundle.indexOf(proposal)}
                    />
                  </li>
                );
              })}
            </ul>
          )}

          {!gitLoading && decidedBundleCount > 0 && (
            <div className="mt-4 flex items-center gap-2" data-testid="decided-hidden-line">
              <span className="text-xs text-(--fg-muted) font-mono">
                {decidedBundleCount} decided {decidedBundleCount === 1 ? "branch" : "branches"}{" "}
                hidden
              </span>
              <button
                type="button"
                data-testid="toggle-decided"
                onClick={() => setShowDecided((v) => !v)}
                className="text-xs font-mono text-(--fg-muted) underline underline-offset-2 hover:text-(--fg)"
              >
                {showDecided ? "hide" : "show"}
              </button>
            </div>
          )}
        </section>
      )}

      {isLoading && <p className="text-(--fg-muted) text-sm">Loading proposals…</p>}

      {!isLoading && proposals.length === 0 && !isRepoGraph && (
        <div className="border border-(--border) bg-(--bg-subtle) p-6 space-y-3 max-w-xl">
          <p className="text-sm text-(--fg-muted)">
            No pending proposals. When agents make governed writes — creating entities, proposing
            schema changes — they appear here for your approval.
          </p>
          <p className="text-sm text-(--fg-muted)">
            Get started with{" "}
            <code className="border border-(--border) bg-(--bg-subtle) px-1 py-0.5 font-mono text-[11px]">
              freehold mcp setup claude-code
            </code>
          </p>
        </div>
      )}

      {!isLoading && proposals.length === 0 && isRepoGraph && (
        <div className="border border-(--border) bg-(--bg-subtle) p-4">
          <p className="text-sm text-(--fg-muted)">No pending native proposals.</p>
        </div>
      )}

      {!isLoading && proposals.length > 0 && (
        <ul className="space-y-4 max-w-2xl">
          {proposals.map((proposal, index) => (
            <li key={proposal.hash} className={`reveal reveal-${(index % 6) + 1}`}>
              <ProposalCard
                proposal={proposal}
                onApprove={() => approveMut.mutate(proposal.hash)}
                onReject={() => rejectMut.mutate(proposal.hash)}
                isApproving={approveMut.isPending && approveMut.variables === proposal.hash}
                isRejecting={rejectMut.isPending && rejectMut.variables === proposal.hash}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
