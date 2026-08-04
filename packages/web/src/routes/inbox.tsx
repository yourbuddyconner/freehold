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
      <h2 className="font-serif text-2xl font-semibold mb-6">
        Inbox{proposals.length > 0 ? ` (${proposals.length})` : ""}
      </h2>

      {isLoading && <p className="text-[--fg-muted] text-sm">Loading proposals…</p>}

      {!isLoading && proposals.length === 0 && (
        <div className="rounded-lg border border-[--border] bg-[--bg-subtle] p-6 space-y-3 max-w-xl">
          <p className="text-sm text-[--fg-muted]">
            No pending proposals. When agents make governed writes — creating entities, proposing
            schema changes — they appear here for your approval.
          </p>
          <p className="text-sm text-[--fg-muted]">
            Get started with{" "}
            <code className="font-mono text-xs bg-neutral-100 dark:bg-neutral-800 rounded px-1 py-0.5">
              freehold mcp setup claude-code
            </code>
          </p>
        </div>
      )}

      {!isLoading && proposals.length > 0 && (
        <ul className="space-y-4 max-w-2xl">
          {proposals.map((proposal) => (
            <li key={proposal.hash}>
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
