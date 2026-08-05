import { render, screen } from "@testing-library/react";
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

vi.mock("@pierre/trees/react", () => ({
  useFileTree: (options: Record<string, unknown>) => mockUseFileTree(options),
  FileTree: ({
    "data-testid": testId,
    header,
  }: {
    "data-testid"?: string;
    header?: React.ReactNode;
  }) => <div data-testid={testId ?? "pierre-tree"}>{header}</div>,
  // useFileTreeSelector: call selector with the model so the component can derive state.
  useFileTreeSelector: <TSelected,>(
    model: typeof mockModel,
    selector: (m: typeof mockModel) => TSelected
  ) => selector(model),
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
});
