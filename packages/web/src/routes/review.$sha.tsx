/**
 * /review/:sha — full-page commit review.
 *
 * Shows commit metadata, per-file diffs, checklist, approve/reject controls,
 * and the review composer. Only available for repo graphs.
 */

import { parseDiffFromFile } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import * as Dialog from "@radix-ui/react-dialog";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChecklistRow, DecidedChip, PathRow, ReviewComposer } from "~/components/GitProposalCard";
import { PierreTree } from "~/components/PierreTree";
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

const DIFF_VIEW_KEY = "freehold-diff-view";

function readDiffStyle(): "split" | "unified" {
  try {
    const v = localStorage.getItem(DIFF_VIEW_KEY);
    if (v === "unified" || v === "split") return v;
  } catch {
    // ignore
  }
  return "split";
}

function activeTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function verbToStatus(verb: string): "added" | "modified" | "deleted" | "renamed" {
  if (verb === "A") return "added";
  if (verb === "D") return "deleted";
  if (verb === "R") return "renamed";
  return "modified";
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

  // Diff view style — split (default) or unified; persisted
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">(readDiffStyle);

  const updateDiffStyle = useCallback((style: "split" | "unified") => {
    setDiffStyle(style);
    try {
      localStorage.setItem(DIFF_VIEW_KEY, style);
    } catch {
      // ignore
    }
  }, []);

  // Refs for CodeView scrolling from tree selection
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);

  const scrollToFile = useCallback((path: string) => {
    codeViewRef.current?.scrollTo({ type: "item", id: path });
  }, []);

  const files = diffData?.files ?? [];

  // Build CodeView items for non-binary, non-truncated files
  const codeViewItems = useMemo(() => {
    return files
      .filter((f) => !f.binary && !f.truncated)
      .map((f) => ({
        id: f.path,
        type: "diff" as const,
        fileDiff: parseDiffFromFile(
          { name: f.oldPath ?? f.path, contents: f.oldContent },
          { name: f.path, contents: f.newContent }
        ),
      }));
  }, [files]);

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
        {/* Diffs section header with split/unified toggle */}
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-mono uppercase text-(--fg-muted) tracking-[0.08em]">
            Diff
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => updateDiffStyle("split")}
              className={cn(
                "border font-mono text-[11px] uppercase px-2 py-0.5 transition-colors",
                diffStyle === "split"
                  ? "border-(--border) text-(--fg) bg-(--bg-subtle)"
                  : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
              )}
            >
              Split
            </button>
            <button
              type="button"
              onClick={() => updateDiffStyle("unified")}
              className={cn(
                "border font-mono text-[11px] uppercase px-2 py-0.5 transition-colors",
                diffStyle === "unified"
                  ? "border-(--border) text-(--fg) bg-(--bg-subtle)"
                  : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
              )}
            >
              Unified
            </button>
          </div>
        </div>

        {diffLoading && <p className="text-sm text-(--fg-muted)">Loading diff…</p>}

        {!diffLoading && diffData?.truncated && (
          <div
            data-testid="truncated-notice"
            className="border border-amber-300 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-xs text-amber-700"
          >
            Some files were too large to display.
          </div>
        )}

        {!diffLoading && files.length > 0 && (
          <div className="flex gap-4">
            {/* Changed-files tree sidebar */}
            <aside className="w-[280px] shrink-0">
              <PierreTree
                paths={files.map((f) => f.path)}
                gitStatus={files.map((f) => ({ path: f.path, status: verbToStatus(f.verb) }))}
                onSelect={(path) => scrollToFile(path)}
                initialExpansion="open"
                scrollToRef={undefined}
              />
            </aside>

            {/* Diff content area */}
            <div className="min-w-0 flex-1 space-y-3">
              {/* Binary / truncated file captions (rendered outside CodeView) */}
              {files
                .filter((f) => f.binary || f.truncated)
                .map((f) => (
                  <div
                    key={f.path}
                    id={f.path}
                    className="border border-(--border) px-3 py-2 text-xs font-mono text-(--fg-muted)"
                    data-testid="diff-file"
                  >
                    <span className="text-(--fg) break-all">{f.path}</span>
                    <span className="ml-2">
                      {f.binary ? "Binary file." : "File too large to display."}
                    </span>
                  </div>
                ))}

              {/* CodeView for text diffs */}
              {codeViewItems.length > 0 && (
                <CodeView
                  ref={codeViewRef}
                  items={codeViewItems}
                  options={{
                    diffStyle,
                    lineDiffType: "word-alt",
                    stickyHeaders: true,
                    overflow: "wrap",
                    themeType: activeTheme(),
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
