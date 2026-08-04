import { Link, Outlet, createRoute, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { MemoryTree } from "~/components/MemoryTree";
import { useMemoryIndex, usePrincipals, useRecall } from "~/lib/hooks";
import { buildMemoryTree } from "~/lib/memoryTree";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/memory",
  component: MemoryLayout,
});

/** Compact display line for a recall result's content jsonb. */
function resultTitle(content: unknown): string {
  if (typeof content === "string") return content.split("\n")[0];
  const c = (content ?? {}) as Record<string, unknown>;
  const attrs = (c.attributes ?? c) as Record<string, unknown>;
  for (const key of ["title", "name", "statement", "content"]) {
    const v = attrs[key];
    if (typeof v === "string" && v.trim())
      return v
        .trim()
        .split("\n")[0]
        .replace(/^#+\s*/, "");
  }
  return JSON.stringify(content ?? "").slice(0, 60);
}

/**
 * Two-pane memory workspace. The left pane (search + tree) stays mounted
 * across navigation; the right pane renders the child route, or the
 * resting state at exactly /memory.
 */
function MemoryLayout() {
  const { location } = useRouterState();
  const pathname = location.pathname;
  const isExact = pathname === "/memory" || pathname === "/memory/";
  const idMatch = pathname.match(/^\/memory\/([^/]+)\/?$/);
  const activeId = idMatch && idMatch[1] !== "graph" ? idMatch[1] : undefined;

  const [query, setQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState<string | undefined>();
  const searching = query.length > 0;

  const { data: indexData, isLoading: indexLoading } = useMemoryIndex();
  const { data: searchData, isLoading: searchLoading } = useRecall(
    query,
    { author: authorFilter },
    searching
  );
  const { data: principalsData } = usePrincipals();

  const entries = indexData?.results ?? [];
  const folders = buildMemoryTree(entries);
  const results = searchData?.results ?? [];
  const authors = (
    (principalsData as { principals?: Array<{ name: string; kind: string }> } | undefined)
      ?.principals ?? []
  )
    .filter((p) => p.kind === "agent")
    .map((p) => p.name);

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
          MEMORY WORKSPACE
        </span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight mb-4">Memory</h2>

      <div className="flex gap-6 items-start">
        {/* Left pane: search + tree, always mounted */}
        <aside className="w-72 shrink-0 border-r border-(--border) pr-4 space-y-3">
          <input
            type="search"
            aria-label="Search memories"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memories…"
            className="w-full border border-(--border) bg-(--bg-subtle) px-2.5 py-1.5 text-sm text-(--fg) placeholder:text-(--fg-muted) focus:outline-none focus:ring-1 focus:ring-(--border)"
          />

          {searching ? (
            <div className="space-y-2">
              {authors.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {authors.map((a) => (
                    <button
                      key={a}
                      type="button"
                      data-testid={`author-filter-${a}`}
                      onClick={() => setAuthorFilter(authorFilter === a ? undefined : a)}
                      className={`border px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                        authorFilter === a
                          ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                          : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              )}

              {searchLoading && <p className="text-xs text-(--fg-muted)">Searching…</p>}
              {!searchLoading && results.length === 0 && (
                <p className="text-xs text-(--fg-muted)">No memories match your search.</p>
              )}
              <ul className="space-y-0.5">
                {results.map((r) => (
                  <li key={r.id}>
                    <Link
                      to="/memory/$id"
                      params={{ id: r.id }}
                      data-testid={`search-result-${r.id}`}
                      className="block px-1.5 py-1.5 text-xs text-(--fg-muted) hover:bg-(--bg-subtle) hover:text-(--fg)"
                    >
                      <span className="block truncate text-(--fg)">{resultTitle(r.content)}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] uppercase">
                        <span>{r.type.split("@")[0].split("/").pop()}</span>
                        <span>·</span>
                        <span>{r.author}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : indexLoading ? (
            <p className="text-xs text-(--fg-muted)">Loading…</p>
          ) : (
            <MemoryTree folders={folders} activeId={activeId} />
          )}
        </aside>

        {/* Right pane: child route or resting state */}
        <div className="flex-1 min-w-0">
          {isExact ? <RestingState empty={!indexLoading && entries.length === 0} /> : <Outlet />}
        </div>
      </div>
    </div>
  );
}

function RestingState({ empty }: { empty: boolean }) {
  if (empty) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 space-y-3 max-w-xl">
        <p className="text-sm text-(--fg-muted)">
          Nothing in memory yet. Agents will surface entities, documents, and events here as they
          work.
        </p>
        <p className="text-sm text-(--fg-muted)">
          Connect an agent via{" "}
          <code className="border border-(--border) bg-(--bg-subtle) px-1 py-0.5 font-mono text-[11px]">
            freehold mcp setup claude-code
          </code>
        </p>
      </div>
    );
  }
  return (
    <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
      <p className="text-sm text-(--fg-muted)">
        Select an item from the tree, or search. Items open here with their content, connections,
        and history.
      </p>
    </div>
  );
}

export { resultTitle };
