interface Revision {
  hash: string;
  timestamp?: string;
}

interface LineageTrailProps {
  revisions: Revision[];
}

export function LineageTrail({ revisions }: LineageTrailProps) {
  if (revisions.length === 0) {
    return <p className="text-xs text-[--fg-muted] italic">No revision history.</p>;
  }

  return (
    <ol className="relative space-y-0">
      {revisions.map((rev, idx) => (
        <li key={rev.hash} className="flex items-start gap-3 relative">
          {/* Vertical connector */}
          <div className="flex flex-col items-center">
            <span className="mt-1 h-2 w-2 rounded-full bg-[--fg-muted] shrink-0" />
            {idx < revisions.length - 1 && (
              <span className="w-px flex-1 bg-[--border] min-h-[1.5rem]" />
            )}
          </div>
          <div className="pb-4 min-w-0">
            <div className="flex items-center gap-2">
              <code className="font-mono text-[11px] text-[--fg]">
                {rev.hash.length > 12 ? `${rev.hash.slice(0, 12)}…` : rev.hash}
              </code>
              {idx === 0 && (
                <span className="text-[10px] font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 rounded px-1">
                  Latest
                </span>
              )}
            </div>
            {rev.timestamp && (
              <p className="text-[11px] text-[--fg-muted] mt-0.5">{rev.timestamp}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
