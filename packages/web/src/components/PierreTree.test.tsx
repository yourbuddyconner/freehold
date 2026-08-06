import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @pierre/trees/react at module level — happy-dom cannot render shadow DOM.
// The mock exposes controllable stubs so tests exercise the wrapper's translation logic.
const mockModel = {
  getItem: vi.fn((path: string) => ({
    isDirectory: () => path.endsWith("/"),
  })),
  getVisibleCount: vi.fn(() => 2),
  getVisibleRows: vi.fn(() => [
    {
      path: "src/",
      kind: "directory",
      isExpanded: true,
      depth: 0,
      index: 0,
      isSelected: false,
      isFocused: false,
      hasChildren: true,
      isFlattened: false,
      level: 1,
      name: "src",
      ancestorPaths: [],
      posInSet: 1,
      setSize: 1,
    },
    {
      path: "src/index.ts",
      kind: "file",
      isExpanded: false,
      depth: 1,
      index: 1,
      isSelected: false,
      isFocused: false,
      hasChildren: false,
      isFlattened: false,
      level: 2,
      name: "index.ts",
      ancestorPaths: ["src/"],
      posInSet: 1,
      setSize: 1,
    },
  ]),
  getSelectedPaths: vi.fn(() => []),
  subscribe: vi.fn(() => () => {}),
  scrollToPath: vi.fn(),
  setGitStatus: vi.fn(),
};

const capturedOptions: Record<string, unknown>[] = [];
const mockUseFileTree = vi.fn((options: Record<string, unknown>) => {
  capturedOptions.push(options);
  return { model: mockModel };
});

// Track the last value returned by useFileTreeSelector so we can honor the equality fn.
let lastSelectorResult: unknown = undefined;

const capturedFileTreeProps: Record<string, unknown>[] = [];

vi.mock("@pierre/trees/react", () => ({
  useFileTree: (options: Record<string, unknown>) => mockUseFileTree(options),
  FileTree: ({
    "data-testid": testId,
    header,
    style,
  }: {
    "data-testid"?: string;
    header?: React.ReactNode;
    style?: React.CSSProperties;
  }) => {
    capturedFileTreeProps.push({ style });
    return (
      <div data-testid={testId ?? "pierre-tree"} style={style}>
        {header}
      </div>
    );
  },
  // Mirror the real hook signature: selector is called each render; if isEqual says the
  // new result equals the previous one, return the previous reference (stable identity).
  useFileTreeSelector: <TSelected,>(
    model: typeof mockModel,
    selector: (m: typeof mockModel) => TSelected,
    isEqual?: (prev: TSelected, next: TSelected) => boolean
  ) => {
    const next = selector(model);
    if (
      lastSelectorResult !== undefined &&
      isEqual !== undefined &&
      isEqual(lastSelectorResult as TSelected, next)
    ) {
      return lastSelectorResult as TSelected;
    }
    lastSelectorResult = next;
    return next;
  },
}));

// Mock themeToTreeStyles from @pierre/trees
vi.mock("@pierre/trees", () => ({
  themeToTreeStyles: vi.fn(() => ({ "--trees-theme-bg": "#1e1e1e" })),
}));

import { PierreTree } from "./PierreTree";

const defaultPaths = ["src/", "src/index.ts", "README.md"];
const defaultOnSelect = vi.fn();

describe("PierreTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions.length = 0;
    capturedFileTreeProps.length = 0;
    lastSelectorResult = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the wrapper root with data-testid", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    expect(screen.getByTestId("pierre-tree-root")).toBeInTheDocument();
  });

  it("renders the inner FileTree mock", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    expect(screen.getByTestId("pierre-tree")).toBeInTheDocument();
  });

  it("forwards paths to useFileTree", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    expect(capturedOptions[0]).toMatchObject({ paths: defaultPaths });
  });

  it("forwards initialExpansion to useFileTree", () => {
    render(
      <PierreTree paths={defaultPaths} onSelect={defaultOnSelect} initialExpansion="closed" />
    );
    expect(capturedOptions[0]).toMatchObject({ initialExpansion: "closed" });
  });

  it("defaults initialExpansion to 'open'", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    expect(capturedOptions[0]).toMatchObject({ initialExpansion: "open" });
  });

  it("forwards initialExpandedPaths when provided", () => {
    render(
      <PierreTree paths={defaultPaths} onSelect={defaultOnSelect} initialExpandedPaths={["src/"]} />
    );
    expect(capturedOptions[0]).toMatchObject({ initialExpandedPaths: ["src/"] });
  });

  it("omits initialExpandedPaths when not provided", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    expect(capturedOptions[0]).not.toHaveProperty("initialExpandedPaths");
  });

  it("maps gitStatus entries to useFileTree options", () => {
    const gitStatus = [
      { path: "src/index.ts", status: "modified" as const },
      { path: "README.md", status: "added" as const },
    ];
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} gitStatus={gitStatus} />);
    expect(capturedOptions[0]).toMatchObject({ gitStatus });
  });

  it("calls onSelect with file kind when a file path is selected", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    // Simulate selection change by calling the onSelectionChange captured in options
    const onSelectionChange = capturedOptions[0].onSelectionChange as (
      paths: readonly string[]
    ) => void;
    // "src/index.ts" — getItem returns isDirectory: false (path doesn't end with /)
    onSelectionChange(["src/index.ts"]);
    expect(defaultOnSelect).toHaveBeenCalledWith("src/index.ts", "file");
  });

  it("calls onSelect with directory kind when a directory path is selected", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    const onSelectionChange = capturedOptions[0].onSelectionChange as (
      paths: readonly string[]
    ) => void;
    // "src/" — getItem returns isDirectory: true (path ends with /)
    onSelectionChange(["src/"]);
    expect(defaultOnSelect).toHaveBeenCalledWith("src/", "directory");
  });

  it("does not call onSelect when selection is empty", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    const onSelectionChange = capturedOptions[0].onSelectionChange as (
      paths: readonly string[]
    ) => void;
    onSelectionChange([]);
    expect(defaultOnSelect).not.toHaveBeenCalled();
  });

  it("applies theme styles to the root div", () => {
    const { container } = render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    const root = container.firstChild as HTMLElement;
    // themeToTreeStyles mock returns { "--trees-theme-bg": "#1e1e1e" }
    expect(root.style.getPropertyValue("--trees-theme-bg")).toBe("#1e1e1e");
  });

  it("renders header when provided", () => {
    render(
      <PierreTree
        paths={defaultPaths}
        onSelect={defaultOnSelect}
        header={<span data-testid="custom-header">Files</span>}
      />
    );
    expect(screen.getByTestId("custom-header")).toBeInTheDocument();
  });

  it("passes colored standard icons to useFileTree", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    expect(capturedOptions[0]).toMatchObject({
      icons: { set: "standard", colored: true },
    });
  });

  it("passes default height '100%' to FileTree style", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} />);
    expect(capturedFileTreeProps[0]).toMatchObject({ style: { height: "100%" } });
  });

  it("passes custom height to FileTree style when height prop is provided", () => {
    render(<PierreTree paths={defaultPaths} onSelect={defaultOnSelect} height="400px" />);
    expect(capturedFileTreeProps[0]).toMatchObject({ style: { height: "400px" } });
  });

  it("exposes scrollToPath via scrollToRef", async () => {
    const ref = { current: null } as React.RefObject<{
      scrollToPath: (path: string) => void;
    } | null>;
    function Host() {
      return <PierreTree paths={defaultPaths} onSelect={defaultOnSelect} scrollToRef={ref} />;
    }
    render(<Host />);
    expect(ref.current).not.toBeNull();
    ref.current?.scrollToPath("src/index.ts");
    expect(mockModel.scrollToPath).toHaveBeenCalledWith("src/index.ts", { focus: true });
  });

  describe("onExpansionChange", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      lastSelectorResult = undefined;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("suppresses the initial emission on mount (Fix 3)", () => {
      const spy = vi.fn();
      mockModel.getVisibleRows.mockReturnValue([
        {
          path: "src/",
          kind: "directory",
          isExpanded: true,
          depth: 0,
          index: 0,
          isSelected: false,
          isFocused: false,
          hasChildren: true,
          isFlattened: false,
          level: 1,
          name: "src",
          ancestorPaths: [],
          posInSet: 1,
          setSize: 1,
        },
      ]);
      render(<PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />);
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it("emits accumulated expanded list after debounce following a change", () => {
      const spy = vi.fn();
      // Initially nothing visible
      mockModel.getVisibleCount.mockReturnValue(0);
      mockModel.getVisibleRows.mockReturnValue([]);

      const { rerender } = render(
        <PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />
      );
      // Advance past mount — suppressed by Fix 3
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(spy).not.toHaveBeenCalled();

      // Simulate expansion change: src/ now visible and expanded
      mockModel.getVisibleCount.mockReturnValue(1);
      mockModel.getVisibleRows.mockReturnValue([
        {
          path: "src/",
          kind: "directory",
          isExpanded: true,
          depth: 0,
          index: 0,
          isSelected: false,
          isFocused: false,
          hasChildren: true,
          isFlattened: false,
          level: 1,
          name: "src",
          ancestorPaths: [],
          posInSet: 1,
          setSize: 1,
        },
      ]);

      // Re-render to trigger selector re-run with new expandedPaths
      rerender(<PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />);

      // Debounce not elapsed yet
      expect(spy).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(spy).toHaveBeenCalledWith(["src/"]);
    });

    it("preserves expanded-but-hidden directory state when ancestor collapses (Fix 1)", () => {
      const spy = vi.fn();

      // Phase 1: both src/ and src/components/ visible and expanded
      mockModel.getVisibleCount.mockReturnValue(2);
      mockModel.getVisibleRows.mockReturnValue([
        {
          path: "src/",
          kind: "directory",
          isExpanded: true,
          depth: 0,
          index: 0,
          isSelected: false,
          isFocused: false,
          hasChildren: true,
          isFlattened: false,
          level: 1,
          name: "src",
          ancestorPaths: [],
          posInSet: 1,
          setSize: 1,
        },
        {
          path: "src/components/",
          kind: "directory",
          isExpanded: true,
          depth: 1,
          index: 1,
          isSelected: false,
          isFocused: false,
          hasChildren: true,
          isFlattened: false,
          level: 2,
          name: "components",
          ancestorPaths: ["src/"],
          posInSet: 1,
          setSize: 1,
        },
      ]);

      const { rerender } = render(
        <PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />
      );
      // Suppress initial emission
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(spy).not.toHaveBeenCalled();

      // Phase 2: src/ is collapsed — src/components/ is now hidden (not in visible rows)
      mockModel.getVisibleCount.mockReturnValue(1);
      mockModel.getVisibleRows.mockReturnValue([
        {
          path: "src/",
          kind: "directory",
          isExpanded: false,
          depth: 0,
          index: 0,
          isSelected: false,
          isFocused: false,
          hasChildren: true,
          isFlattened: false,
          level: 1,
          name: "src",
          ancestorPaths: [],
          posInSet: 1,
          setSize: 1,
        },
      ]);

      act(() => {
        rerender(<PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />);
      });
      act(() => {
        vi.advanceTimersByTime(250);
      });

      // src/ is now collapsed (false), src/components/ was never seen collapsed so stays true
      expect(spy).toHaveBeenCalledWith(["src/components/"]);
    });

    it("clears pending timeout on unmount", () => {
      const spy = vi.fn();
      mockModel.getVisibleCount.mockReturnValue(0);
      mockModel.getVisibleRows.mockReturnValue([]);

      const { rerender, unmount } = render(
        <PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />
      );
      // Advance past mount suppression
      act(() => {
        vi.advanceTimersByTime(250);
      });

      // Trigger a change to queue a debounced emission
      mockModel.getVisibleCount.mockReturnValue(1);
      mockModel.getVisibleRows.mockReturnValue([
        {
          path: "src/",
          kind: "directory",
          isExpanded: true,
          depth: 0,
          index: 0,
          isSelected: false,
          isFocused: false,
          hasChildren: true,
          isFlattened: false,
          level: 1,
          name: "src",
          ancestorPaths: [],
          posInSet: 1,
          setSize: 1,
        },
      ]);
      rerender(<PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />);

      // Unmount before debounce fires
      unmount();

      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it("does not call onExpansionChange on re-renders with unchanged expansion (Fix: stable selector reference)", () => {
      const spy = vi.fn();
      // src/ visible and expanded — this is the stable state
      mockModel.getVisibleCount.mockReturnValue(1);
      mockModel.getVisibleRows.mockReturnValue([
        {
          path: "src/",
          kind: "directory",
          isExpanded: true,
          depth: 0,
          index: 0,
          isSelected: false,
          isFocused: false,
          hasChildren: true,
          isFlattened: false,
          level: 1,
          name: "src",
          ancestorPaths: [],
          posInSet: 1,
          setSize: 1,
        },
      ]);

      const { rerender } = render(
        <PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />
      );

      // Advance past initial-emission suppression
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(spy).not.toHaveBeenCalled();

      // Re-render twice with UNCHANGED mock rows — selector returns same contents.
      // areArraysEqual causes the hook to return the previous reference, so useEffect
      // sees no dependency change and does NOT schedule another debounced emission.
      rerender(<PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />);
      rerender(<PierreTree paths={defaultPaths} onSelect={vi.fn()} onExpansionChange={spy} />);

      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
