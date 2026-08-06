import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { apiClient } from "~/lib/api";
import { useChangeset } from "~/lib/changeset";
import type { ChangesetEntry } from "~/lib/changeset";

function lastPolicyPayload(entries: ChangesetEntry[]): unknown | null {
  const policyEntries = entries.filter((e) => e.kind === "policy");
  if (policyEntries.length === 0) return null;
  return policyEntries[policyEntries.length - 1].payload;
}

export function ChangesetTray(): React.JSX.Element | null {
  const { entries, clear, unstage } = useChangeset();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (success) {
    return (
      <div
        data-testid="changeset-success"
        className="fixed bottom-4 right-4 z-50 w-80 border border-(--border) bg-(--bg) shadow-lg px-4 py-3"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-(--fg)">Proposal submitted.</span>
          <button
            type="button"
            onClick={() => setSuccess(false)}
            aria-label="Dismiss"
            className="shrink-0 text-(--fg-muted) hover:text-(--fg)"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  if (entries.length === 0) return null;

  // intent is not included in the POST body — POST /policy has no message field
  async function handleCommit() {
    setError(null);
    const payload = lastPolicyPayload(entries);
    if (payload === null) {
      // No actionable entries — clear and done.
      clear();
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.proposePolicy({
        policy_yaml: JSON.stringify(payload, null, 2),
      });
      clear();
      setSuccess(true);
      qc.invalidateQueries({ queryKey: ["policy"] });
      qc.invalidateQueries({ queryKey: ["proposals"] });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    clear();
    setSuccess(false);
    setError(null);
  }

  return (
    <div
      data-testid="changeset-tray"
      className="fixed bottom-4 right-4 z-50 w-80 border border-(--border) bg-(--bg) shadow-lg"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-(--border)">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
          Staged changes · {entries.length}
        </span>
      </div>

      {/* Entry list */}
      <ul className="divide-y divide-(--border) max-h-48 overflow-y-auto">
        {entries.map((entry, i) => (
          <li key={entry.id} className="flex items-start gap-2 px-4 py-2">
            <span className="flex-1 text-xs text-(--fg) truncate leading-relaxed">
              {entry.label}
              {entry.detail && (
                <span className="block text-[10px] text-(--fg-muted) truncate">{entry.detail}</span>
              )}
            </span>
            <button
              type="button"
              data-testid={`unstage-${i}`}
              onClick={() => unstage(entry.id)}
              aria-label={`Remove ${entry.label}`}
              className="shrink-0 text-(--fg-muted) hover:text-(--fg) mt-0.5"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      {/* Intent input */}
      <div className="px-4 pt-3 pb-2">
        <IntentInput />
      </div>

      {/* Error */}
      {error && (
        <p className="px-4 pb-2 text-xs text-[var(--color-status-rejected)]" role="alert">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 px-4 pb-4 pt-1">
        <button
          type="button"
          data-testid="commit-btn"
          onClick={handleCommit}
          disabled={submitting}
          className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Commit"}
        </button>
        <button
          type="button"
          data-testid="cancel-btn"
          onClick={handleCancel}
          className="border border-(--border) px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Split out so IntentInput can use useChangeset without polluting parent render.
function IntentInput() {
  const { intent, setIntent } = useChangeset();
  return (
    <input
      type="text"
      value={intent}
      onChange={(e) => setIntent(e.target.value)}
      placeholder="Describe this change"
      className="w-full border border-(--border) bg-(--bg-subtle) px-2.5 py-1.5 text-xs text-(--fg) placeholder:text-(--fg-muted) focus:outline-none focus:ring-1 focus:ring-(--border)"
    />
  );
}
