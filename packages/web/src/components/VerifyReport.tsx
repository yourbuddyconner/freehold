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
        "rounded-lg border p-4 space-y-2",
        state === "ok" && "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30",
        state === "degraded" &&
          "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
        (state === "pending" || state === "loading") && "border-[--border] bg-[--bg-subtle]"
      )}
    >
      <div className="flex items-center gap-3">
        {state === "ok" && (
          <CheckCircle
            className="h-5 w-5 shrink-0 text-green-600 dark:text-green-400"
            aria-hidden
          />
        )}
        {state === "degraded" && (
          <XCircle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
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
              state === "ok" && "text-green-800 dark:text-green-200",
              state === "degraded" && "text-amber-800 dark:text-amber-200",
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
                className="font-mono text-amber-700 dark:text-amber-300 hover:underline shrink-0"
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
  // The API returns a flat ok + degraded list; we map all degraded items
  // to the "integrity" level since they relate to graph state.
  const integrityState = !report.ok ? "degraded" : degraded.length > 0 ? "degraded" : "ok";

  return (
    <div className={cn("space-y-3", className)}>
      {/* Summary */}
      <div
        className={cn(
          "rounded border px-4 py-3 text-sm font-medium",
          overallOk
            ? "border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200"
            : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
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
