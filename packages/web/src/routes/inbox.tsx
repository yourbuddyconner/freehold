import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { GitProposalCard } from "~/components/GitProposalCard";
import { ProposalCard } from "~/components/ProposalCard";
import { apiClient } from "~/lib/api";
import { useActiveGraph, useGitProposals, useGraphs, usePending, useSession } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/inbox",
  component: InboxPage,
});

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

  const { data: sessionData } = useSession();
  const by = sessionData?.owner ?? "owner";

  const approveMut = useMutation({
    mutationFn: (hash: string) => apiClient.approve(hash),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
      qc.invalidateQueries({ queryKey: ["recall"] });
      qc.invalidateQueries({ queryKey: ["schema"] });
      qc.invalidateQueries({ queryKey: ["verify"] });
      qc.invalidateQueries({ queryKey: ["policy"] });
    },
  });

  const rejectMut = useMutation({
    mutationFn: (hash: string) => apiClient.reject(hash),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
      qc.invalidateQueries({ queryKey: ["recall"] });
      qc.invalidateQueries({ queryKey: ["schema"] });
      qc.invalidateQueries({ queryKey: ["verify"] });
      qc.invalidateQueries({ queryKey: ["policy"] });
    },
  });

  const totalCount = proposals.length + (isRepoGraph ? gitProposals.length : 0);

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
            {gitProposals.length > 0 && (
              <span className="font-mono text-[11px] text-(--fg-muted)">({gitProposals.length})</span>
            )}
          </div>

          {gitLoading && (
            <p className="text-(--fg-muted) text-sm">Loading commits…</p>
          )}

          {!gitLoading && gitProposals.length === 0 && (
            <p className="text-sm text-(--fg-muted)">No commit proposals. Branch heads are listed here when there are unresolved governance requirements.</p>
          )}

          {!gitLoading && gitProposals.length > 0 && (
            <ul className="space-y-4 max-w-2xl">
              {gitProposals.map((proposal, index) => (
                <li key={proposal.sha} className={`reveal reveal-${(index % 6) + 1}`}>
                  <GitProposalCard proposal={proposal} by={by} />
                </li>
              ))}
            </ul>
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
