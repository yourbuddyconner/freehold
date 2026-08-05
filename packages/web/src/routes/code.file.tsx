import { Link, createRoute } from "@tanstack/react-router";
import { useCodeFile } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/code/file",
  component: CodeFileRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    path: typeof search.path === "string" ? search.path : "",
  }),
});

interface CodeItem {
  nodeId: string;
  type: string;
  name: string;
  signature?: string;
  span?: string;
  terms: string[];
}

/** File page — shows path, language, declared items. */
export function CodeFilePage({ filePath }: { filePath?: string }) {
  const { data, isLoading, isError } = useCodeFile(filePath);

  if (!filePath) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">No file path specified.</p>
      </div>
    );
  }

  if (isLoading) {
    return <p className="text-xs text-(--fg-muted)">Loading…</p>;
  }

  if (isError || !data) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl space-y-2">
        <p className="text-sm font-semibold text-(--fg)">{filePath}</p>
        <p className="text-sm text-(--fg-muted)">
          This file has not been indexed yet. Run{" "}
          <code className="border border-(--border) bg-(--bg-subtle) px-1 py-0.5 font-mono text-[11px]">
            allod git index
          </code>{" "}
          to index the repository.
        </p>
      </div>
    );
  }

  const items: CodeItem[] = data.items ?? [];

  return (
    <article className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-1.5">
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
            SOURCE FILE
          </span>
        </div>
        <h2 className="text-xl font-semibold tracking-tight font-mono">{data.path}</h2>
        <div className="flex flex-wrap gap-1.5">
          {data.language && (
            <span className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)">
              {data.language}
            </span>
          )}
          {(data.terms ?? []).map((t) => (
            <span
              key={t}
              className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)"
            >
              {t.split("@")[0]}
            </span>
          ))}
        </div>
      </header>

      {items.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-(--fg)">Declared items</h3>
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.nodeId}
                className="border border-(--border) bg-(--bg-subtle) px-3 py-2 space-y-1"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-semibold text-(--fg)">{item.name}</span>
                  <span className="font-mono text-[10px] uppercase border border-(--border) px-1 py-0.5 text-(--fg-muted)">
                    {item.type}
                  </span>
                  {(item.terms ?? []).map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)"
                    >
                      {t.split("@")[0]}
                    </span>
                  ))}
                </div>
                {item.signature && (
                  <p className="font-mono text-xs text-(--fg-muted) truncate">{item.signature}</p>
                )}
                {item.span && (
                  <p className="font-mono text-[10px] text-(--fg-muted)">{item.span}</p>
                )}
                <div className="pt-1">
                  <Link
                    to="/code/item"
                    search={{ nodeId: item.nodeId }}
                    className="font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) underline"
                  >
                    View blast radius →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function CodeFileRoute() {
  const { path } = Route.useSearch();
  return <CodeFilePage filePath={path} />;
}
