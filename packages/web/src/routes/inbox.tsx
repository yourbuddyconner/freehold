import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { ProposalCard } from "~/components/ProposalCard";
import { apiClient } from "~/lib/api";
import { usePending } from "~/lib/hooks";
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

  const approveMut = useMutation({
    mutationFn: (hash: string) => apiClient.approve(hash),
    onSuccess: () => {
      // Invalidate all query keys that may change after an approval:
      // proposals list, recall results (newly admitted content), schema (schema proposals),
      // verify report, and policy (policy proposals)
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
        Inbox{proposals.length > 0 ? ` (${proposals.length})` : ""}
      </h2>

      {isLoading && <p className="text-(--fg-muted) text-sm">Loading proposals…</p>}

      {!isLoading && proposals.length === 0 && (
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
