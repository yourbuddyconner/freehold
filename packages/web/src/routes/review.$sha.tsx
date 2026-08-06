/**
 * /review/:sha — full-page commit review.
 *
 * Shows commit metadata, per-file diffs, checklist, approve/reject controls,
 * and the review composer. Only available for repo graphs.
 */

import { parseDiffFromFile } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { CodeView, EditProvider, File, type CodeViewHandle, type DiffLineAnnotation } from "@pierre/diffs/react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ChecklistRow, DecidedChip, PathRow, ReviewComposer } from "~/components/GitProposalCard";
import { PierreDiff } from "~/components/PierreDiff";
import { PierreTree } from "~/components/PierreTree";
import { apiClient } from "~/lib/api";
import { cn } from "~/lib/cn";
import {
  useActiveGraph,
  useActiveGraphPrincipal,
  useDecideProposal,
  useGitProposal,
  useGitProposalDiff,
  useGraphs,
  useListGraphs,
  useReviewsForSha,
} from "~/lib/hooks";
import { type CommentDraft, clearDrafts, loadDrafts, parseSuggestionBody, saveDrafts, serializeSuggestionBody } from "~/lib/reviewDrafts";
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

interface AnnotationMeta {
  kind: "saved" | "draft";
  status: string;
  author?: string;
  body: string;
  span: string;
  path: string;
  draftIndex?: number;
  external_source?: string;
  suggestion?: string;
}

function parseAnchorPath(anchor: string | undefined): string | null {
  if (!anchor) return null;
  // git:<repo>#<sha>:<path>
  const m = anchor.match(/^git:[^#]+#[^:]+:(.+)$/);
  return m ? m[1] : null;
}

function parseSpan(span: string): { side: "deletions" | "additions"; lineNumber: number } {
  const isOld = span.startsWith("old:");
  const s = isOld ? span.slice(4) : span;
  const m = s.match(/^L(\d+)/);
  const lineNumber = m ? Number.parseInt(m[1], 10) : 1;
  return { side: isOld ? "deletions" : "additions", lineNumber };
}

function spanLines(newContent: string, span: string): string {
  // span is "L5" or "L5-L9" (no "old:" prefix — guaranteed additions-side by caller)
  const m = span.match(/^L(\d+)(?:-L(\d+))?$/);
  if (!m) return newContent;
  const start = Number.parseInt(m[1], 10);
  const end = m[2] ? Number.parseInt(m[2], 10) : start;
  const lines = newContent.split("\n");
  // 1-indexed
  return lines.slice(start - 1, end).join("\n");
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// biome-ignore lint/suspicious/noExplicitAny: EditorOptions annotation type param is unused here
function createEditorForSuggestion(options: EditorOptions<any>) {
  return new Editor(options);
}

// Exported for testing
export function ReviewPage({ sha }: { sha: string }) {
  const { data: proposal, isLoading } = useGitProposal(sha);
  const { graphs } = useGraphs();
  const { activeGraphId } = useActiveGraph();
  const activeGraph = graphs.find((g) => g.id === activeGraphId) ?? null;
  const isRepoGraph = activeGraph?.kind === "repo";

  const {
    data: diffData,
    isLoading: diffLoading,
    error: diffError,
  } = useGitProposalDiff(sha, isRepoGraph);

  const by = useActiveGraphPrincipal();

  const {
    decideMut,
    decideOutcome,
    keyMissingReason,
    savedLocally,
    pushSkippedNotice,
    retrying,
    handleRetry,
  } = useDecideProposal(sha, by);

  const queryClient = useQueryClient();

  // Reviews already posted for this commit
  const { data: reviewsData, error: reviewsError } = useReviewsForSha(sha);

  // Full graph list for repo name derivation
  const { data: listGraphsData } = useListGraphs();
  const activeGraphInfo = listGraphsData?.graphs.find((g) => g.id === activeGraphId) ?? null;
  const repoName = activeGraphInfo
    ? (activeGraphInfo.path.split("/").pop() ?? activeGraphInfo.name)
    : "repo";

  // Draft line comments (persisted to localStorage)
  const [drafts, setDraftsState] = useState<CommentDraft[]>(() => loadDrafts(sha));
  const [composerOpen, setComposerOpen] = useState<{ path: string; span: string } | null>(null);
  const [composerBody, setComposerBody] = useState("");
  const [suggestionMode, setSuggestionMode] = useState(false);
  const [suggestionText, setSuggestionText] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);
  // Review composer open state (lifted from ReviewComposer)
  const [reviewComposerOpen, setReviewComposerOpen] = useState(false);

  // Tracks which saved suggestion was most recently copied (by composite key)
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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
  const codeViewRef = useRef<CodeViewHandle<AnnotationMeta>>(null);

  const scrollToFile = useCallback((path: string) => {
    codeViewRef.current?.scrollTo({ type: "item", id: path });
  }, []);

  const suggestionFileRef = useRef<{ name: string; contents: string; cacheKey: string } | null>(null);
  const debouncedSuggestionText = useDebouncedValue(suggestionText, 150);

  const files = diffData?.files ?? [];

  // Annotations from saved/pending reviews
  const savedAnnotationsByPath = useMemo(() => {
    const map = new Map<string, DiffLineAnnotation<AnnotationMeta>[]>();
    for (const review of reviewsData?.reviews ?? []) {
      for (const comment of review.comments) {
        const path = parseAnchorPath(comment.anchor);
        if (!path || !comment.span) continue;
        const { side, lineNumber } = parseSpan(comment.span);
        const arr = map.get(path) ?? [];
        arr.push({
          side,
          lineNumber,
          metadata: {
            kind: "saved",
            status: review.status,
            author: review.author,
            body: comment.body ?? "",
            span: comment.span,
            path,
            external_source: comment.external_source,
          },
        });
        map.set(path, arr);
      }
    }
    return map;
  }, [reviewsData]);

  // Annotations from local drafts
  const draftAnnotationsByPath = useMemo(() => {
    const map = new Map<string, DiffLineAnnotation<AnnotationMeta>[]>();
    drafts.forEach((draft, draftIndex) => {
      const { side, lineNumber } = parseSpan(draft.span);
      const arr = map.get(draft.path) ?? [];
      arr.push({
        side,
        lineNumber,
        metadata: {
          kind: "draft",
          status: "pending",
          body: draft.body,
          span: draft.span,
          path: draft.path,
          draftIndex,
          suggestion: draft.suggestion,
        },
      });
      map.set(draft.path, arr);
    });
    return map;
  }, [drafts]);

  const composerSpanLines = useMemo(() => {
    if (!composerOpen) return "";
    const f = files.find((f) => f.path === composerOpen.path);
    if (!f) return "";
    return spanLines(f.newContent, composerOpen.span);
  }, [composerOpen, files]);

  // Build CodeView items for non-binary, non-truncated files
  const codeViewItems = useMemo(() => {
    return files
      .filter((f) => !f.binary && !f.truncated)
      .map((f) => {
        const saved = savedAnnotationsByPath.get(f.path) ?? [];
        const draftAnns = draftAnnotationsByPath.get(f.path) ?? [];
        const annotations: DiffLineAnnotation<AnnotationMeta>[] = [...saved, ...draftAnns];
        return {
          id: f.path,
          type: "diff" as const,
          fileDiff: parseDiffFromFile(
            { name: f.oldPath ?? f.path, contents: f.oldContent },
            { name: f.path, contents: f.newContent }
          ),
          ...(annotations.length > 0 ? { annotations } : {}),
        };
      });
  }, [files, savedAnnotationsByPath, draftAnnotationsByPath]);

  // Draft management helpers
  function persistDrafts(newDrafts: CommentDraft[]) {
    setDraftsState(newDrafts);
    saveDrafts(sha, newDrafts);
  }

  function handleSaveDraft() {
    if (!composerOpen || !composerBody.trim() && !suggestionMode) return;
    const newDraft: CommentDraft = {
      path: composerOpen.path,
      span: composerOpen.span,
      body: composerBody.trim(),
      ...(suggestionMode && suggestionText ? { suggestion: suggestionText } : {}),
    };
    persistDrafts([...drafts, newDraft]);
    setComposerBody("");
    setSuggestionMode(false);
    setSuggestionText("");
    setComposerOpen(null);
  }

  function handleRemoveDraft(idx: number) {
    persistDrafts(drafts.filter((_, i) => i !== idx));
  }

  // Submit review (with optional inline comments) then decide
  async function submitReviewAndDecide(verdict: "approve" | "reject") {
    setReviewError(null);
    if (drafts.length > 0) {
      const apiVerdict = verdict === "approve" ? "approve-with-comments" : "request-changes";
      const anchor = (path: string) => `git:${repoName}#${sha}:${path}`;
      try {
        await apiClient.postGitReview(sha, {
          verdict: apiVerdict,
          by,
          comments: drafts.map((d) => ({ body: d.body, anchor: anchor(d.path), span: d.span })),
        });
      } catch (err) {
        setReviewError(err instanceof Error ? err.message : "Review post failed.");
        return;
      }
      decideMut.mutate(verdict);
      clearDrafts(sha);
      setDraftsState([]);
      queryClient.invalidateQueries({ queryKey: ["git-reviews", sha] });
    } else {
      decideMut.mutate(verdict);
    }
  }

  // Render a single annotation in CodeView
  function renderAnnotation(
    ann: DiffLineAnnotation<AnnotationMeta>,
    _item: unknown
  ): React.ReactNode {
    const meta = ann.metadata;
    if (meta.kind === "draft") {
      const { prose, suggestion } = meta.suggestion !== undefined
        ? { prose: meta.body, suggestion: meta.suggestion }
        : parseSuggestionBody(meta.body);
      return (
        <div
          className="border border-(--border) bg-(--bg-subtle) p-2 text-xs space-y-1"
          data-testid="annotation"
          data-path={meta.path}
          data-span={meta.span}
          data-status="pending"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase text-(--fg-muted)">pending</span>
            <button
              type="button"
              onClick={() => {
                if (meta.draftIndex !== undefined) handleRemoveDraft(meta.draftIndex);
              }}
              className="text-(--fg-muted) hover:text-(--fg) text-[11px]"
            >
              Remove
            </button>
          </div>
          {(() => (
            <>
              {prose && <div className="text-(--fg)">{prose}</div>}
              {suggestion !== null && (
                <div data-testid="suggestion-diff" className="space-y-1">
                  <div className="text-[10px] font-mono uppercase text-(--fg-muted)">Suggested change</div>
                  <PierreDiff
                    oldText={(() => {
                      const f = files.find((f) => f.path === meta.path);
                      return f ? spanLines(f.newContent, meta.span) : "";
                    })()}
                    newText={suggestion}
                    name={meta.path}
                  />
                </div>
              )}
              {suggestion === null && <div className="text-(--fg)">{meta.body}</div>}
            </>
          ))()}
        </div>
      );
    }
    {
      const { prose, suggestion } = parseSuggestionBody(meta.body);
      const key = `${meta.path}:${meta.span}:${meta.author ?? ""}:${meta.status}`;
      return (
        <div
          className="border border-(--border) bg-(--bg-subtle) p-2 text-xs space-y-1"
          data-testid="annotation"
          data-path={meta.path}
          data-span={meta.span}
          data-status={meta.status}
          data-author={meta.author}
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-(--fg-muted)">{meta.author}</span>
            <span
              className={cn(
                "font-mono text-[10px] uppercase px-1",
                meta.status === "saved" ? "text-green-600" : "text-amber-600"
              )}
            >
              {meta.status}
            </span>
            {meta.external_source && (
              <span className="font-mono text-[10px] text-(--fg-muted)">via github</span>
            )}
          </div>
          {(() => (
            <>
              {prose && <div className="text-(--fg)">{prose}</div>}
              {suggestion !== null && (
                <div data-testid="suggestion-diff" className="space-y-1">
                  <div className="text-[10px] font-mono uppercase text-(--fg-muted)">Suggested change</div>
                  <PierreDiff
                    oldText={(() => {
                      const f = files.find((f) => f.path === meta.path);
                      return f ? spanLines(f.newContent, meta.span) : "";
                    })()}
                    newText={suggestion}
                    name={meta.path}
                  />
                  <button
                    type="button"
                    data-testid="copy-suggestion-btn"
                    onClick={() => {
                      navigator.clipboard.writeText(suggestion).catch(() => {});
                      setCopiedKey(key);
                      setTimeout(() => setCopiedKey(null), 2000);
                    }}
                    className="border border-(--border) font-mono text-[10px] uppercase px-2 py-0.5 text-(--fg-muted) hover:text-(--fg)"
                  >
                    {copiedKey === key ? "Copied" : "Copy suggestion"}
                  </button>
                </div>
              )}
              {suggestion === null && <div className="text-(--fg)">{meta.body}</div>}
            </>
          ))()}
        </div>
      );
    }
  }

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
    <div className="p-6 space-y-6">
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

      {/* Review post error */}
      {reviewError && (
        <div
          data-testid="review-error"
          className="border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-300"
        >
          {reviewError}
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
      <div className="flex flex-wrap items-center gap-2">
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
                {drafts.length > 0
                  ? ` — ${drafts.length} comment${drafts.length === 1 ? "" : "s"} pending`
                  : ""}
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
                    onClick={() => submitReviewAndDecide("approve")}
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
          onClick={() => submitReviewAndDecide("reject")}
          disabled={actionsDisabled || decideMut.isPending}
          className="border border-(--border) font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 text-(--fg-muted) hover:text-(--fg) disabled:opacity-50 transition-colors"
        >
          {decideMut.isPending && decideMut.variables === "reject"
            ? "Requesting changes…"
            : "Request changes"}
        </button>

        {drafts.length > 0 && (
          <span className="text-xs text-(--fg-muted)" data-testid="pending-count">
            {drafts.length} comment{drafts.length === 1 ? "" : "s"} pending
          </span>
        )}
      </div>

      {/* Review composer (legacy path-level) */}
      <div data-testid="review-composer">
        <ReviewComposer
          sha={sha}
          paths={paths}
          by={by}
          open={reviewComposerOpen}
          onOpen={() => setReviewComposerOpen(true)}
          onClose={() => setReviewComposerOpen(false)}
          onDone={() => {
            setReviewComposerOpen(false);
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

        {reviewsError && (
          <div
            data-testid="reviews-error"
            className="border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-300"
          >
            Could not load review comments.
            {reviewsError instanceof Error && reviewsError.message
              ? ` ${reviewsError.message}`
              : ""}
          </div>
        )}

        {diffError && (
          <div
            data-testid="diff-error"
            className="border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-300"
          >
            Could not load diff.
            {diffError instanceof Error && diffError.message ? ` ${diffError.message}` : ""}
          </div>
        )}

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
                height={Math.min(600, 120 + files.length * 24)}
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
                  key={diffStyle}
                  ref={codeViewRef}
                  className="w-full"
                  items={codeViewItems}
                  renderAnnotation={renderAnnotation}
                  onSelectedLinesChange={(selection) => {
                    if (!selection) return;
                    const { id: path, range } = selection;
                    const side = range.side === "deletions" ? "old:" : "";
                    const span =
                      range.start === range.end
                        ? `${side}L${range.start}`
                        : `${side}L${range.start}-L${range.end}`;
                    setComposerOpen({ path, span });
                    setSuggestionMode(false);
                    setSuggestionText("");
                  }}
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

      {/* Inline line-comment composer (opens when a line range is selected) */}
      {composerOpen && (
        <div
          className="border border-(--border) bg-(--bg-subtle) p-3 space-y-2"
          data-testid="line-composer"
        >
          <div className="text-[11px] font-mono text-(--fg-muted)">
            Comment on {composerOpen.path} {composerOpen.span}
          </div>
          <div className="flex gap-2 items-center">
            {!composerOpen.span.startsWith("old:") && (
              <button
                type="button"
                onClick={() => {
                  const next = !suggestionMode;
                  setSuggestionMode(next);
                  if (next) {
                    setSuggestionText(composerSpanLines);
                    suggestionFileRef.current = {
                      name: composerOpen.path,
                      contents: composerSpanLines,
                      cacheKey: `suggest-${composerOpen.path}-${composerOpen.span}`,
                    };
                  }
                }}
                className={cn(
                  "border font-mono text-[11px] uppercase px-2 py-1",
                  suggestionMode
                    ? "border-(--border) bg-(--bg-subtle) text-(--fg)"
                    : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
                )}
                data-testid="suggest-toggle"
              >
                {suggestionMode ? "Suggesting" : "Suggest change"}
              </button>
            )}
          </div>
          <textarea
            value={composerBody}
            onChange={(e) => setComposerBody(e.target.value)}
            rows={3}
            placeholder="Comment body"
            className="w-full border border-(--border) bg-(--bg) px-2 py-1.5 text-xs text-(--fg) resize-none font-mono"
            aria-label="Comment body"
          />
          {suggestionMode && suggestionFileRef.current && (
            <div className="space-y-2" data-testid="suggestion-editor-area">
              <div className="border border-(--border)" data-testid="suggestion-editor">
                <EditProvider createEditor={createEditorForSuggestion}>
                  <File
                    file={suggestionFileRef.current}
                    edit
                    editorOptions={{
                      onChange: (file: { contents: string }) => setSuggestionText(file.contents),
                    }}
                    options={{ disableFileHeader: true, overflow: "wrap" }}
                  />
                </EditProvider>
              </div>
              <div className="text-[10px] font-mono uppercase text-(--fg-muted)">Suggested change</div>
              <PierreDiff
                oldText={composerSpanLines}
                newText={debouncedSuggestionText}
                name={composerOpen.path}
              />
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSaveDraft}
              className="bg-(--fg) text-white font-mono text-[11px] uppercase px-2 py-1"
            >
              Save draft
            </button>
            <button
              type="button"
              onClick={() => {
                setComposerOpen(null);
                setSuggestionMode(false);
                setSuggestionText("");
              }}
              className="border border-(--border) font-mono text-[11px] uppercase px-2 py-1 text-(--fg-muted)"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
