/**
 * /review/:sha — full-page commit review.
 *
 * Shows commit metadata, per-file diffs, checklist, approve/reject controls,
 * and the review composer. Only available for repo graphs.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { createRoute } from "@tanstack/react-router";
import { ChecklistRow, DecidedChip, PathRow, ReviewComposer } from "~/components/GitProposalCard";
import { cn } from "~/lib/cn";
import {
  useActiveGraph,
  useDecideProposal,
  useGitProposal,
  useGitProposalDiff,
  useGraphs,
  useSession,
} from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/review/$sha",
  component: ReviewRoute,
});

function ReviewRoute() {
  const { sha } = Route.useParams();
  return <ReviewPage sha={sha} />;
}

// Exported for testing
export function ReviewPage({ sha }: { sha: string }) {
  const { data: proposal, isLoading } = useGitProposal(sha);
  const { graphs } = useGraphs();
  const { activeGraphId } = useActiveGraph();
  const activeGraph = graphs.find((g) => g.id === activeGraphId) ?? null;
  const isRepoGraph = activeGraph?.kind === "repo";

  const { data: diffData, isLoading: diffLoading } = useGitProposalDiff(sha, isRepoGraph);

  const { data: sessionData } = useSession();
  const by = sessionData?.owner ?? "owner";

  const {
    decideMut,
    decideOutcome,
    keyMissingReason,
    savedLocally,
    pushSkippedNotice,
    retrying,
    handleRetry,
  } = useDecideProposal(sha, by);

  if (!isRepoGraph) {
    return (
      <div className="p-6">
        <p className="text-sm text-(--fg-muted)" data-testid="repo-only-notice">
          Commit review is only available for a repo graph.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6">
        <p className="text-sm text-(--fg-muted)">Loading…</p>
      </div>
    );
  }

  if (!proposal) {
    return (
      <div className="p-6">
        <p className="text-sm text-(--fg-muted)">Proposal not found.</p>
      </div>
    );
  }

  const { message, author, timestamp, checklist, unmet, decided, paths, ref } = proposal;
  const shortSha = sha.slice(0, 7);

  const actionsDisabled = !!keyMissingReason || decided !== "undecided";

  let timeDisplay = timestamp;
  try {
    timeDisplay = new Date(timestamp).toLocaleDateString();
  } catch {
    // keep raw
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-semibold text-(--fg)">{shortSha}</span>
          <span className="text-xs text-(--fg-muted)">·</span>
          <span className="text-xs text-(--fg-muted)">{author}</span>
          <span className="text-xs text-(--fg-muted)">·</span>
          <span className="text-xs text-(--fg-muted)">{timeDisplay}</span>
          <span className="text-xs text-(--fg-muted)">on</span>
          <span className="font-mono text-[11px] text-(--fg-muted)">
            {ref.replace("refs/heads/", "")}
          </span>
          <DecidedChip decided={decided} />
        </div>
        <h1 className="text-xl font-semibold text-(--fg)">{message}</h1>
      </div>

      {/* Key-missing notice */}
      {keyMissingReason && (
        <div
          data-testid="key-missing-notice"
          className="border border-amber-300 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          Governance actions disabled: {keyMissingReason}
        </div>
      )}

      {/* Checklist */}
      {checklist.length > 0 && (
        <div className="space-y-1" data-testid="checklist">
          <div className="text-[10px] font-mono uppercase text-(--fg-muted) tracking-[0.08em]">
            Checklist
          </div>
          {checklist.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: checklist items are stable for a given sha
            <ChecklistRow key={i} item={item} unmet={unmet} />
          ))}
        </div>
      )}

      {/* Incomplete outcome */}
      {decideOutcome && "outcome" in decideOutcome && decideOutcome.outcome === "incomplete" && (
        <div
          data-testid="incomplete-unmet"
          className="border border-amber-300 bg-amber-50 dark:bg-amber-950 px-3 py-2 space-y-1"
        >
          <div className="text-[10px] font-mono uppercase text-amber-700 dark:text-amber-300">
            Decision recorded — requirements still unmet
          </div>
          <ul className="space-y-0.5">
            {decideOutcome.unmet.map((u) => (
              <li key={u} className="text-xs text-amber-800 dark:text-amber-200 font-mono">
                {u}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Saved locally */}
      {savedLocally && (
        <div
          data-testid="saved-locally-notice"
          className="flex items-center gap-2 border border-(--border) bg-(--bg-subtle) px-3 py-2"
        >
          <span className="text-xs text-(--fg)">
            Decision saved locally — push to remote failed.
          </span>
          <button
            type="button"
            data-testid="retry-push"
            onClick={handleRetry}
            disabled={retrying}
            className="border border-(--border) font-mono text-[11px] uppercase px-2 py-0.5 text-(--fg-muted) hover:text-(--fg) disabled:opacity-50"
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {/* Push skipped */}
      {pushSkippedNotice && (
        <div className="text-xs text-(--fg-muted) font-mono">not pushed (auto-push off)</div>
      )}

      {/* Touched paths */}
      {paths.length > 0 && (
        <div className="space-y-0.5" data-testid="paths-section">
          <div className="text-[10px] font-mono uppercase text-(--fg-muted) tracking-[0.08em]">
            Touched paths
          </div>
          {paths.map((p) => (
            <PathRow key={p.path} path={p} />
          ))}
        </div>
      )}

      {/* Governance actions */}
      <div className="flex flex-wrap gap-2">
        <Dialog.Root>
          <Dialog.Trigger asChild>
            <button
              type="button"
              disabled={actionsDisabled || decideMut.isPending}
              className="bg-(--fg) text-white font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 disabled:opacity-50 transition-opacity"
            >
              {decideMut.isPending && decideMut.variables === "approve" ? "Approving…" : "Approve"}
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm bg-white dark:bg-neutral-900 border border-(--border) p-6 shadow-none space-y-4">
              <Dialog.Title className="text-base font-semibold text-(--fg)">
                Approve commit
              </Dialog.Title>
              <Dialog.Description className="text-sm text-(--fg-muted)">
                This signs a decision record with your key.
              </Dialog.Description>
              <div className="flex gap-2 justify-end">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="border border-(--border) text-(--fg-muted) font-mono text-[12px] uppercase px-3 py-1.5 hover:text-(--fg)"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    onClick={() => decideMut.mutate("approve")}
                    className="bg-(--fg) text-white font-mono text-[12px] uppercase tracking-wide px-3 py-1.5"
                  >
                    Approve
                  </button>
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <button
          type="button"
          onClick={() => decideMut.mutate("reject")}
          disabled={actionsDisabled || decideMut.isPending}
          className="border border-(--border) font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 text-(--fg-muted) hover:text-(--fg) disabled:opacity-50 transition-colors"
        >
          {decideMut.isPending && decideMut.variables === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>

      {/* Review composer */}
      <div data-testid="review-composer">
        <ReviewComposer
          sha={sha}
          paths={paths}
          by={by}
          onDone={() => {
            // No-op — could invalidate diff query in future
          }}
        />
      </div>

      {/* Per-file diffs */}
      <div className="space-y-4">
        <div className="text-[10px] font-mono uppercase text-(--fg-muted) tracking-[0.08em]">
          Diff
        </div>

        {diffLoading && <p className="text-sm text-(--fg-muted)">Loading diff…</p>}

        {!diffLoading && diffData?.truncated && (
          <div
            data-testid="truncated-notice"
            className="border border-amber-300 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-xs text-amber-700"
          >
            Diff truncated — total patch exceeds 1 MB. Clone and diff locally for the full output.
          </div>
        )}

        {!diffLoading &&
          diffData?.files.map((file) => (
            <div key={file.path} className="border border-(--border)" data-testid="diff-file">
              <div className="px-3 py-1.5 border-b border-(--border) bg-(--bg-subtle) font-mono text-[11px] text-(--fg-muted) flex items-center gap-2">
                <span
                  className={cn(
                    "text-[10px] uppercase shrink-0 w-4",
                    file.verb === "A" && "text-green-600",
                    file.verb === "D" && "text-red-500",
                    file.verb === "M" && "text-(--fg-muted)"
                  )}
                >
                  {file.verb}
                </span>
                <span className="text-(--fg) break-all">{file.path}</span>
              </div>
              {file.binary ? (
                <div className="px-3 py-2 text-xs text-(--fg-muted) font-mono italic">binary</div>
              ) : (
                <pre className="text-xs overflow-x-auto p-3 bg-(--bg) text-(--fg) font-mono leading-relaxed whitespace-pre">
                  {file.newContent}
                </pre>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
