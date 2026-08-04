import { useState } from "react";
import { cn } from "~/lib/cn";

interface DiffEntry {
  key: string;
  before?: unknown;
  after?: unknown;
}

interface DiffViewProps {
  diff: DiffEntry[];
  className?: string;
}

function stringify(val: unknown): string {
  if (typeof val === "string") return val;
  return JSON.stringify(val, null, 2);
}

export function DiffView({ diff, className }: DiffViewProps) {
  const [open, setOpen] = useState(false);

  if (diff.length === 0) return null;

  return (
    <div className={cn("text-xs", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-[--fg-muted] hover:text-[--fg] underline underline-offset-2 transition-colors"
      >
        {open ? "Hide diff" : "Show diff"}
      </button>
      {open && (
        <div className="mt-2 rounded border border-[--border] bg-[--bg-subtle] p-3 space-y-2 font-mono text-[11px]">
          {diff.map((entry) => {
            const isAdded = entry.after !== undefined && entry.before === undefined;

            return (
              <div key={entry.key} className="space-y-0.5">
                <span className="text-[--fg-muted]">{entry.key}:</span>
                {entry.before !== undefined && (
                  <div className="pl-2 line-through text-[--fg-muted]">
                    {stringify(entry.before)}
                  </div>
                )}
                {entry.after !== undefined && (
                  <div
                    className={cn(
                      "pl-2",
                      isAdded
                        ? "text-green-700 dark:text-green-400"
                        : "text-amber-700 dark:text-amber-400"
                    )}
                  >
                    {stringify(entry.after)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
