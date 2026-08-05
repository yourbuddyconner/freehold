import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { DecideResult, GitProposal } from "@freehold/client";
import { ApiError } from "~/lib/api";
import { apiClient } from "~/lib/api";
import { cn } from "~/lib/cn";
import { useSession } from "~/lib/hooks";

// ── Checklist row ─────────────────────────────────────────────────────────────

function ChecklistRow({ item, unmet }: { item: unknown; unmet: string[] }) {
  const entry = item as Record<string, unknown>;
  const label =
    typeof entry.role === "string"
      ? entry.role
      : typeof entry.rule === "string"
        ? entry.rule
        : typeof entry.name === "string"
          ? entry.name
          : JSON.stringify(item);
  const isMet = !unmet.some((u) => u === label || u.includes(label));
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        aria-label={isMet ? "met" : "unmet"}
        className={cn(
          "inline-block h-2 w-2 rounded-full shrink-0",
          isMet ? "bg-green-500" : "bg-red-400"
        )}
      />
      <span className={cn("font-mono text-[11px]", isMet ? "text-(--fg)" : "text-red-600 dark:text-red-400")}>
        {label}
      </span>
    </div>
  );
}

// ── Path badge ────────────────────────────────────────────────────────────────

function PathRow({ path }: { path: GitProposal["paths"][number] }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] font-mono py-0.5">
      <span className="text-(--fg-muted) uppercase text-[10px] shrink-0 w-8">{path.verb}</span>
      <span className="text-(--fg) break-all">{path.path}</span>
      <div className="flex flex-wrap gap-1 ml-auto pl-2 shrink-0">
        {path.regions.map((r) => (
          <span
            key={r}
            data-testid="region-badge"
            className="inline-flex items-center border border-blue-300 bg-blue-50 dark:bg-blue-950 dark:border-blue-700 px-1 py-0.5 text-[10px] text-blue-700 dark:text-blue-300"
          >
            {r}
          </span>
        ))}
        {!path.indexed && (
          <span
            data-testid="not-indexed-badge"
            className="inline-flex items-center border border-amber-300 bg-amber-50 dark:bg-amber-950 px-1 py-0.5 text-[10px] text-amber-700 dark:text-amber-300"
            title="Run `allod git index` to index this path"
          >
            not yet indexed
          </span>
        )}
      </div>
    </div>
  );
}

// ── Decided chip ──────────────────────────────────────────────────────────────

function DecidedChip({ decided }: { decided: GitProposal["decided"] }) {
  return (
    <span
      data-testid="decided-chip"
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono uppercase border",
        decided === "approved" &&
          "border-green-400 bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300",
        decided === "rejected" &&
          "border-red-400 bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400",
        decided === "undecided" && "border-(--border) bg-(--bg-subtle) text-(--fg-muted)"
      )}
    >
      {decided}
    </span>
  );
}

// ── Review composer ───────────────────────────────────────────────────────────

interface ReviewComposerProps {
  sha: string;
  paths: GitProposal["paths"];
  by: string;
  onDone: () => void;
}

function ReviewComposer({ sha, paths, by, onDone }: ReviewComposerProps) {
  const [verdict, setVerdict] = useState<"approve" | "approve-with-comments" | "request-changes">("approve");
  const [body, setBody] = useState("");
  const [comments, setComments] = useState<{ path: string; anchor: string; body: string }[]>([]);
  const [status, setStatus] = useState<null | "saved" | "pending" | "error">(null);
  const [open, setOpen] = useState(false);

  const qc = useQueryClient();

  const submitMut = useMutation({
    mutationFn: () => {
      const commentInputs = comments
        .filter((c) => c.body.trim())
        .map((c) => ({ body: c.body, anchor: c.anchor || c.path || undefined }));
      return apiClient.postGitReview(sha, {
        verdict,
        body: body || undefined,
        by,
        comments: commentInputs.length > 0 ? commentInputs : undefined,
      });
    },
    onSuccess: (result) => {
      setStatus(result.status as "saved" | "pending");
      qc.invalidateQueries({ queryKey: ["git-proposals"] });
      setTimeout(() => {
        setOpen(false);
        setStatus(null);
        setBody("");
        setComments([]);
        onDone();
      }, 1500);
    },
    onError: () => {
      setStatus("error");
    },
  });

  function addComment() {
    setComments((cs) => [...cs, { path: "", anchor: "", body: "" }]);
  }

  function updateComment(idx: number, field: "path" | "anchor" | "body", value: string) {
    setComments((cs) => cs.map((c, i) => (i === idx ? { ...c, [field]: value } : c)));
  }

  function removeComment(idx: number) {
    setComments((cs) => cs.filter((_, i) => i !== idx));
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-(--border) font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 text-(--fg-muted) hover:text-(--fg) transition-colors"
      >
        Write review
      </button>
    );
  }

  return (
    <div className="border border-(--border) bg-(--bg-subtle) p-3 space-y-3">
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-mono uppercase text-(--fg-muted) shrink-0">Verdict</label>
        <select
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as typeof verdict)}
          className="text-xs border border-(--border) bg-(--bg) px-2 py-1 text-(--fg)"
        >
          <option value="approve">Approve</option>
          <option value="approve-with-comments">Approve with comments</option>
          <option value="request-changes">Request changes</option>
        </select>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Review body (optional)"
        rows={3}
        className="w-full border border-(--border) bg-(--bg) px-2 py-1.5 text-xs text-(--fg) resize-none font-mono"
        aria-label="Review body"
      />
      {comments.map((comment, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable UI list keyed by index
        <div key={idx} className="border border-(--border) p-2 space-y-1.5 bg-(--bg)">
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-mono uppercase text-(--fg-muted) shrink-0">Path</label>
            <select
              value={comment.path}
              onChange={(e) => updateComment(idx, "path", e.target.value)}
              className="flex-1 text-xs border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5"
              aria-label="Comment path"
            >
              <option value="">— pick a path —</option>
              {paths.map((p) => (
                <option key={p.path} value={p.path}>{p.path}</option>
              ))}
            </select>
            <button type="button" onClick={() => removeComment(idx)} className="text-[10px] text-red-500 font-mono">✕</button>
          </div>
          <input
            value={comment.anchor}
            onChange={(e) => updateComment(idx, "anchor", e.target.value)}
            placeholder="Anchor (optional, e.g. fn name)"
            className="w-full border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg)"
            aria-label="Comment anchor"
          />
          <textarea
            value={comment.body}
            onChange={(e) => updateComment(idx, "body", e.target.value)}
            placeholder="Comment body"
            rows={2}
            className="w-full border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg) resize-none"
            aria-label="Comment body"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={addComment}
        className="text-[11px] font-mono text-(--fg-muted) hover:text-(--fg) underline underline-offset-2"
      >
        + Add path comment
      </button>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => submitMut.mutate()}
          disabled={submitMut.isPending}
          className="bg-(--fg) text-white font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 disabled:opacity-50"
        >
          {submitMut.isPending ? "Saving…" : "Submit review"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setStatus(null); }}
          className="border border-(--border) text-(--fg-muted) font-mono text-[12px] uppercase px-3 py-1.5 hover:text-(--fg)"
        >
          Cancel
        </button>
        {status === "saved" && (
          <span data-testid="review-status" className="text-xs text-green-600 font-mono">saved</span>
        )}
        {status === "pending" && (
          <span data-testid="review-status" className="text-xs text-(--fg-muted) font-mono">pending</span>
        )}
        {status === "error" && (
          <span data-testid="review-status" className="text-xs text-red-600 font-mono">error submitting review</span>
        )}
      </div>
    </div>
  );
}

// ── GitProposalCard ───────────────────────────────────────────────────────────

interface GitProposalCardProps {
  proposal: GitProposal;
  by: string;
}

export function GitProposalCard({ proposal, by }: GitProposalCardProps) {
  const { sha, message, author, timestamp, checklist, unmet, decided, paths, ref } = proposal;
  const shortSha = sha.slice(0, 7);

  const qc = useQueryClient();

  const [decideOutcome, setDecideOutcome] = useState<DecideResult | null>(null);
  const [keyMissingReason, setKeyMissingReason] = useState<string | null>(null);
  const [savedLocally, setSavedLocally] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const decideMut = useMutation({
    mutationFn: (verdict: "approve" | "reject") =>
      apiClient.decideGitProposal(sha, { verdict, by }),
    onSuccess: (result) => {
      setDecideOutcome(result);
      if ("pushed" in result && !result.pushed) {
        setSavedLocally(true);
      }
      qc.invalidateQueries({ queryKey: ["git-proposals"] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "key-missing") {
        setKeyMissingReason(err.message);
      }
    },
  });

  async function handleRetry() {
    setRetrying(true);
    try {
      const result = await apiClient.pushGitNotes(sha);
      if (result.pushed) {
        setSavedLocally(false);
        setDecideOutcome(null);
      }
    } finally {
      setRetrying(false);
    }
  }

  const actionsDisabled = !!keyMissingReason || decided !== "undecided";

  let timeDisplay = timestamp;
  try {
    timeDisplay = new Date(timestamp).toLocaleDateString();
  } catch {
    // keep raw
  }

  return (
    <article
      className="reg-marks relative border border-(--border) p-4 space-y-3 bg-(--bg-subtle)"
      data-testid={`git-proposal-${shortSha}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-semibold text-(--fg)">{shortSha}</span>
            <span className="text-xs text-(--fg-muted)">·</span>
            <span className="text-xs text-(--fg-muted)">{author}</span>
            <span className="text-xs text-(--fg-muted)">·</span>
            <span className="text-xs text-(--fg-muted)">{timeDisplay}</span>
            <span className="text-xs text-(--fg-muted)">on</span>
            <span className="font-mono text-[11px] text-(--fg-muted)">{ref.replace("refs/heads/", "")}</span>
            <DecidedChip decided={decided} />
          </div>
          <p className="text-sm text-(--fg) mt-1 leading-snug">{message}</p>
        </div>
      </div>

      {keyMissingReason && (
        <div
          data-testid="key-missing-notice"
          className="border border-amber-300 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          Governance actions disabled: {keyMissingReason}
        </div>
      )}

      {checklist.length > 0 && (
        <div className="space-y-1" data-testid="checklist">
          <div className="text-[10px] font-mono uppercase text-(--fg-muted) tracking-[0.08em]">Checklist</div>
          {checklist.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: checklist items are stable for a given sha
            <ChecklistRow key={i} item={item} unmet={unmet} />
          ))}
        </div>
      )}

      {decideOutcome && "outcome" in decideOutcome && decideOutcome.outcome === "incomplete" && (
        <div data-testid="incomplete-unmet" className="border border-amber-300 bg-amber-50 dark:bg-amber-950 px-3 py-2 space-y-1">
          <div className="text-[10px] font-mono uppercase text-amber-700 dark:text-amber-300">Decision recorded — requirements still unmet</div>
          <ul className="space-y-0.5">
            {decideOutcome.unmet.map((u) => (
              <li key={u} className="text-xs text-amber-800 dark:text-amber-200 font-mono">{u}</li>
            ))}
          </ul>
        </div>
      )}

      {savedLocally && (
        <div data-testid="saved-locally-notice" className="flex items-center gap-2 border border-(--border) bg-(--bg-subtle) px-3 py-2">
          <span className="text-xs text-(--fg)">Decision saved locally — push to remote failed.</span>
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

      {paths.length > 0 && (
        <div className="space-y-0.5" data-testid="paths-section">
          <div className="text-[10px] font-mono uppercase text-(--fg-muted) tracking-[0.08em]">Touched paths</div>
          {paths.map((p) => (
            <PathRow key={p.path} path={p} />
          ))}
          {paths.some((p) => !p.indexed) && (
            <p className="text-[10px] text-(--fg-muted) pt-0.5">
              Paths marked "not yet indexed" can be indexed with{" "}
              <code className="border border-(--border) bg-(--bg) px-1 font-mono">allod git index</code>
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
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
              <Dialog.Title className="text-base font-semibold text-(--fg)">Approve commit</Dialog.Title>
              <Dialog.Description className="text-sm text-(--fg-muted)">
                This signs a decision record with your key.
              </Dialog.Description>
              <div className="flex gap-2 justify-end">
                <Dialog.Close asChild>
                  <button type="button" className="border border-(--border) text-(--fg-muted) font-mono text-[12px] uppercase px-3 py-1.5 hover:text-(--fg)">Cancel</button>
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

        <ReviewComposer sha={sha} paths={paths} by={by} onDone={() => qc.invalidateQueries({ queryKey: ["git-proposals"] })} />
      </div>

      <span className="reg-mark-bl" aria-hidden />
      <span className="reg-mark-br" aria-hidden />
    </article>
  );
}
