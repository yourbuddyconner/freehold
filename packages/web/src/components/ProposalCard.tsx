import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "~/lib/cn";
import { DiffView } from "./DiffView";

interface DiffEntry {
  key: string;
  before?: unknown;
  after?: unknown;
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
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-200 dark:bg-neutral-700 text-[11px] font-bold text-[--fg] font-mono"
    >
      {initials}
    </span>
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

  return (
    <article
      className={cn(
        "rounded-lg border p-4 space-y-3 bg-[--bg-subtle]",
        isSchemaProposal ? "border-amber-400 bg-amber-50 dark:bg-amber-900/30" : "border-[--border]"
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <AgentMark agent={agent} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[--fg]">{agent}</span>
            <span className="text-xs text-[--fg-muted]">·</span>
            <span className="text-xs text-[--fg-muted] italic">{intent}</span>
            {isSchemaProposal && (
              <span
                data-testid="schema-badge"
                className="inline-flex items-center rounded border border-amber-400 bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
              >
                Schema proposal
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Summary */}
      <p className="text-sm text-[--fg] font-serif leading-relaxed">{summary}</p>

      {/* Rules */}
      {rules.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="rules-row">
          {rules.map((rule) => (
            <span
              key={rule}
              className="inline-flex items-center rounded border border-[--border] bg-[--bg-subtle] px-1.5 py-0.5 text-[11px] text-[--fg-muted]"
            >
              {rule}
            </span>
          ))}
        </div>
      )}

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
              className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              {isApproving ? "Approving…" : "Approve"}
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-lg bg-white dark:bg-neutral-900 border border-[--border] p-6 shadow-xl space-y-4">
              <Dialog.Title className="text-base font-semibold text-[--fg]">
                Approve proposal
              </Dialog.Title>
              <Dialog.Description className="text-sm text-[--fg-muted]">
                This signs a decision record with your key.
              </Dialog.Description>
              <div className="flex gap-2 justify-end">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded border border-[--border] px-3 py-1.5 text-xs font-medium text-[--fg] hover:bg-[--bg-subtle] transition-colors"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    onClick={onApprove}
                    className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 transition-colors"
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
          className="rounded border border-[--border] px-3 py-1.5 text-xs font-medium text-[--fg-muted] hover:text-[--fg] hover:bg-[--bg-subtle] disabled:opacity-50 transition-colors"
        >
          {isRejecting ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {/* Suppress unused hash warning — hash is the React key used by parent */}
      <span className="sr-only">{hash}</span>
    </article>
  );
}
