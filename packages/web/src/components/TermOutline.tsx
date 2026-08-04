import { useState } from "react";
import { cn } from "~/lib/cn";

interface Term {
  name: string;
  parent?: string;
}

interface TermOutlineProps {
  terms: Term[];
  /** Policy rule names keyed to the term names they apply to. */
  rulesByTerm?: Record<string, string[]>;
  /** Pending schema proposals (term names). */
  pendingTerms?: string[];
  className?: string;
}

/**
 * Build a parent→children map for all terms. A term can appear under
 * multiple parents (DAG, not tree). We render the term under each parent,
 * with a "also under: X, Y" note when multi-parented.
 */
function buildChildrenMap(terms: Term[]): Map<string | null, Term[]> {
  const map = new Map<string | null, Term[]>();
  for (const term of terms) {
    const key = term.parent ?? null;
    const list = map.get(key) ?? [];
    list.push(term);
    map.set(key, list);
  }
  return map;
}

/** All parents for a given term name. */
function parentsOf(termName: string, terms: Term[]): string[] {
  return terms.filter((t) => t.name === termName && t.parent).map((t) => t.parent as string);
}

interface TermNodeProps {
  term: Term;
  terms: Term[];
  childrenMap: Map<string | null, Term[]>;
  rulesByTerm: Record<string, string[]>;
  pendingTerms: string[];
  depth: number;
}

function TermNode({ term, terms, childrenMap, rulesByTerm, pendingTerms, depth }: TermNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const children = childrenMap.get(term.name) ?? [];
  const allParents = parentsOf(term.name, terms);
  const otherParents = allParents.filter((p) => p !== term.parent);
  const rules = rulesByTerm[term.name] ?? [];
  const isPending = pendingTerms.includes(term.name);

  return (
    <div className={cn(depth > 0 && "pl-4 border-l border-(--border) ml-2")}>
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 py-1",
          isPending && "text-amber-700 dark:text-amber-300"
        )}
      >
        {/* Expand/collapse toggle */}
        {children.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-(--fg-muted) hover:text-(--fg) text-xs w-3 shrink-0"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        <span
          className={cn(
            "text-sm font-medium",
            isPending ? "text-amber-700 dark:text-amber-300" : "text-(--fg)"
          )}
          data-testid={`term-${term.name}`}
        >
          {term.name}
        </span>

        {isPending && (
          <span className="rounded border border-amber-400 bg-amber-100 dark:bg-amber-900 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            Pending
          </span>
        )}

        {/* Multi-parent DAG link-back */}
        {otherParents.length > 0 && (
          <span className="text-[11px] text-(--fg-muted)">
            also under: {otherParents.join(", ")}
          </span>
        )}

        {/* Policy rule links */}
        {rules.map((rule) => (
          <span
            key={rule}
            className="rounded border border-(--border) bg-(--bg-subtle) px-1 py-0.5 text-[10px] text-(--fg-muted) font-mono"
          >
            {rule}
          </span>
        ))}
      </div>

      {expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TermNode
              key={`${child.name}-under-${term.name}`}
              term={child}
              terms={terms}
              childrenMap={childrenMap}
              rulesByTerm={rulesByTerm}
              pendingTerms={pendingTerms}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TermOutline({
  terms,
  rulesByTerm = {},
  pendingTerms = [],
  className,
}: TermOutlineProps) {
  const childrenMap = buildChildrenMap(terms);
  const roots = childrenMap.get(null) ?? [];

  if (terms.length === 0) {
    return (
      <div className={cn("rounded-lg border border-(--border) bg-(--bg-subtle) p-6", className)}>
        <p className="text-sm text-(--fg-muted)">No taxonomy terms defined.</p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-0.5", className)}>
      {roots.map((term) => (
        <TermNode
          key={term.name}
          term={term}
          terms={terms}
          childrenMap={childrenMap}
          rulesByTerm={rulesByTerm}
          pendingTerms={pendingTerms}
          depth={0}
        />
      ))}
    </div>
  );
}
