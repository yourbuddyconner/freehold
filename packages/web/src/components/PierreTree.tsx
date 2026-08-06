import { themeToTreeStyles } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";

/** Shallow equality for string arrays — passed to useFileTreeSelector to stabilize the
 *  returned reference when expansion contents have not changed. */
function shallowStringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
import type React from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";

export interface PierreTreeProps {
  paths: string[];
  gitStatus?: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed" }>;
  /**
   * Initial selected path. Initial-only: @pierre/trees 1.0.0-beta.6 has no reactive
   * selection API, so changes to this prop after mount are not applied.
   */
  selectedPath?: string;
  onSelect: (path: string, kind: "file" | "directory") => void;
  initialExpandedPaths?: string[];
  onExpansionChange?: (expandedPaths: string[]) => void;
  initialExpansion?: "open" | "closed";
  search?: boolean;
  header?: React.ReactNode;
  scrollToRef?: React.Ref<{ scrollToPath: (path: string) => void }>;
  /**
   * Height applied to the FileTree host element so the internal virtualized list renders.
   * Defaults to "100%" — wrap the component in a sized container to control the height.
   */
  height?: React.CSSProperties["height"];
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
  selectedPath,
  scrollToRef,
  height = "100%",
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
    // Fix 2: wire selectedPath as initialSelectedPaths (initial-only).
    ...(selectedPath ? { initialSelectedPaths: [selectedPath] } : {}),
    search,
    gitStatus,
    icons: { set: "standard", colored: true },
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

  // Fix 1: Accumulator keeps expansion state for paths no longer visible (e.g. inside
  // a collapsed ancestor). Seeded from initialExpandedPaths so the first emission is
  // consistent with what the caller originally requested.
  const expansionAccumulatorRef = useRef<Map<string, boolean>>(
    new Map(initialExpandedPaths?.map((p) => [p, true]) ?? [])
  );

  // Derive expanded directory paths from visible rows via reactive selector.
  // Updates the accumulator for every visible directory row; unseen rows are untouched.
  // Pass areArraysEqual so the hook returns the previous reference when sorted contents
  // are unchanged — prevents useEffect([expandedPaths]) from firing on every re-render.
  const expandedPaths = useFileTreeSelector(
    model,
    (m) => {
      const count = m.getVisibleCount();
      const rows = count > 0 ? m.getVisibleRows(0, count) : [];
      for (const row of rows) {
        if (row.kind === "directory") {
          expansionAccumulatorRef.current.set(row.path, row.isExpanded);
        }
      }
      return [...expansionAccumulatorRef.current.entries()]
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort();
    },
    shallowStringArrayEqual
  );

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fix 3: Skip the initial emission to avoid spurious calls before any user interaction.
  const isFirstRenderRef = useRef(true);

  useEffect(() => {
    if (!onExpansionChangeRef.current) return;
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
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
      <FileTree model={model} header={header} style={{ height }} />
    </div>
  );
}
