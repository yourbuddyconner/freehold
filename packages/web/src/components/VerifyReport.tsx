import type { VerifyReport as VerifyReportData } from "@freehold/client";
import { CheckCircle, Circle, XCircle } from "lucide-react";
import { cn } from "~/lib/cn";

interface LevelRowProps {
  label: string;
  description: string;
  state: "pending" | "ok" | "degraded" | "loading";
  degradedItems?: { id: string; reason: string }[];
}

function LevelRow({ label, description, state, degradedItems = [] }: LevelRowProps) {
  return (
    <div
      className={cn(
        "border p-4 space-y-2",
        state === "ok" && "border-[var(--color-status-approved)] bg-[#f0fdf4] dark:bg-[#052e16]",
        state === "degraded" && "border-[var(--color-status-held)] bg-[#fffbeb] dark:bg-[#1c1408]",
        (state === "pending" || state === "loading") && "border-[--border] bg-[--bg-subtle]"
      )}
    >
      <div className="flex items-center gap-3">
        {state === "ok" && (
          <CheckCircle
            className="h-5 w-5 shrink-0 text-[var(--color-status-approved)]"
            aria-hidden
          />
        )}
        {state === "degraded" && (
          <XCircle className="h-5 w-5 shrink-0 text-[var(--color-status-held)]" aria-hidden />
        )}
        {(state === "pending" || state === "loading") && (
          <Circle
            className={cn(
              "h-5 w-5 shrink-0 text-[--fg-muted]",
              state === "loading" && "animate-pulse"
            )}
            aria-hidden
          />
        )}
        <div>
          <p
            className={cn(
              "text-sm font-medium",
              state === "ok" && "text-[var(--color-status-approved)]",
              state === "degraded" && "text-[var(--color-status-held)]",
              (state === "pending" || state === "loading") && "text-[--fg-muted]"
            )}
            data-testid={`level-${label.toLowerCase()}`}
          >
            {label}
          </p>
          <p className="text-xs text-[--fg-muted]">{description}</p>
        </div>
      </div>

      {/* Degraded items */}
      {state === "degraded" && degradedItems.length > 0 && (
        <ul className="mt-2 space-y-1 pl-8">
          {degradedItems.map((item) => (
            <li key={item.id} className="text-xs text-[--fg-muted] flex gap-2">
              <a
                href={`/memory/${item.id}`}
                className="font-mono text-[var(--color-status-held)] hover:underline shrink-0"
              >
                {item.id.slice(0, 12)}…
              </a>
              <span>{item.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface VerifyReportProps {
  report: VerifyReportData;
  className?: string;
}

export function VerifyReport({ report, className }: VerifyReportProps) {
  const degraded = report.degraded ?? [];
  const overallOk = report.ok && degraded.length === 0;

  // Derive per-level state.
  // TODO: The API currently returns a flat { ok, degraded[] } with no per-level breakdown.
  // The mapping below is heuristic-only: all degraded items → Integrity, items whose reason
  // includes "evidence" → also flagged on Governance, Authorship is never independently
  // degraded. When the API exposes per-level results, replace these heuristics with the
  // real values from the response.
  const integrityState = !report.ok ? "degraded" : degraded.length > 0 ? "degraded" : "ok";

  return (
    <div className={cn("space-y-3", className)}>
      {/* Summary */}
      <div
        className={cn(
          "border px-4 py-3 text-sm font-medium",
          overallOk
            ? "border-[var(--color-status-approved)] bg-[#f0fdf4] text-[var(--color-status-approved)] dark:bg-[#052e16]"
            : "border-[var(--color-status-held)] bg-[#fffbeb] text-[var(--color-status-held)] dark:bg-[#1c1408]"
        )}
        data-testid="verify-summary"
      >
        {overallOk ? "Graph is healthy." : `Graph has ${degraded.length} degraded item(s).`}
        {report.stateHash && (
          <span className="ml-2 font-mono text-xs opacity-70">
            state: {report.stateHash.slice(0, 16)}…
          </span>
        )}
      </div>

      {/* Level rows */}
      <LevelRow
        label="Integrity"
        description="Changeset hashes form an unbroken chain; no content has been altered."
        state={integrityState}
        degradedItems={degraded}
      />
      <LevelRow
        label="Authorship"
        description="Every changeset carries a verifiable author identity."
        state={report.ok ? "ok" : "degraded"}
      />
      <LevelRow
        label="Governance"
        description="All governed writes carry a decision record signed by the owner."
        state={report.ok ? "ok" : "degraded"}
        degradedItems={degraded.filter((d) => d.reason.toLowerCase().includes("evidence"))}
      />
    </div>
  );
}
