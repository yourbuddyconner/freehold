import { Link, Outlet } from "@tanstack/react-router";
import { Archive, BookOpen, GitBranch, Settings, Shield, SquareCheck } from "lucide-react";
import { cn } from "~/lib/cn";
import { usePending } from "~/lib/hooks";

const NAV = [
  { to: "/inbox", label: "Inbox", icon: Archive },
  { to: "/memory", label: "Memory", icon: BookOpen },
  { to: "/schema", label: "Schema", icon: GitBranch },
  { to: "/policy", label: "Policy", icon: Shield },
  { to: "/verify", label: "Verify", icon: SquareCheck },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

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
          <h1 className="font-serif text-lg font-semibold tracking-tight">Freehold</h1>
        </div>
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className={cn(
              "flex items-center gap-2.5 mx-2 px-3 py-2 rounded text-sm transition-colors",
              "text-[--fg-muted] hover:text-[--fg] hover:bg-[--border]",
              "[&.active]:text-[--fg] [&.active]:bg-[--border] [&.active]:font-medium"
            )}
            activeProps={{ className: "active" }}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span>{label}</span>
            {label === "Inbox" && pendingCount > 0 && (
              <span
                aria-label={`${pendingCount} pending`}
                className="ml-auto inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white"
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
