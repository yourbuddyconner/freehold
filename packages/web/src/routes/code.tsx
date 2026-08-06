import { Link, Outlet, createRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { MarkdownView } from "~/components/MarkdownView";
import { PierreTree } from "~/components/PierreTree";
import { useCodeRegions, useCodeSource, useCodeTree } from "~/lib/hooks";
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

/** Depth-first traversal collecting only file paths. */
function flattenTree(nodes: CodeTreeNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      result.push(node.path);
    } else if (node.children) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}

/** Find a root-level README file node (case-insensitive). */
function findRootReadme(nodes: CodeTreeNode[]): CodeTreeNode | undefined {
  return nodes.find((node) => node.kind === "file" && node.name.toLowerCase().startsWith("readme"));
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

function ReadmePreview({ path }: { path: string }) {
  const { data: sourceData, isLoading } = useCodeSource(path);
  if (isLoading) return <p className="text-xs text-(--fg-muted)">Loading…</p>;
  if (!sourceData) return null;
  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] text-(--fg-muted) uppercase tracking-[0.08em]">README</p>
      <MarkdownView>{sourceData.content}</MarkdownView>
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
  const navigate = useNavigate();

  const tree = (treeData?.tree ?? []) as CodeTreeNode[];
  const rules = (regionsData?.rules ?? []) as RegionRule[];
  const paths = flattenTree(tree);

  const activePath = new URLSearchParams(location.search).get("path") ?? undefined;

  const readmeNode = isExact ? findRootReadme(tree) : undefined;

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
        <aside className="w-72 shrink-0 border-r border-(--border) pr-4 sticky top-0 self-start">
          <div className="overflow-y-auto" style={{ height: "calc(100vh - 160px)" }}>
            {treeLoading ? (
              <p className="text-xs text-(--fg-muted)">Loading…</p>
            ) : paths.length === 0 ? (
              <p className="text-xs text-(--fg-muted)">No files indexed.</p>
            ) : (
              <PierreTree
                paths={paths}
                selectedPath={activePath}
                search
                height="calc(100vh - 160px)"
                initialExpansion="closed"
                onSelect={(path, kind) => {
                  if (kind === "file") {
                    void navigate({ to: "/code/file", search: { path } });
                  }
                }}
              />
            )}
            <RegionsPanel rules={rules} />
          </div>
        </aside>

        {/* Right pane: child route or resting/readme state */}
        <div className="flex-1 min-w-0">
          {isExact ? (
            readmeNode ? (
              <ReadmePreview path={readmeNode.path} />
            ) : (
              <RestingState />
            )
          ) : (
            <Outlet />
          )}
        </div>
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
