import { Outlet, createRoute, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { MemoryCard } from "~/components/MemoryCard";
import { TaxonomyTree } from "~/components/TaxonomyTree";
import { useRecall, useSchema } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/memory",
  component: MemoryLayout,
});

// Layout wrapper: renders the list page at /memory, or the child route at /memory/$id.
// The <Outlet /> carries child content when a child route (memory.$id) is matched.
// When MemoryRoute is matched exactly (no child active), the Outlet renders nothing
// and MemoryPage fills the view.
function MemoryLayout() {
  const { location } = useRouterState();
  // If the pathname is exactly /memory, render the list. Otherwise render the child route.
  const isExact = location.pathname === "/memory" || location.pathname === "/memory/";
  if (isExact) {
    return <MemoryPage />;
  }
  return <Outlet />;
}

const TYPE_FILTERS = ["entity", "document", "event"] as const;
const STATUS_FILTERS = ["approved", "pending", "rejected"] as const;

const AUTHOR_FILTERS = ["claude-code"] as const;

function MemoryPage() {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [authorFilter, setAuthorFilter] = useState<string | undefined>();

  const filters = {
    type: typeFilter,
    status: statusFilter,
    author: authorFilter,
  };

  const { data, isLoading } = useRecall(query, filters, query.length > 0);
  const { data: schemaData } = useSchema();
  const results = data?.results ?? [];
  const terms = schemaData?.terms ?? [];

  function toggleFilter<T extends string>(
    current: T | undefined,
    value: T,
    set: (v: T | undefined) => void
  ) {
    set(current === value ? undefined : value);
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 3,
            background: "var(--color-accent)",
          }}
          aria-hidden
        />
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
          MEMORY BROWSER
        </span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight mb-4">Memory</h2>

      {/* Search */}
      <div className="mb-4 max-w-xl">
        <input
          type="search"
          aria-label="Search memories"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memories…"
          className="w-full border border-(--border) bg-(--bg-subtle) px-3 py-2 text-sm text-(--fg) placeholder:text-(--fg-muted) focus:outline-none focus:ring-1 focus:ring-(--border)"
        />
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2 mb-6">
        <span className="text-xs text-(--fg-muted) self-center">Type:</span>
        {TYPE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => toggleFilter(typeFilter, f, setTypeFilter)}
            className={`border px-2 py-0.5 font-mono text-[11px] uppercase ${
              typeFilter === f
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
            }`}
          >
            {f}
          </button>
        ))}
        <span className="text-xs text-(--fg-muted) self-center ml-2">Status:</span>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => toggleFilter(statusFilter, f, setStatusFilter)}
            className={`border px-2 py-0.5 font-mono text-[11px] uppercase ${
              statusFilter === f
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
            }`}
          >
            {f}
          </button>
        ))}
        <span className="text-xs text-(--fg-muted) self-center ml-2">Author:</span>
        {AUTHOR_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            data-testid={`author-filter-${f}`}
            onClick={() => toggleFilter(authorFilter, f, setAuthorFilter)}
            className={`border px-2 py-0.5 font-mono text-[11px] uppercase ${
              authorFilter === f
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="flex gap-6">
        {/* Taxonomy sidebar */}
        {terms.length > 0 && (
          <TaxonomyTree
            terms={terms}
            selected={typeFilter}
            onSelect={(t) => toggleFilter(typeFilter, t, setTypeFilter)}
          />
        )}

        {/* Results */}
        <div className="flex-1 min-w-0">
          {query.length === 0 && (
            <div className="border border-(--border) bg-(--bg-subtle) p-6 space-y-3 max-w-xl">
              <p className="text-sm text-(--fg-muted)">
                Search memories above. Agents will surface entities, documents, and events here as
                they work.
              </p>
              <p className="text-sm text-(--fg-muted)">
                Connect an agent via{" "}
                <code className="border border-(--border) bg-(--bg-subtle) px-1 py-0.5 font-mono text-[11px]">
                  freehold mcp setup claude-code
                </code>
              </p>
            </div>
          )}

          {query.length > 0 && isLoading && <p className="text-sm text-(--fg-muted)">Searching…</p>}

          {query.length > 0 && !isLoading && results.length === 0 && (
            <p className="text-sm text-(--fg-muted)">No memories match your search.</p>
          )}

          {results.length > 0 && (
            <ul className="space-y-4 max-w-2xl">
              {results.map((result, index) => (
                <li key={result.id} className={`reveal reveal-${(index % 6) + 1}`}>
                  <MemoryCard result={result} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
