import { File as PierreFile } from "@pierre/diffs/react";
import { Link, createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useClassify, useCodeItem, useCodeRegions, useCodeSource } from "~/lib/hooks";
import type { RegionRule } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/code/item",
  component: CodeItemRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    nodeId: typeof search.nodeId === "string" ? search.nodeId : "",
  }),
});

interface CodeItem {
  nodeId: string;
  type: string;
  name: string;
  signature?: string;
  span?: string;
  terms: string[];
  filePath?: string;
}

function activeTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** Parse a span string like "5:1-12:1" → {startLine: 5, endLine: 12} (1-based).
 * Returns null if span is absent or unparseable. */
function parseSpanLines(span: string | undefined): { startLine: number; endLine: number } | null {
  if (!span) return null;
  // Formats seen: "5:1-12:1" or "5-12" (line-only)
  const m = span.match(/^(\d+)(?::\d+)?-(\d+)(?::\d+)?$/);
  if (!m) return null;
  const startLine = Number.parseInt(m[1], 10);
  const endLine = Number.parseInt(m[2], 10);
  if (Number.isNaN(startLine) || Number.isNaN(endLine) || startLine < 1 || endLine < startLine)
    return null;
  return { startLine, endLine };
}

/** Slice full file content to just the lines for this item. Returns the sliced content
 * and whether the full content was longer. */
function sliceLines(
  content: string,
  startLine: number,
  endLine: number
): { sliced: string; truncatedAbove: boolean; truncatedBelow: boolean } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  // Lines are 1-based; clamp to actual content
  const start = Math.max(0, startLine - 1);
  const end = Math.min(totalLines, endLine);
  return {
    sliced: lines.slice(start, end).join("\n"),
    truncatedAbove: start > 0,
    truncatedBelow: end < totalLines,
  };
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

/** A caller or callee row — name, type badge, file path, link to item detail page. */
function RelationRow({ item }: { item: CodeItem }) {
  return (
    <li className="border border-(--border) bg-(--bg-subtle) px-3 py-2 space-y-0.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Link
          to="/code/item"
          search={{ nodeId: item.nodeId }}
          className="font-mono text-sm text-(--fg) hover:underline"
          data-testid="relation-item-link"
        >
          {item.name}
        </Link>
        <span className="font-mono text-[10px] uppercase border border-(--border) px-1 py-0.5 text-(--fg-muted)">
          {item.type.split("/").pop()?.split("@")[0] ?? item.type}
        </span>
      </div>
      {item.signature && (
        <p className="font-mono text-xs text-(--fg-muted) truncate">{item.signature}</p>
      )}
      {item.filePath && (
        <Link
          to="/code/file"
          search={{ path: item.filePath }}
          className="font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) underline"
          data-testid="relation-file-link"
        >
          {item.filePath}
        </Link>
      )}
    </li>
  );
}

/** Group items by their filePath. Items with no filePath go into an "" group. */
function groupByFile(items: CodeItem[]): { filePath: string; items: CodeItem[] }[] {
  const map = new Map<string, CodeItem[]>();
  for (const item of items) {
    const key = item.filePath ?? "";
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return Array.from(map.entries()).map(([filePath, items]) => ({ filePath, items }));
}

interface RelationsSectionProps {
  label: string;
  items: CodeItem[];
  "data-testid"?: string;
}

/** Callers or callees section — grouped by file with counts. */
function RelationsSection({ label, items, "data-testid": testId }: RelationsSectionProps) {
  if (items.length === 0) return null;
  const groups = groupByFile(items);
  return (
    <section className="space-y-3" data-testid={testId}>
      <h3 className="text-sm font-semibold text-(--fg)">
        {label}{" "}
        <span className="text-(--fg-muted) font-normal font-mono text-xs">({items.length})</span>
      </h3>
      {groups.map((group) => (
        <div key={group.filePath || "__unknown"} className="space-y-1.5">
          {group.filePath && (
            <p className="font-mono text-[11px] text-(--fg-muted) flex items-center gap-1">
              <span className="opacity-50">in</span>
              <Link
                to="/code/file"
                search={{ path: group.filePath }}
                className="hover:text-(--fg) underline"
              >
                {group.filePath}
              </Link>
              <span className="opacity-50">({group.items.length})</span>
            </p>
          )}
          <ul className="space-y-1.5">
            {group.items.map((c) => (
              <RelationRow key={c.nodeId} item={c} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** Path breadcrumb — splits on "/" and links each segment to the file page. */
function PathBreadcrumb({ filePath }: { filePath: string }) {
  const parts = filePath.split("/");
  return (
    <nav
      className="flex items-center gap-1 font-mono text-[11px] text-(--fg-muted) flex-wrap"
      aria-label="File path"
    >
      {parts.map((part, i) => {
        const partialPath = parts.slice(0, i + 1).join("/");
        const isLast = i === parts.length - 1;
        return (
          <span key={partialPath} className="flex items-center gap-1">
            {i > 0 && <span className="opacity-40">/</span>}
            {isLast ? (
              <Link
                to="/code/file"
                search={{ path: filePath }}
                className="hover:text-(--fg) underline text-(--fg)"
                data-testid="breadcrumb-file-link"
              >
                {part}
              </Link>
            ) : (
              <span>{part}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Inline source snippet for the item's line range. */
function ItemSourcePanel({
  filePath,
  span,
}: {
  filePath: string;
  span: string | undefined;
}) {
  const { data: sourceData, isLoading } = useCodeSource(filePath);
  const spanLines = parseSpanLines(span);

  if (isLoading) {
    return <p className="text-xs text-(--fg-muted)">Loading source…</p>;
  }

  if (!sourceData || sourceData.binary) return null;

  if (spanLines && !sourceData.binary) {
    const { sliced, truncatedAbove, truncatedBelow } = sliceLines(
      sourceData.content,
      spanLines.startLine,
      spanLines.endLine
    );

    const lineCount = spanLines.endLine - spanLines.startLine + 1;

    return (
      <div className="space-y-1" data-testid="item-source-panel">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[11px] text-(--fg-muted)">
            Lines {spanLines.startLine}–{spanLines.endLine}
          </p>
          <Link
            to="/code/file"
            search={{ path: filePath }}
            className="font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) underline"
            data-testid="source-full-file-link"
          >
            View full file →
          </Link>
        </div>
        <div className="border border-(--border) text-sm overflow-hidden">
          <PierreFile
            file={{ name: filePath, contents: sliced }}
            options={{
              themeType: activeTheme(),
              disableFileHeader: true,
              overflow: "wrap",
            }}
          />
        </div>
        {(truncatedAbove || truncatedBelow) && lineCount > 0 && (
          <p className="font-mono text-[11px] text-(--fg-muted)">
            Showing {lineCount} of {sourceData.content.split("\n").length} lines.{" "}
            <Link
              to="/code/file"
              search={{ path: filePath }}
              className="underline hover:text-(--fg)"
            >
              View full file
            </Link>
          </p>
        )}
      </div>
    );
  }

  // No span — show full source (collapsed hint)
  return (
    <div className="space-y-1" data-testid="item-source-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] text-(--fg-muted)">Source</p>
        <Link
          to="/code/file"
          search={{ path: filePath }}
          className="font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) underline"
          data-testid="source-full-file-link"
        >
          View full file →
        </Link>
      </div>
      <div className="border border-(--border) text-sm overflow-hidden">
        <PierreFile
          file={{ name: filePath, contents: sourceData.content }}
          options={{
            themeType: activeTheme(),
            disableFileHeader: true,
            overflow: "wrap",
          }}
        />
      </div>
      {sourceData.truncated && (
        <p className="font-mono text-[11px] text-(--fg-muted)">truncated at 512 KB</p>
      )}
    </div>
  );
}

/** Governance chips — which region rules match this item's file path. */
function GovernanceContext({
  filePath,
  regions,
}: {
  filePath: string;
  regions: RegionRule[];
}) {
  const matchingRules = regions.filter((r) => r.paths.includes(filePath));
  if (matchingRules.length === 0) return null;

  return (
    <section className="space-y-2" data-testid="governance-context">
      <h3 className="text-sm font-semibold text-(--fg)">Governed by</h3>
      <div className="flex flex-wrap gap-1.5">
        {matchingRules.map((rule) => (
          <span
            key={rule.rule}
            className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-2 py-0.5 text-[11px] font-mono text-(--fg-muted)"
            data-testid="governance-chip"
          >
            {rule.rule}
            {rule.region && <span className="ml-1 opacity-60">({rule.region})</span>}
          </span>
        ))}
      </div>
    </section>
  );
}

export function CodeItemPage({ nodeId }: { nodeId?: string }) {
  const { data, isLoading, isError } = useCodeItem(nodeId);
  const { data: regionsData } = useCodeRegions(true);

  if (!nodeId) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">No item specified.</p>
      </div>
    );
  }

  if (isLoading) return <p className="text-xs text-(--fg-muted)">Loading…</p>;

  if (isError || !data) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">Item not found.</p>
      </div>
    );
  }

  const callersIn: CodeItem[] = (data as { callersIn?: CodeItem[] }).callersIn ?? [];
  const callsOut: CodeItem[] = (data as { callsOut?: CodeItem[] }).callsOut ?? [];
  const item = data as unknown as CodeItem;
  const regions: RegionRule[] = regionsData?.rules ?? [];

  return (
    <article className="max-w-3xl space-y-6">
      <header className="space-y-1.5">
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
            CODE ITEM
          </span>
        </div>
        {item.filePath && <PathBreadcrumb filePath={item.filePath} />}
        <h2 className="text-xl font-semibold tracking-tight font-mono">{item.name}</h2>
        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)">
            {item.type.split("/").pop()?.split("@")[0] ?? item.type}
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
        {item.signature && <p className="font-mono text-xs text-(--fg-muted)">{item.signature}</p>}
        {item.span && (
          <p className="font-mono text-[10px] text-(--fg-muted)" data-testid="item-span">
            {item.span}
          </p>
        )}
      </header>

      {/* Governance context */}
      {item.filePath && regions.length > 0 && (
        <GovernanceContext filePath={item.filePath} regions={regions} />
      )}

      {/* Inline source */}
      {item.filePath && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-(--fg)">Source</h3>
          <ItemSourcePanel filePath={item.filePath} span={item.span} />
        </section>
      )}

      <ClassifyPanel nodeId={item.nodeId} />

      <RelationsSection label="Called by" items={callersIn} data-testid="callers-section" />

      <RelationsSection label="Calls" items={callsOut} data-testid="callees-section" />
    </article>
  );
}

function CodeItemRoute() {
  const { nodeId } = Route.useSearch();
  return <CodeItemPage nodeId={nodeId} />;
}
