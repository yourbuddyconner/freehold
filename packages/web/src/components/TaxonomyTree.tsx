import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/cn";

interface Term {
  name: string;
  parent?: string;
}

interface TaxonomyTreeProps {
  terms: Term[];
  selected?: string;
  onSelect: (t: string) => void;
}

export function TaxonomyTree({ terms, selected, onSelect }: TaxonomyTreeProps) {
  const [collapsed, setCollapsed] = useState(false);

  const termNames = new Set(terms.map((t) => t.name));
  const roots = terms.filter((t) => !t.parent || !termNames.has(t.parent));
  const childrenOf = (parentName: string) => terms.filter((t) => t.parent === parentName);

  function TermChip({ term }: { term: Term }) {
    const isSelected = selected === term.name;
    const kids = childrenOf(term.name);
    return (
      <div>
        <button
          type="button"
          onClick={() => onSelect(term.name)}
          className={cn(
            "w-full text-left rounded px-2 py-1 text-xs transition-colors",
            isSelected
              ? "bg-(--border) text-(--fg) font-medium"
              : "text-(--fg-muted) hover:text-(--fg) hover:bg-(--bg-subtle)"
          )}
        >
          {term.name}
        </button>
        {kids.length > 0 && (
          <div className="pl-3 border-l border-(--border) ml-2 mt-0.5 space-y-0.5">
            {kids.map((kid) => (
              <TermChip key={kid.name} term={kid} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center py-4">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand taxonomy"
          className="text-(--fg-muted) hover:text-(--fg) transition-colors"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <aside className="w-44 shrink-0 border-r border-(--border) pr-2 space-y-1">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-(--fg-muted) uppercase tracking-wide">
          Taxonomy
        </h3>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse taxonomy"
          className="text-(--fg-muted) hover:text-(--fg) transition-colors"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="space-y-0.5">
        {roots.map((term) => (
          <TermChip key={term.name} term={term} />
        ))}
        {terms.length === 0 && <p className="text-xs text-(--fg-muted) italic">No terms</p>}
      </div>
    </aside>
  );
}
