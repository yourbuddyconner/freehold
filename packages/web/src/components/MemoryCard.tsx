import { Link } from "@tanstack/react-router";
import { ProvenanceFooter } from "~/components/ProvenanceFooter";
import type { StatusKind } from "~/components/StatusChip";

interface RecallResult {
  id: string;
  type: string;
  content?: unknown;
  author: string;
  // `approval` is the raw value from the index: "admitted", "held", "rejected", etc.
  approval: string;
  changeset: string;
  score: number;
}

interface MemoryCardProps {
  result: RecallResult;
}

function renderContent(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

/** Map the raw indexed approval string to a StatusKind for the StatusChip colour coding. */
function approvalToStatus(approval: string): StatusKind | undefined {
  if (approval === "admitted") return "approved";
  if (approval === "held") return "held";
  if (approval === "rejected") return "rejected";
  return undefined;
}

/** Human-readable label for the approval status from the index. */
function approvalToLabel(approval: string): string {
  if (approval === "admitted") return "Approved";
  if (approval === "held") return "Held";
  if (approval === "rejected") return "Rejected";
  return approval;
}

export function MemoryCard({ result }: MemoryCardProps) {
  const { id, type, content, author, approval, changeset } = result;
  const text = renderContent(content);

  return (
    <article className="rounded-lg border border-[--border] bg-[--bg-subtle] p-4 space-y-3">
      {/* Type chip */}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center rounded border border-[--border] px-1.5 py-0.5 text-[11px] font-medium font-mono text-[--fg-muted]">
          {type}
        </span>
        <Link
          to="/memory/$id"
          params={{ id }}
          className="text-xs text-[--fg-muted] hover:text-[--fg] underline underline-offset-2 transition-colors"
        >
          View detail →
        </Link>
      </div>

      {/* Content */}
      {text && (
        <p className="text-sm text-[--fg] font-serif leading-relaxed line-clamp-4">{text}</p>
      )}

      {/* Provenance — shows REAL approval status from the indexed data, not hardcoded */}
      <ProvenanceFooter
        author={author}
        method="agent"
        approvalLabel={approvalToLabel(approval)}
        approvalStatus={approvalToStatus(approval)}
        changesetHash={changeset}
      />
    </article>
  );
}
