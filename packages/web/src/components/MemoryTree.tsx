import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { TreeFolder, TreeNode } from "~/lib/memoryTree";

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
 * The workspace tree: type folders at the top level, term-derived folders
 * nested inside, items as links. Open state persists per folder id in
 * localStorage; small trees default open, large ones default closed.
 */
export function MemoryTree({ folders, activeId }: MemoryTreeProps) {
  const totalLeaves = folders.reduce((n, f) => n + f.count, 0);
  const defaultOpen = totalLeaves <= 15;
  const [openState, setOpenState] = useState<Record<string, boolean>>(loadOpenState);

  function isOpen(id: string): boolean {
    return openState[id] ?? defaultOpen;
  }

  function toggle(id: string) {
    setOpenState((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? defaultOpen) };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable — open state just won't persist
      }
      return next;
    });
  }

  function renderLeaf(node: TreeNode & { kind: "leaf" }, depth: number) {
    return (
      <li key={node.entry.id}>
        <Link
          to="/memory/$id"
          params={{ id: node.entry.id }}
          data-testid={`tree-item-${node.entry.id}`}
          className={`flex items-center gap-1.5 py-1 pr-1.5 text-xs hover:bg-(--bg-subtle) ${
            activeId === node.entry.id
              ? "bg-(--bg-subtle) text-(--fg)"
              : "text-(--fg-muted) hover:text-(--fg)"
          }`}
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <span className="min-w-0 flex-1 truncate">{node.entry.title}</span>
          {node.entry.approval === "pending" && (
            <span
              title="Pending"
              className="inline-block h-1.5 w-1.5 shrink-0 bg-[var(--color-status-pending)]"
            />
          )}
        </Link>
      </li>
    );
  }

  function renderFolder(folder: TreeFolder, depth: number) {
    const open = isOpen(folder.id);
    const topLevel = depth === 0;
    return (
      <li key={folder.id}>
        <button
          type="button"
          onClick={() => toggle(folder.id)}
          aria-expanded={open}
          data-testid={`tree-folder-${folder.id}`}
          className={`flex w-full items-center gap-1.5 py-1 pr-1 text-left ${
            topLevel
              ? "font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted) hover:text-(--fg)"
              : "text-xs text-(--fg-muted) hover:text-(--fg)"
          }`}
          style={{ paddingLeft: topLevel ? 4 : 6 + depth * 12 }}
        >
          <span aria-hidden className="inline-block w-2 text-[9px]">
            {open ? "▾" : "▸"}
          </span>
          <span className="min-w-0 flex-1 truncate">{folder.label}</span>
          <span className="font-mono text-[10px] text-(--fg-muted)">{folder.count}</span>
        </button>
        {open && (
          <ul className={topLevel ? "ml-1 border-l border-(--border)" : ""}>
            {folder.children.map((child) =>
              child.kind === "folder"
                ? renderFolder(child, depth + 1)
                : renderLeaf(child, depth + 1)
            )}
          </ul>
        )}
      </li>
    );
  }

  if (folders.length === 0) return null;

  return (
    <nav aria-label="Memory tree">
      <ul className="space-y-1">{folders.map((f) => renderFolder(f, 0))}</ul>
    </nav>
  );
}
