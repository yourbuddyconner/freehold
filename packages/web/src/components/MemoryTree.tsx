import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { TreeFolder } from "~/lib/memoryTree";

const STORAGE_KEY = "freehold:memory-tree-open";

function loadOpenState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

interface MemoryTreeProps {
  folders: TreeFolder[];
  /** Node id of the currently open item, for row highlight */
  activeId?: string;
}

/**
 * The workspace tree: one folder per type group, items as links.
 * Open state persists per folder label in localStorage; small trees
 * default open, large ones default closed.
 */
export function MemoryTree({ folders, activeId }: MemoryTreeProps) {
  const totalLeaves = folders.reduce((n, f) => n + f.count, 0);
  const defaultOpen = totalLeaves <= 15;
  const [openState, setOpenState] = useState<Record<string, boolean>>(loadOpenState);

  function isOpen(label: string): boolean {
    return openState[label] ?? defaultOpen;
  }

  function toggle(label: string) {
    setOpenState((prev) => {
      const next = { ...prev, [label]: !(prev[label] ?? defaultOpen) };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable — open state just won't persist
      }
      return next;
    });
  }

  if (folders.length === 0) return null;

  return (
    <nav aria-label="Memory tree" className="space-y-1">
      {folders.map((folder) => (
        <div key={folder.label}>
          <button
            type="button"
            onClick={() => toggle(folder.label)}
            aria-expanded={isOpen(folder.label)}
            className="flex w-full items-center gap-1.5 px-1 py-1 text-left font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
          >
            <span aria-hidden className="inline-block w-2 text-[9px]">
              {isOpen(folder.label) ? "▾" : "▸"}
            </span>
            <span className="flex-1">{folder.label}</span>
            <span className="text-[10px] text-(--fg-muted)">{folder.count}</span>
          </button>
          {isOpen(folder.label) && (
            <ul className="ml-2 border-l border-(--border) pl-2 space-y-0.5">
              {folder.children.map((child) =>
                child.kind === "leaf" ? (
                  <li key={child.entry.id}>
                    <Link
                      to="/memory/$id"
                      params={{ id: child.entry.id }}
                      data-testid={`tree-item-${child.entry.id}`}
                      className={`flex items-center gap-1.5 px-1.5 py-1 text-xs hover:bg-(--bg-subtle) ${
                        activeId === child.entry.id
                          ? "bg-(--bg-subtle) text-(--fg)"
                          : "text-(--fg-muted) hover:text-(--fg)"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{child.entry.title}</span>
                      {child.entry.approval === "pending" && (
                        <span
                          title="Pending"
                          className="inline-block h-1.5 w-1.5 shrink-0 bg-[var(--color-status-pending)]"
                        />
                      )}
                    </Link>
                  </li>
                ) : null
              )}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );
}
