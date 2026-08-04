import { Link, Outlet } from "@tanstack/react-router";
import { Archive, BookOpen, GitBranch, Settings, Shield, SquareCheck } from "lucide-react";
import type React from "react";
import { cn } from "~/lib/cn";
import { usePending } from "~/lib/hooks";

interface NavEntry {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** When true, this nav item renders a count badge driven by the pending proposals query. */
  badge?: boolean;
}

const NAV: NavEntry[] = [
  { to: "/inbox", label: "Inbox", icon: Archive, badge: true },
  { to: "/memory", label: "Memory", icon: BookOpen },
  { to: "/schema", label: "Schema", icon: GitBranch },
  { to: "/policy", label: "Policy", icon: Shield },
  { to: "/verify", label: "Verify", icon: SquareCheck },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const { data } = usePending();
  const pendingCount = data?.proposals?.length ?? 0;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <nav
        aria-label="Main navigation"
        className="w-52 shrink-0 border-r border-[--border] bg-[--bg-subtle] flex flex-col py-4 gap-1"
      >
        <div className="px-4 pb-4">
          <h1 className="text-lg font-semibold tracking-tight font-sans">Freehold</h1>
        </div>
        {NAV.map(({ to, label, icon: Icon, badge }) => (
          <Link
            key={to}
            to={to}
            className={cn(
              "flex items-center gap-2.5 mx-2 px-3 py-2 text-sm transition-colors",
              "text-[--fg-muted] hover:text-[--fg]",
              "[&.active]:text-[--fg] [&.active]:font-medium [&.active]:border-l-[3px] [&.active]:border-l-[var(--color-accent)] [&.active]:pl-[9px]"
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
