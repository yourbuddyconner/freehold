import { cn } from "~/lib/cn";

export interface Principal {
  id: string;
  name?: string;
  kind?: "owner" | "agent" | "human";
  fingerprint?: string;
  status?: "active" | "revoked";
}

interface PrincipalCardProps {
  principal: Principal;
  onRevoke?: () => void;
  className?: string;
}

const KIND_LABELS: Record<string, string> = {
  owner: "Owner",
  agent: "Agent",
  human: "Human",
};

export function PrincipalCard({ principal, onRevoke, className }: PrincipalCardProps) {
  const isRevoked = principal.status === "revoked";

  return (
    <article
      className={cn(
        "rounded-lg border p-4 space-y-2",
        isRevoked
          ? "border-[--border] opacity-60 bg-[--bg-subtle]"
          : "border-[--border] bg-[--bg-subtle]",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[--fg]" data-testid="principal-name">
              {principal.name ?? principal.id}
            </span>
            {principal.kind && (
              <span className="rounded border border-[--border] px-1.5 py-0.5 text-[10px] font-medium text-[--fg-muted]">
                {KIND_LABELS[principal.kind] ?? principal.kind}
              </span>
            )}
            {isRevoked && (
              <span className="rounded border border-red-300 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                Revoked
              </span>
            )}
          </div>
          {principal.fingerprint && (
            <p
              className="text-[11px] font-mono text-[--fg-muted]"
              data-testid="principal-fingerprint"
            >
              {principal.fingerprint}
            </p>
          )}
        </div>

        {!isRevoked && onRevoke && (
          <button
            type="button"
            onClick={onRevoke}
            className="shrink-0 rounded border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            data-testid={`revoke-${principal.id}`}
          >
            Revoke
          </button>
        )}
      </div>
    </article>
  );
}
