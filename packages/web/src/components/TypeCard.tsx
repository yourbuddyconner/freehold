import { cn } from "~/lib/cn";
import { ProvenanceFooter } from "./ProvenanceFooter";

interface Attribute {
  name: string;
  type?: string;
  required?: boolean;
}

interface TypeCardProps {
  name: string;
  version?: string;
  pkg?: string;
  /** Parent chain, nearest first: ["Colleague", "core/Person"] */
  extends?: string;
  attributes?: Attribute[];
  /** When set, this type was added by an agent — show provenance footer. */
  provenance?: {
    agent: string;
    method: string;
    changeset: string;
  };
  /** When set, renders the card in amber (pending proposal). */
  pending?: boolean;
  className?: string;
}

export function TypeCard({
  name,
  version,
  pkg,
  extends: ext,
  attributes = [],
  provenance,
  pending = false,
  className,
}: TypeCardProps) {
  return (
    <article
      className={cn(
        "reg-marks relative border p-4 space-y-3 bg-[--bg-subtle]",
        pending ? "pending-border bg-[#fffbeb] dark:bg-[#1c1408]" : "border-[--border]",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          {/* Breadcrumb: name ← parent */}
          <div className="flex flex-wrap items-center gap-1 text-sm font-medium text-[--fg]">
            <span data-testid="type-name">{name}</span>
            {ext && (
              <>
                <span className="text-[--fg-muted]" aria-label="extends">
                  ←
                </span>
                <span className="text-[--fg-muted] text-xs">{ext}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-[--fg-muted]">
            {pkg && <span className="font-mono">{pkg}</span>}
            {version && (
              <span className="border border-[--border] px-1 py-0.5 font-mono">v{version}</span>
            )}
          </div>
        </div>
        {pending && (
          <span className="shrink-0 border border-amber-400 bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 text-[10px] font-mono uppercase text-amber-700 dark:text-amber-300">
            Pending
          </span>
        )}
      </div>

      {/* Attributes table */}
      {attributes.length > 0 ? (
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-[--border]">
              <th className="text-left py-1 pr-3 text-[--fg-muted] font-mono text-[10px] uppercase tracking-[0.08em] font-normal">
                Attribute
              </th>
              <th className="text-left py-1 pr-3 text-[--fg-muted] font-mono text-[10px] uppercase tracking-[0.08em] font-normal">
                Type
              </th>
              <th className="text-left py-1 text-[--fg-muted] font-mono text-[10px] uppercase tracking-[0.08em] font-normal">
                Required
              </th>
            </tr>
          </thead>
          <tbody>
            {attributes.map((attr) => (
              <tr key={attr.name} className="border-b border-[--border]/50">
                <td className="py-1 pr-3 font-mono text-[--fg]">{attr.name}</td>
                <td className="py-1 pr-3 font-mono text-[--fg-muted]">{attr.type ?? "any"}</td>
                <td className="py-1 text-[--fg-muted]">{attr.required ? "yes" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-[--fg-muted]">No attributes defined</p>
      )}

      {/* Agent provenance */}
      {provenance && (
        <ProvenanceFooter
          author={provenance.agent}
          method={provenance.method}
          approvalLabel="Approved"
          approvalStatus="approved"
          changesetHash={provenance.changeset}
        />
      )}
      <span className="reg-mark-bl" aria-hidden />
      <span className="reg-mark-br" aria-hidden />
    </article>
  );
}
