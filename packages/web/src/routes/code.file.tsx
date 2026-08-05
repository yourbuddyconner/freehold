import { useState } from "react";
import { Link, createRoute } from "@tanstack/react-router";
import { useClassify, useCodeFile, useGitHubBlobUrl } from "~/lib/hooks";
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

/** Classify a code node with a manually entered term. */
function ClassifyPanel({ nodeId }: { nodeId: string }) {
  const [term, setTerm] = useState("");
  const [result, setResult] = useState<{ status: "saved" | "pending" } | null>(null);
  const classify = useClassify();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim()) return;
    classify.mutate(
      { nodeId, term: term.trim() },
      {
        onSuccess: (r) => {
          setResult(r);
          setTerm("");
        },
      }
    );
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-(--fg)">Classify</h3>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="term (e.g. workspace/core)"
          aria-label="Classification term"
          className="flex-1 border border-(--border) bg-(--bg) px-2 py-1 font-mono text-xs text-(--fg) placeholder:text-(--fg-muted)"
        />
        <button
          type="submit"
          disabled={classify.isPending || !term.trim()}
          className="border border-(--border) bg-(--bg-subtle) px-3 py-1 font-mono text-[11px] uppercase tracking-[0.06em] text-(--fg) hover:bg-(--bg) disabled:opacity-50"
        >
          Apply
        </button>
      </form>
      {result && (
        <p className="font-mono text-[11px] text-(--fg-muted)">
          {result.status === "saved"
            ? "Saved."
            : "Pending — review in the Inbox."}
        </p>
      )}
    </section>
  );
}

/** File page — shows path, language, declared items. */
export function CodeFilePage({ filePath }: { filePath?: string }) {
  const { data, isLoading, isError } = useCodeFile(filePath);
  const blobUrl = useGitHubBlobUrl(filePath);

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
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold tracking-tight font-mono">{data.path}</h2>
          <Link
            to="/code/graph"
            search={{ path: filePath ?? "" }}
            data-testid="graph-tab-link"
            className="font-mono text-[11px] uppercase tracking-[0.06em] border border-(--border) px-2 py-0.5 text-(--fg-muted) hover:text-(--fg) hover:bg-(--bg-subtle)"
          >
            Graph
          </Link>
        </div>
        {blobUrl && (
          <a
            href={blobUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="github-blob-link"
            className="font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) underline"
          >
            View on GitHub →
          </a>
        )}
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

      <ClassifyPanel nodeId={data.nodeId} />
    </article>
  );
}

function CodeFileRoute() {
  const { path } = Route.useSearch();
  return <CodeFilePage filePath={path} />;
}
