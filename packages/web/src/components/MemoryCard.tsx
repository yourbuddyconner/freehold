import { ProvenanceFooter } from "~/components/ProvenanceFooter";

interface RecallResult {
  id: string;
  type: string;
  content?: unknown;
  author: string;
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
        <a
          href={`/memory/${id}`}
          className="text-xs text-[--fg-muted] hover:text-[--fg] underline underline-offset-2 transition-colors"
        >
          View detail →
        </a>
      </div>

      {/* Content */}
      {text && (
        <p className="text-sm text-[--fg] font-serif leading-relaxed line-clamp-4">{text}</p>
      )}

      {/* Provenance */}
      <ProvenanceFooter
        author={author}
        method="agent"
        approvalLabel={approval}
        changesetHash={changeset}
      />
    </article>
  );
}
