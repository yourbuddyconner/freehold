import { themeToTreeStyles } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import type React from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";

export interface PierreTreeProps {
  paths: string[];
  gitStatus?: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed" }>;
  selectedPath?: string;
  onSelect: (path: string, kind: "file" | "directory") => void;
  initialExpandedPaths?: string[];
  onExpansionChange?: (expandedPaths: string[]) => void;
  initialExpansion?: "open" | "closed";
  search?: boolean;
  header?: React.ReactNode;
  scrollToRef?: React.Ref<{ scrollToPath: (path: string) => void }>;
}

function activeTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function buildThemeInput(themeType: "dark" | "light") {
  return { type: themeType };
}

export function PierreTree({
  paths,
  gitStatus,
  onSelect,
  initialExpandedPaths,
  onExpansionChange,
  initialExpansion = "open",
  search = false,
  header,
  selectedPath: _selectedPath,
  scrollToRef,
}: PierreTreeProps): React.JSX.Element {
  const [themeStyles, setThemeStyles] = useState(() =>
    themeToTreeStyles(buildThemeInput(activeTheme()))
  );

  // Re-resolve theme styles on data-theme attribute changes.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      setThemeStyles(themeToTreeStyles(buildThemeInput(activeTheme())));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  const { model } = useFileTree({
    paths,
    initialExpansion,
    ...(initialExpandedPaths ? { initialExpandedPaths } : {}),
    search,
    gitStatus,
    onSelectionChange: (selectedPaths: readonly string[]) => {
      const path = selectedPaths[0];
      if (!path) return;
      const item = model.getItem(path);
      const kind: "file" | "directory" = item?.isDirectory() ? "directory" : "file";
      onSelect(path, kind);
    },
  });

  // Expose scrollToPath via scrollToRef.
  useImperativeHandle(
    scrollToRef,
    () => ({
      scrollToPath: (path: string) => {
        model.scrollToPath(path, { focus: true });
      },
    }),
    [model]
  );

  // Subscribe to expansion changes and debounce calls to onExpansionChange.
  const onExpansionChangeRef = useRef(onExpansionChange);
  onExpansionChangeRef.current = onExpansionChange;

  // Derive expanded directory paths from visible rows via reactive selector.
  const expandedPaths = useFileTreeSelector(model, (m) => {
    const count = m.getVisibleCount();
    if (count === 0) return [] as string[];
    const rows = m.getVisibleRows(0, count);
    return rows.filter((r) => r.kind === "directory" && r.isExpanded).map((r) => r.path);
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!onExpansionChangeRef.current) return;
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onExpansionChangeRef.current?.(expandedPaths);
    }, 250);
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, [expandedPaths]);

  return (
    <div
      data-testid="pierre-tree-root"
      className="text-sm"
      style={themeStyles as React.CSSProperties}
    >
      <FileTree model={model} header={header} />
    </div>
  );
}
