import type { OnLineEnterLeaveProps } from "@pierre/diffs";
import { File as PierreFile } from "@pierre/diffs/react";
import { Link, createRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { MarkdownView } from "~/components/MarkdownView";
import { useClassify, useCodeFile, useCodeSource, useGitHubBlobUrl } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

function activeTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

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

/** Parse "startLine:startCol-endLine:endCol" into line numbers. Returns null on invalid input. */
function parseSpan(span: string): { startLine: number; endLine: number } | null {
  const parts = span.split("-");
  if (parts.length < 2) return null;
  const start = Number.parseInt(parts[0].split(":")[0], 10);
  const end = Number.parseInt(parts[1].split(":")[0], 10);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { startLine: start, endLine: end };
}

/** Build a map from line number to the CodeItem that spans it. */
function buildLineToItemMap(items: CodeItem[]): Map<number, CodeItem> {
  const map = new Map<number, CodeItem>();
  for (const item of items) {
    if (!item.span) continue;
    const range = parseSpan(item.span);
    if (!range) continue;
    for (let ln = range.startLine; ln <= range.endLine; ln++) {
      map.set(ln, item);
    }
  }
  return map;
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
          {result.status === "saved" ? (
            "Saved."
          ) : (
            <>
              Pending — review in the <Link to="/inbox">Inbox</Link>.
            </>
          )}
        </p>
      )}
    </section>
  );
}

interface SourcePanelProps {
  isLoading: boolean;
  binary: boolean;
  truncated: boolean;
  content: string;
  /** Filename drives syntax highlighting; defaults to plain text. */
  name?: string;
  /** Declared items — used to build the hover card line map. */
  items?: CodeItem[];
}

/** Syntax-highlighted source panel with optional hover cards for declared items. */
function SourcePanel({
  isLoading,
  binary,
  truncated,
  content,
  name = "",
  items = [],
}: SourcePanelProps) {
  const [hoveredItem, setHoveredItem] = useState<CodeItem | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lineToItem = buildLineToItemMap(items);

  const onLineEnter = (props: OnLineEnterLeaveProps) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      const item = lineToItem.get(props.lineNumber) ?? null;
      setHoveredItem(item);
    }, 100);
  };

  const onLineLeave = (_props: OnLineEnterLeaveProps) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredItem(null);
    }, 100);
  };

  if (isLoading) {
    return <p className="text-xs text-(--fg-muted)">Loading source…</p>;
  }
  if (binary) {
    return (
      <p className="font-mono text-xs text-(--fg-muted) border border-(--border) bg-(--bg-subtle) px-3 py-2">
        binary file — not rendered
      </p>
    );
  }
  return (
    <div className="space-y-1" data-testid="source-panel">
      <div className="relative">
        <div className="border border-(--border) text-sm overflow-hidden">
          <PierreFile
            file={{ name, contents: content }}
            options={{
              themeType: activeTheme(),
              disableFileHeader: true,
              overflow: "wrap",
              onLineEnter,
              onLineLeave,
            }}
          />
        </div>
        {hoveredItem && (
          <div
            data-testid="hover-card"
            className="absolute top-2 right-2 z-10 border border-(--border) bg-(--bg-subtle) p-2 font-mono text-xs shadow-sm max-w-xs"
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <Link
                to="/code/item"
                search={{ nodeId: hoveredItem.nodeId }}
                className="font-semibold text-(--fg) hover:underline"
              >
                {hoveredItem.name}
              </Link>
              <span className="uppercase border border-(--border) px-1 py-0.5 text-[10px] text-(--fg-muted)">
                {hoveredItem.type}
              </span>
              {(hoveredItem.terms ?? []).map((t) => (
                <span
                  key={t}
                  className="border border-(--border) bg-(--bg) px-1 py-0.5 text-[10px] text-(--fg-muted)"
                >
                  {t.split("@")[0]}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      {truncated && <p className="font-mono text-[11px] text-(--fg-muted)">truncated at 512 KB</p>}
    </div>
  );
}

/** Returns true if the path is a markdown file. */
function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

const MD_VIEW_KEY = "freehold-md-view";

/** Raw | Rendered toggle + source display for markdown files. */
function MarkdownSourcePanel({
  isLoading,
  binary,
  truncated,
  content,
  name = "",
  items = [],
}: SourcePanelProps) {
  const [view, setView] = useState<"rendered" | "raw">(() => {
    try {
      const stored = localStorage.getItem(MD_VIEW_KEY);
      return stored === "raw" ? "raw" : "rendered";
    } catch {
      return "rendered";
    }
  });

  function switchView(next: "rendered" | "raw") {
    setView(next);
    try {
      localStorage.setItem(MD_VIEW_KEY, next);
    } catch {
      // ignore
    }
  }

  if (isLoading) {
    return <p className="text-xs text-(--fg-muted)">Loading source…</p>;
  }
  if (binary) {
    return (
      <p className="font-mono text-xs text-(--fg-muted) border border-(--border) bg-(--bg-subtle) px-3 py-2">
        binary file — not rendered
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="source-panel">
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="md-toggle-raw"
          onClick={() => switchView("raw")}
          className={`font-mono text-[11px] uppercase tracking-[0.06em] border px-2 py-0.5 ${
            view === "raw"
              ? "border-(--fg-muted) text-(--fg) bg-(--bg-subtle)"
              : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
          }`}
        >
          Raw
        </button>
        <button
          type="button"
          data-testid="md-toggle-rendered"
          onClick={() => switchView("rendered")}
          className={`font-mono text-[11px] uppercase tracking-[0.06em] border px-2 py-0.5 ${
            view === "rendered"
              ? "border-(--fg-muted) text-(--fg) bg-(--bg-subtle)"
              : "border-(--border) text-(--fg-muted) hover:text-(--fg)"
          }`}
        >
          Rendered
        </button>
      </div>
      {view === "rendered" ? (
        <MarkdownView>{content}</MarkdownView>
      ) : (
        <SourcePanel
          isLoading={false}
          binary={binary}
          truncated={truncated}
          content={content}
          name={name}
          items={items}
        />
      )}
      {truncated && view !== "rendered" && (
        <p className="font-mono text-[11px] text-(--fg-muted)">truncated at 512 KB</p>
      )}
    </div>
  );
}

/** File page — shows path, language, source, declared items. */
export function CodeFilePage({ filePath }: { filePath?: string }) {
  const { data, isLoading, isError } = useCodeFile(filePath);
  const { data: sourceData, isLoading: sourceLoading } = useCodeSource(filePath);
  const blobUrl = useGitHubBlobUrl(filePath);

  if (!filePath) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">No file path specified.</p>
      </div>
    );
  }

  // Show a loading state while either request is in flight
  if (isLoading || sourceLoading) {
    return <p className="text-xs text-(--fg-muted)">Loading…</p>;
  }

  // If codeFile 404d but source is available, still show source + hint
  const fileUnavailable = isError || !data;

  if (fileUnavailable && !sourceData) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl space-y-2">
        <p className="text-sm font-semibold text-(--fg)">{filePath}</p>
        <p className="text-sm text-(--fg-muted)">
          File not indexed. Run:{" "}
          <code className="border border-(--border) bg-(--bg-subtle) px-1 py-0.5 font-mono text-[11px]">
            allod git index
          </code>
        </p>
      </div>
    );
  }

  const items: CodeItem[] = data?.items ?? [];
  const isMd = isMarkdownPath(filePath);

  return (
    <article className="space-y-6">
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
          <h2 className="text-xl font-semibold tracking-tight font-mono">
            {data?.path ?? filePath}
          </h2>
          <Link
            to="/code/graph"
            search={{ path: filePath }}
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
          {data?.language && (
            <span className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)">
              {data.language}
            </span>
          )}
          {(data?.terms ?? []).map((t) => (
            <span
              key={t}
              className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)"
            >
              {t.split("@")[0]}
            </span>
          ))}
        </div>
      </header>

      {/* Not-indexed hint when file is on disk but not in the graph */}
      {fileUnavailable && sourceData && (
        <div className="border border-(--border) bg-(--bg-subtle) px-3 py-2 space-y-1">
          <p className="text-xs text-(--fg-muted)">
            File not indexed. Run:{" "}
            <code className="border border-(--border) bg-(--bg-subtle) px-1 py-0.5 font-mono text-[11px]">
              allod git index
            </code>
          </p>
        </div>
      )}

      {/* Declared items — compact, above source */}
      {items.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-(--fg)">
            {items.length} declared {items.length === 1 ? "item" : "items"}
          </h3>
          <ul className="divide-y divide-(--border)">
            {items.map((item) => (
              <li key={item.nodeId} className="py-1.5 flex items-start gap-2 flex-wrap">
                <Link
                  to="/code/item"
                  search={{ nodeId: item.nodeId }}
                  className="font-mono text-sm font-semibold text-(--fg) hover:underline"
                >
                  {item.name}
                </Link>
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
                {item.signature && (
                  <p className="w-full font-mono text-xs text-(--fg-muted) truncate">
                    {item.signature}
                  </p>
                )}
                <div className="w-full pt-0.5">
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

      {/* Source panel — with markdown toggle for .md/.markdown files */}
      {(sourceData ?? sourceLoading) && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-(--fg)">Source</h3>
          {sourceLoading ? (
            <SourcePanel isLoading content="" binary={false} truncated={false} />
          ) : sourceData ? (
            isMd ? (
              <MarkdownSourcePanel
                isLoading={false}
                binary={sourceData.binary}
                truncated={sourceData.truncated}
                content={sourceData.content}
                name={filePath}
                items={items}
              />
            ) : (
              <SourcePanel
                isLoading={false}
                binary={sourceData.binary}
                truncated={sourceData.truncated}
                content={sourceData.content}
                name={filePath}
                items={items}
              />
            )
          ) : null}
        </section>
      )}

      {data && <ClassifyPanel nodeId={data.nodeId} />}
    </article>
  );
}

function CodeFileRoute() {
  const { path } = Route.useSearch();
  return <CodeFilePage filePath={path} />;
}
