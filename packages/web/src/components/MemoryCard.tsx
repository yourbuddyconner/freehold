import { Link } from "@tanstack/react-router";
import { ProvenanceFooter } from "~/components/ProvenanceFooter";
import type { StatusKind } from "~/components/StatusChip";

interface RecallResult {
  id: string;
  type: string;
  content?: unknown;
  author: string;
  // `method` is the provenance method from the indexed object, or null for unrecorded
  method: string | null;
  // `approval` is the raw value from the index: "saved", "pending", "rejected", etc.
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
  if (approval === "saved") return "approved";
  if (approval === "pending") return "pending";
  if (approval === "rejected") return "rejected";
  return undefined;
}

/** Human-readable label for the approval status from the index. */
function approvalToLabel(approval: string): string {
  if (approval === "saved") return "Saved";
  if (approval === "pending") return "Pending";
  if (approval === "rejected") return "Rejected";
  return approval;
}

export function MemoryCard({ result }: MemoryCardProps) {
  const { id, type, content, author, method, approval, changeset } = result;
  const text = renderContent(content);

  // Format method for display: null → "unrecorded"
  const methodLabel = method ?? "unrecorded";

  return (
    <article className="reg-marks relative border border-[--border] bg-[--bg-subtle] p-4 space-y-3">
      {/* Type chip */}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center border border-[--border] px-1.5 py-0.5 text-[11px] font-medium font-mono text-[--fg-muted]">
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
      {text && <p className="text-sm text-[--fg] leading-relaxed line-clamp-4">{text}</p>}

      {/* Provenance — shows REAL method from the indexed object, or "unrecorded" when absent */}
      <ProvenanceFooter
        author={author}
        method={methodLabel}
        approvalLabel={approvalToLabel(approval)}
        approvalStatus={approvalToStatus(approval)}
        changesetHash={changeset}
      />
      <span className="reg-mark-bl" aria-hidden />
      <span className="reg-mark-br" aria-hidden />
    </article>
  );
}
