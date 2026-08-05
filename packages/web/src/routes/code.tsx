import { Link, Outlet, createRoute, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useCodeRegions, useCodeTree } from "~/lib/hooks";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/code",
  component: CodeLayout,
});

/** Minimal shape we care about for rendering the tree. */
interface CodeTreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  language?: string;
  terms?: string[];
  children?: CodeTreeNode[];
}

interface RegionRule {
  rule: string;
  region?: string;
  reviewers?: unknown;
  paths: string[];
}

function FileNode({ node, depth = 0 }: { node: CodeTreeNode; depth?: number }) {
  const [open, setOpen] = useState(true);
  const { location } = useRouterState();
  const activePath = new URLSearchParams(location.search).get("path") ?? "";

  if (node.kind === "dir") {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 py-1 text-left font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
          style={{ paddingLeft: 4 + depth * 12 }}
        >
          <span aria-hidden className="inline-block w-2 text-[9px]">
            {open ? "▾" : "▸"}
          </span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
        {open && node.children && (
          <ul>
            {node.children.map((child) => (
              <FileNode key={child.path} node={child} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isActive = activePath === node.path;
  return (
    <li>
      <Link
        to="/code/file"
        search={{ path: node.path }}
        data-testid={`code-file-${node.path}`}
        className={`flex items-center gap-1 py-1 text-xs hover:bg-(--bg-subtle) flex-wrap ${
          isActive ? "bg-(--bg-subtle) text-(--fg)" : "text-(--fg-muted) hover:text-(--fg)"
        }`}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {node.language && (
          <span className="shrink-0 border border-(--border) px-1 font-mono text-[9px] text-(--fg-muted)">
            {node.language}
          </span>
        )}
        {(node.terms ?? []).map((t) => (
          <span
            key={t}
            className="shrink-0 border border-(--border) px-1 font-mono text-[9px] text-(--fg-muted)"
          >
            {t.split("@")[0]}
          </span>
        ))}
      </Link>
    </li>
  );
}

function CodeTree({ tree }: { tree: CodeTreeNode[] }) {
  if (tree.length === 0) {
    return <p className="text-xs text-(--fg-muted)">No files indexed.</p>;
  }
  return (
    <nav aria-label="Code tree">
      <ul className="space-y-0.5">
        {tree.map((node) => (
          <FileNode key={node.path} node={node} />
        ))}
      </ul>
    </nav>
  );
}

function RegionsPanel({ rules }: { rules: RegionRule[] }) {
  if (rules.length === 0) return null;

  function renderReviewers(reviewers: unknown): string {
    if (!reviewers) return "";
    if (typeof reviewers === "string") return reviewers;
    if (Array.isArray(reviewers)) {
      return reviewers
        .map((r) => {
          if (typeof r === "string") return r;
          if (typeof r === "object" && r !== null && "name" in r) return String(r.name);
          if (typeof r === "object" && r !== null && "role" in r) return String(r.role);
          return String(r);
        })
        .join(", ");
    }
    if (typeof reviewers === "object" && reviewers !== null && "name" in reviewers) {
      return String((reviewers as Record<string, unknown>).name);
    }
    if (typeof reviewers === "object" && reviewers !== null && "role" in reviewers) {
      return String((reviewers as Record<string, unknown>).role);
    }
    return String(reviewers);
  }

  return (
    <div className="mt-4 border-t border-(--border) pt-3 space-y-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-(--fg-muted)">
        Governed paths
      </p>
      {rules.map((r) => {
        const reviewersText = renderReviewers(r.reviewers);
        return (
          <div key={r.rule} className="space-y-1">
            <div className="space-y-0.5">
              <p className="font-mono text-[11px] text-(--fg) truncate" title={r.rule}>
                {r.rule}
              </p>
              {reviewersText && (
                <p className="font-mono text-[10px] text-(--fg-muted)">{reviewersText}</p>
              )}
            </div>
            <ul className="space-y-0.5">
              {r.paths.map((p) => (
                <li key={p}>
                  <Link
                    to="/code/file"
                    search={{ path: p }}
                    className="block truncate px-1 py-0.5 font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) hover:bg-(--bg-subtle)"
                  >
                    {p}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Two-pane code workspace. Left pane: file tree + governed-paths panel.
 * Right pane: file or item detail via child routes.
 */
function CodeLayout() {
  const { location } = useRouterState();
  const pathname = location.pathname;
  const isExact = pathname === "/code" || pathname === "/code/";

  const { data: treeData, isLoading: treeLoading } = useCodeTree();
  const { data: regionsData } = useCodeRegions();

  const tree = (treeData?.tree ?? []) as CodeTreeNode[];
  const rules = (regionsData?.rules ?? []) as RegionRule[];

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
          CODE WORKSPACE
        </span>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight mb-4">Code</h2>

      <div className="flex gap-6 items-start">
        {/* Left pane: file tree + governed paths */}
        <aside className="w-72 shrink-0 border-r border-(--border) pr-4">
          {treeLoading ? (
            <p className="text-xs text-(--fg-muted)">Loading…</p>
          ) : (
            <CodeTree tree={tree} />
          )}
          <RegionsPanel rules={rules} />
        </aside>

        {/* Right pane: child route or resting state */}
        <div className="flex-1 min-w-0">{isExact ? <RestingState /> : <Outlet />}</div>
      </div>
    </div>
  );
}

function RestingState() {
  return (
    <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
      <p className="text-sm text-(--fg-muted)">
        Select a file from the tree to view its declared items, classifications, and blast radius.
      </p>
    </div>
  );
}
