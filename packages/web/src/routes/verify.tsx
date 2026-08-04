import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { VerifyReport } from "~/components/VerifyReport";
import { apiClient } from "~/lib/api";
import { useLog } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/verify",
  component: VerifyPage,
});

// ---------------------------------------------------------------------------
// Changeset timeline
// ---------------------------------------------------------------------------

interface ChangesetEntry {
  hash?: string;
  author?: string;
  intent?: string;
  ops?: number;
  timestamp?: string;
}

function parseLog(raw: unknown): ChangesetEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.entries) ? obj.entries : Array.isArray(raw) ? raw : [];
  return (list as unknown[]).map((item) => {
    if (typeof item !== "object" || item === null) return {};
    const e = item as Record<string, unknown>;
    return {
      hash: typeof e.hash === "string" ? e.hash : undefined,
      author: typeof e.author === "string" ? e.author : undefined,
      intent: typeof e.intent === "string" ? e.intent : undefined,
      ops:
        typeof e.ops === "number" ? e.ops : typeof e.op_count === "number" ? e.op_count : undefined,
      timestamp: typeof e.timestamp === "string" ? e.timestamp : undefined,
    };
  });
}

function ChangesetTimeline({ entries }: { entries: ChangesetEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="mt-6">
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
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[--fg-muted]">
          CHANGESET TIMELINE
        </span>
      </div>
      <h3 className="text-sm font-semibold tracking-tight text-[--fg] mb-3">Changeset timeline</h3>
      <div className="border border-[--border] overflow-hidden">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-[--bg-subtle]">
            <tr className="border-b border-[--border]">
              <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[--fg-muted] font-normal">
                Hash
              </th>
              <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[--fg-muted] font-normal">
                Author
              </th>
              <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[--fg-muted] font-normal">
                Intent
              </th>
              <th className="text-right px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[--fg-muted] font-normal">
                Ops
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: log entries have no stable id
              <tr key={i} className="border-b border-[--border]/50 hover:bg-[--bg-subtle]">
                <td className="px-3 py-2 font-mono text-[--fg-muted]">
                  {entry.hash ? `${entry.hash.slice(0, 12)}…` : "—"}
                </td>
                <td className="px-3 py-2 text-[--fg]">{entry.author ?? "—"}</td>
                <td className="px-3 py-2 text-[--fg-muted] italic">{entry.intent ?? "—"}</td>
                <td className="px-3 py-2 text-right text-[--fg-muted]">{entry.ops ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function VerifyPage() {
  const qc = useQueryClient();
  const { data: logData } = useLog();
  const logEntries = parseLog(logData);

  // Verify is triggered on demand — not on mount
  const verifyMutation = useMutation({
    mutationFn: () => apiClient.verify(),
    onSuccess: (data) => {
      qc.setQueryData(["verify"], data);
    },
  });

  const report = verifyMutation.data;

  return (
    <div className="space-y-4 max-w-2xl">
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
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[--fg-muted]">
          VERIFICATION
        </span>
      </div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Verify</h2>
        <button
          type="button"
          onClick={() => verifyMutation.mutate()}
          disabled={verifyMutation.isPending}
          className="bg-[--fg] px-4 py-1.5 text-xs font-mono uppercase tracking-wide font-medium text-white hover:opacity-80 disabled:opacity-50 transition-opacity"
          data-testid="verify-run"
        >
          {verifyMutation.isPending ? "Running…" : "Run verification"}
        </button>
      </div>

      {!report && !verifyMutation.isPending && (
        <p className="text-sm text-[--fg-muted]">
          Click "Run verification" to prove the integrity, authorship, and governance of your memory
          graph.
        </p>
      )}

      {verifyMutation.isPending && (
        <div className="space-y-3">
          {["Integrity", "Authorship", "Governance"].map((level) => (
            <div
              key={level}
              className="border border-[--border] bg-[--bg-subtle] p-4 animate-pulse"
            >
              <p className="text-sm text-[--fg-muted]">{level}…</p>
            </div>
          ))}
        </div>
      )}

      {verifyMutation.isError && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          Verification failed:{" "}
          {verifyMutation.error instanceof Error ? verifyMutation.error.message : "Unknown error"}
        </p>
      )}

      {report && <VerifyReport report={report} />}

      <ChangesetTimeline entries={logEntries} />
    </div>
  );
}
