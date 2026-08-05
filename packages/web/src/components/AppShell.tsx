import { Link, Outlet } from "@tanstack/react-router";
import { Archive, BookOpen, Code, GitBranch, Settings, Shield, SquareCheck } from "lucide-react";
import type React from "react";
import { cn } from "~/lib/cn";
import { useActiveGraph, useGitProposals, useGraphs, usePending } from "~/lib/hooks";

interface NavEntry {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** When true, this nav item renders a count badge driven by the pending proposals query. */
  badge?: boolean;
  /** When set, this nav item is visible only for graph kinds in the list. */
  kinds?: ("memory" | "repo")[];
}

const NAV: NavEntry[] = [
  { to: "/inbox", label: "Inbox", icon: Archive, badge: true },
  { to: "/memory", label: "Memory", icon: BookOpen, kinds: ["memory"] },
  { to: "/schema", label: "Schema", icon: GitBranch, kinds: ["memory"] },
  { to: "/code", label: "Code", icon: Code, kinds: ["repo"] },
  { to: "/policy", label: "Policy", icon: Shield },
  { to: "/verify", label: "Verify", icon: SquareCheck },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const { data } = usePending();
  const { graphs, defaultGraph } = useGraphs();
  const { activeGraphId, setActiveGraphId } = useActiveGraph();

  // Determine the kind of the active graph for nav gating.
  // When no graphs are registered yet (e.g. daemon predates Task 6),
  // treat everything as "memory" — the default graph behaviour.
  const activeGraph = graphs.find((g) => g.id === activeGraphId) ?? null;
  const activeKind: "memory" | "repo" = activeGraph?.kind ?? "memory";

  const { data: gitData } = useGitProposals(activeKind === "repo");
  const nativePendingCount = data?.proposals?.length ?? 0;
  const gitPendingCount = activeKind === "repo" ? (gitData?.proposals ?? []).filter(p => p.decided === "undecided").length : 0;
  const pendingCount = nativePendingCount + gitPendingCount;

  function handleGraphChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setActiveGraphId(e.target.value);
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <nav
        aria-label="Main navigation"
        className="w-52 shrink-0 border-r border-(--border) bg-(--bg-subtle) flex flex-col py-4 gap-1"
      >
        <div className="px-4 pb-2">
          <h1 className="text-lg font-semibold tracking-tight font-sans">Freehold</h1>
        </div>

        {/* Graph switcher — only rendered when more than one graph is registered */}
        {graphs.length > 1 && (
          <div className="px-4 pb-3">
            <select
              aria-label="Active graph"
              value={activeGraphId}
              onChange={handleGraphChange}
              className={cn(
                "w-full text-xs px-2 py-1 rounded border border-(--border)",
                "bg-(--bg-subtle) text-(--fg) focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              )}
            >
              <option value={defaultGraph}>
                {graphs.find((g) => g.id === defaultGraph)?.name ?? defaultGraph}
              </option>
              {graphs
                .filter((g) => g.id !== defaultGraph)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
          </div>
        )}

        {NAV.filter(({ kinds }) => {
          // No kinds restriction → always visible
          if (!kinds) return true;
          // Visible only if the active graph's kind is in the allowed list
          return kinds.includes(activeKind);
        }).map(({ to, label, icon: Icon, badge }) => (
          <Link
            key={to}
            to={to}
            className={cn(
              "flex items-center gap-2.5 mx-2 px-3 py-2 text-sm transition-colors",
              "text-(--fg-muted) hover:text-(--fg)",
              "[&.active]:text-(--fg) [&.active]:font-medium [&.active]:border-l-[3px] [&.active]:border-l-[var(--color-accent)] [&.active]:pl-[9px]"
            )}
            activeProps={{ className: "active" }}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span>{label}</span>
            {badge && pendingCount > 0 && (
              <span
                aria-label={`${pendingCount} pending`}
                className="ml-auto inline-flex h-4 min-w-4 items-center justify-center bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[10px] font-bold font-mono px-0.5"
              >
                {pendingCount > 99 ? "99+" : pendingCount}
              </span>
            )}
          </Link>
        ))}
      </nav>

      {/* Content pane */}
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
