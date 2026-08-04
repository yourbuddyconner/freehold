import { Link } from "@tanstack/react-router";
import { PierreDiff } from "./PierreDiff";

interface CommitStepProps {
  oldText: string;
  newText: string;
  /** Filename for highlighting (memory.md or attributes.json) */
  name?: string;
  onCommit: () => void;
  onKeepEditing: () => void;
  committing?: boolean;
  /** Set when the base changed since the editor opened (409 path) */
  conflictNotice?: boolean;
  /** Set when the commit landed pending under policy */
  pendingHash?: string;
  errorMessage?: string;
}

/**
 * The moment of consent: the exact change about to enter the log, with
 * Commit writing the signed changeset. Shown after Save, before anything
 * is written.
 */
export function CommitStep({
  oldText,
  newText,
  name = "memory.md",
  onCommit,
  onKeepEditing,
  committing = false,
  conflictNotice = false,
  pendingHash,
  errorMessage,
}: CommitStepProps) {
  if (pendingHash) {
    return (
      <div
        className="border border-(--border) bg-(--bg-subtle) p-4 space-y-2 text-sm"
        data-testid="commit-pending"
      >
        <p className="text-(--fg)">This change is pending review.</p>
        <p className="text-(--fg-muted)">
          Policy routed it to the{" "}
          <Link to="/inbox" className="underline text-(--fg)">
            Inbox
          </Link>{" "}
          instead of saving it directly.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
        Review before signing
      </p>
      {conflictNotice && (
        <p
          className="border border-[var(--color-status-pending)] bg-(--bg-subtle) p-2.5 text-xs text-(--fg)"
          data-testid="commit-conflict"
        >
          This item changed while you were editing. The diff below compares your edit against the
          current version.
        </p>
      )}
      {errorMessage && (
        <p
          className="border border-[var(--color-status-rejected)] bg-(--bg-subtle) p-2.5 text-xs text-(--fg)"
          data-testid="commit-error"
        >
          {errorMessage}
        </p>
      )}
      <PierreDiff oldText={oldText} newText={newText} name={name} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCommit}
          disabled={committing}
          className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-50"
        >
          {committing ? "Signing…" : "Commit"}
        </button>
        <button
          type="button"
          onClick={onKeepEditing}
          className="border border-(--border) px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
        >
          Keep editing
        </button>
      </div>
    </div>
  );
}
