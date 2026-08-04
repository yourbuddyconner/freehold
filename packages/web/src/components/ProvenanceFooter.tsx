import { useState } from "react";
import { cn } from "~/lib/cn";
import { StatusChip, type StatusKind } from "./StatusChip";

interface ProvenanceFooterProps {
  /** Which agent or human authored this memory. */
  author: string;
  /** `manual` | `model-assisted` + optional tool name. */
  method: string;
  /** Approval status label (e.g. "Approved", "Held", "Pending"). */
  approvalLabel: string;
  /** StatusKind for the approval badge — drives the colour via StatusChip. */
  approvalStatus?: StatusKind;
  /** Optional href linking the approval badge to the decision record. */
  evidenceHref?: string;
  /** Full changeset hash (hex or similar). Displayed truncated; click to copy. Optional — omit when not yet known. */
  changesetHash?: string;
  className?: string;
}

export function ProvenanceFooter({
  author,
  method,
  approvalLabel,
  approvalStatus,
  evidenceHref,
  changesetHash,
  className,
}: ProvenanceFooterProps) {
  const [copied, setCopied] = useState(false);

  const hash = changesetHash ?? "";
  const truncated = hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;

  function handleCopy() {
    if (!hash) return;
    navigator.clipboard.writeText(hash).then(() => {
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

      {/* Approval badge — uses StatusChip so colour follows the status palette */}
      <span data-testid="provenance-approval">
        {approvalStatus ? (
          <StatusChip status={approvalStatus} href={evidenceHref} label={approvalLabel} />
        ) : (
          <span className="inline-flex items-center rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 font-medium">
            {approvalLabel}
          </span>
        )}
      </span>

      {/* Changeset hash — mono, truncated, copy-on-click (only shown when a hash is available) */}
      {hash && (
        <button
          type="button"
          onClick={handleCopy}
          data-testid="provenance-hash"
          title={hash}
          className="font-mono rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors cursor-pointer"
        >
          {copied ? "Copied!" : truncated}
        </button>
      )}
    </footer>
  );
}
