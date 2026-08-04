import { useState } from "react";
import { cn } from "~/lib/cn";

interface ProvenanceFooterProps {
  /** Which agent or human authored this memory. */
  author: string;
  /** `manual` | `model-assisted` + optional tool name. */
  method: string;
  /** Approval status label (e.g. "Approved", "Held", "Pending"). */
  approvalLabel: string;
  /** Full changeset hash (hex or similar). Displayed truncated; click to copy. */
  changesetHash: string;
  className?: string;
}

export function ProvenanceFooter({
  author,
  method,
  approvalLabel,
  changesetHash,
  className,
}: ProvenanceFooterProps) {
  const [copied, setCopied] = useState(false);

  const truncated = changesetHash.length > 12 ? `${changesetHash.slice(0, 12)}…` : changesetHash;

  function handleCopy() {
    navigator.clipboard.writeText(changesetHash).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <footer
      className={cn(
        "flex flex-wrap items-center gap-2 pt-2 mt-2 border-t border-[--border] text-xs text-[--fg-muted]",
        className
      )}
    >
      {/* Author chip */}
      <span className="inline-flex items-center gap-1 rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 font-medium">
        <span data-testid="provenance-author">{author}</span>
      </span>

      {/* Method chip */}
      <span className="inline-flex items-center gap-1 rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5">
        <span data-testid="provenance-method">{method}</span>
      </span>

      {/* Approval badge */}
      <span
        data-testid="provenance-approval"
        className="inline-flex items-center rounded bg-green-100 text-green-700 dark:bg-green-700/20 dark:text-green-400 px-1.5 py-0.5 font-medium"
      >
        {approvalLabel}
      </span>

      {/* Changeset hash — mono, truncated, copy-on-click */}
      <button
        type="button"
        onClick={handleCopy}
        data-testid="provenance-hash"
        title={changesetHash}
        className="font-mono rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors cursor-pointer"
      >
        {copied ? "Copied!" : truncated}
      </button>
    </footer>
  );
}
