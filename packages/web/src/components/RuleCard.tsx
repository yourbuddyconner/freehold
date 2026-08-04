import { cn } from "~/lib/cn";

export interface PolicyRule {
  id: string;
  /** Human-readable title. */
  title: string;
  /** Selector expression (YAML/CEL/similar). */
  selector?: string;
  /** Require expression. */
  require?: string;
  /** Raw YAML text for the rule. */
  raw?: string;
}

interface RuleCardProps {
  rule: PolicyRule;
  onEdit?: () => void;
  className?: string;
}

export function RuleCard({ rule, onEdit, className }: RuleCardProps) {
  return (
    <article className={cn("border border-[--border] bg-[--bg-subtle] p-4 space-y-3", className)}>
      {/* Title row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-[--fg]" data-testid="rule-title">
            {rule.title}
          </h3>
          <p className="text-xs text-[--fg-muted] font-mono mt-0.5">{rule.id}</p>
        </div>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 border border-[--border] font-mono text-[12px] uppercase px-2.5 py-1 text-[--fg-muted] hover:text-[--fg] transition-colors"
            data-testid={`edit-rule-${rule.id}`}
          >
            › Edit
          </button>
        )}
      </div>

      {/* Selector / require mono block */}
      {(rule.selector || rule.require) && (
        <div className="border border-[--border] bg-white dark:bg-neutral-900 p-3 font-mono text-[11px] space-y-1">
          {rule.selector && (
            <div>
              <span className="text-[--fg-muted]">selector: </span>
              <span className="text-[--fg]" data-testid="rule-selector">
                {rule.selector}
              </span>
            </div>
          )}
          {rule.require && (
            <div>
              <span className="text-[--fg-muted]">require: </span>
              <span className="text-[--fg]" data-testid="rule-require">
                {rule.require}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Recent applications — not exposed per-rule by the API.
          TODO: expose per-rule application counts in GET /api/v1/log so we can
          populate this list; for now we omit the section rather than fabricate data. */}
    </article>
  );
}
