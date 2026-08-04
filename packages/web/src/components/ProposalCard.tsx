import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "~/lib/cn";
import { DiffView } from "./DiffView";

interface DiffEntry {
  key: string;
  before?: unknown;
  after?: unknown;
}

interface SchemaProposalMeta {
  name?: string;
  extends?: string;
  definition?: string;
}

interface Proposal {
  hash: string;
  agent: string;
  intent: string;
  summary: string;
  rules: string[];
  diff: DiffEntry[];
  isSchemaProposal: boolean;
}

interface ProposalCardProps {
  proposal: Proposal;
  onApprove: () => void;
  onReject: () => void;
  isApproving?: boolean;
  isRejecting?: boolean;
}

function AgentMark({ agent }: { agent: string }) {
  const initials = agent.slice(0, 2).toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center bg-(--bg-subtle) border border-(--border) text-[11px] font-bold text-(--fg) font-mono"
    >
      {initials}
    </span>
  );
}

function parseSchemaProposalMeta(diff: DiffEntry[]): SchemaProposalMeta | null {
  // For a schema proposal, the first diff entry typically contains the schema create op
  // with the entity type name as the key and a definition structure as the value
  for (const entry of diff) {
    if (entry.after && typeof entry.after === "object" && !Array.isArray(entry.after)) {
      // The key is the entity type name
      const obj = entry.after as Record<string, unknown>;
      // Look for attributes or definition field
      if (obj.attributes || obj.extends || typeof obj === "object") {
        return {
          name: entry.key,
          extends: "extends" in obj && typeof obj.extends === "string" ? obj.extends : undefined,
          definition:
            "attributes" in obj && typeof obj.attributes === "object" && obj.attributes !== null
              ? JSON.stringify(obj.attributes, null, 2)
              : undefined,
        };
      }
    }
  }
  return null;
}

function SchemaTypeDefinition({ meta }: { meta: SchemaProposalMeta }) {
  if (!meta.name) return null;

  let attributes: Record<string, unknown> = {};

  // Try to extract attributes from the definition JSON or from structured data
  if (meta.definition) {
    try {
      const parsed = JSON.parse(meta.definition);
      if (typeof parsed === "object" && parsed !== null) {
        attributes = parsed;
      }
    } catch {
      // If not JSON, treat as plain string attributes
      attributes = {};
    }
  }

  return (
    <div className="border border-(--border) bg-(--bg-subtle) p-3 space-y-2 font-mono text-[11px]">
      <div className="text-(--fg-muted)">Type definition:</div>
      <div className="pl-2 space-y-1.5">
        <div className="text-(--fg)">
          <span className="font-semibold">{meta.name}</span>
          {meta.extends && (
            <>
              <span className="text-(--fg-muted)"> extends </span>
              <span>{meta.extends}</span>
            </>
          )}
        </div>
        {Object.keys(attributes).length > 0 ? (
          <table className="w-full text-[10px] border-collapse ml-2">
            <tbody>
              {Object.entries(attributes).map(([key, value]) => (
                <tr key={key} className="border-b border-(--border) border-opacity-30">
                  <td className="py-0.5 pr-2 text-(--fg-muted)">{key}:</td>
                  <td className="py-0.5 text-(--fg)">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-(--fg-muted) pl-2">No attributes defined</div>
        )}
      </div>
    </div>
  );
}

export function ProposalCard({
  proposal,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
}: ProposalCardProps) {
  const { hash, agent, intent, summary, rules, diff, isSchemaProposal } = proposal;
  const schemaMeta = isSchemaProposal ? parseSchemaProposalMeta(diff) : null;

  return (
    <article
      className={cn(
        "reg-marks relative border p-4 space-y-3 bg-(--bg-subtle)",
        isSchemaProposal ? "pending-border bg-[#fffbeb] dark:bg-[#1c1408]" : "border-(--border)"
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <AgentMark agent={agent} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-(--fg)">{agent}</span>
            <span className="text-xs text-(--fg-muted)">·</span>
            <span className="text-xs text-(--fg-muted) italic">{intent}</span>
            {isSchemaProposal && (
              <span
                data-testid="schema-badge"
                className="inline-flex items-center border border-amber-400 bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 text-[10px] font-mono uppercase text-amber-700 dark:text-amber-300"
              >
                Schema proposal
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Summary */}
      <p className="text-sm text-(--fg) leading-relaxed">{summary}</p>

      {/* Rules */}
      {rules.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="rules-row">
          {rules.map((rule) => (
            <span
              key={rule}
              className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] text-(--fg-muted)"
            >
              {rule}
            </span>
          ))}
        </div>
      )}

      {/* Schema type definition preview */}
      {schemaMeta && <SchemaTypeDefinition meta={schemaMeta} data-testid="schema-definition" />}

      {/* Diff */}
      <DiffView diff={diff} />

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        {/* Approve — opens a confirmation dialog */}
        <Dialog.Root>
          <Dialog.Trigger asChild>
            <button
              type="button"
              disabled={isApproving || isRejecting}
              className="bg-(--fg) text-white font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 disabled:opacity-50 transition-opacity"
            >
              {isApproving ? "Approving…" : "Approve"}
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm bg-white dark:bg-neutral-900 border border-(--border) p-6 shadow-none space-y-4">
              <Dialog.Title className="text-base font-semibold text-(--fg)">
                Approve proposal
              </Dialog.Title>
              <Dialog.Description className="text-sm text-(--fg-muted)">
                This signs a decision record with your key.
              </Dialog.Description>
              <div className="flex gap-2 justify-end">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="border border-(--border) text-(--fg-muted) font-mono text-[12px] uppercase px-3 py-1.5 hover:text-(--fg) transition-colors"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    onClick={onApprove}
                    className="bg-(--fg) text-white font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 transition-opacity"
                  >
                    Approve
                  </button>
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        {/* Reject — direct action */}
        <button
          type="button"
          onClick={onReject}
          disabled={isApproving || isRejecting}
          className="border border-(--border) font-mono text-[12px] uppercase tracking-wide px-3 py-1.5 text-(--fg-muted) hover:text-(--fg) disabled:opacity-50 transition-colors"
        >
          {isRejecting ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {/* Suppress unused hash warning — hash is the React key used by parent */}
      <span className="sr-only">{hash}</span>
      <span className="reg-mark-bl" aria-hidden />
      <span className="reg-mark-br" aria-hidden />
    </article>
  );
}
