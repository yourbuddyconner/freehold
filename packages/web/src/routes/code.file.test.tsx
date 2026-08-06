/**
 * Tests for code.file.tsx comment and hover functionality.
 *
 * Tests:
 *   - Clicking a line number opens the comment composer with span prefilled
 *   - Save button fires POST with correct payload (path, span, body, by)
 *   - Cancel closes the composer without posting
 *   - Existing comments render via renderAnnotation (body, author)
 *   - "posted against an older revision" caption when currentHead = false
 *   - Comment count chip in file metadata header
 *   - Hovering over a line of an indexed item shows the hover card
 *   - Hover card clears when leaving the line
 *   - lineHoverHighlight is enabled in options so the library wires the gate
 */

import type { LineAnnotation, OnLineClickProps, OnLineEnterLeaveProps } from "@pierre/diffs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hooks from "~/lib/hooks";
import { CodeFilePage } from "./code.file";

// ── Pierre File mock ─────────────────────────────────────────────────────────
// Capture options so tests can trigger callbacks and verify option values.

interface CapturedFileOptions {
  onLineEnter?: (props: OnLineEnterLeaveProps) => void;
  onLineLeave?: (props: OnLineEnterLeaveProps) => void;
  onLineNumberClick?: (props: OnLineClickProps) => void;
  lineHoverHighlight?: string;
}

interface CapturedFileProps<LAnnotation> {
  options?: CapturedFileOptions;
  lineAnnotations?: LineAnnotation<LAnnotation>[];
  renderAnnotation?: (ann: LineAnnotation<LAnnotation>) => React.ReactNode;
}

const capturedFileProps = vi.hoisted(() => ({
  current: {} as CapturedFileProps<unknown>,
}));

vi.mock("@pierre/diffs/react", () => ({
  File: ({
    file,
    options,
    lineAnnotations,
    renderAnnotation,
  }: {
    file: { name: string; contents: string };
    options?: CapturedFileOptions;
    lineAnnotations?: LineAnnotation<unknown>[];
    renderAnnotation?: (ann: LineAnnotation<unknown>) => React.ReactNode;
  }) => {
    capturedFileProps.current = {
      options,
      lineAnnotations,
      renderAnnotation,
    };
    return (
      <div data-testid="pierre-file">
        <pre>{file.contents}</pre>
        {lineAnnotations?.map((ann) => (
          <div key={ann.lineNumber} data-testid={`annotation-${ann.lineNumber}`}>
            {renderAnnotation ? renderAnnotation(ann) : null}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock("~/components/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => (
    <div data-testid="markdown-view">{children}</div>
  ),
}));

// ── Hooks mock ────────────────────────────────────────────────────────────────

vi.mock("~/lib/hooks", () => ({
  useCodeFile: vi.fn(),
  useCodeSource: vi.fn(),
  useGitHubBlobUrl: vi.fn().mockReturnValue(null),
  useClassify: vi.fn(),
  useCodeComments: vi.fn(),
  usePostCodeComment: vi.fn(),
  useActiveGraphPrincipal: vi.fn().mockReturnValue("owner"),
  useActiveGraph: vi.fn().mockReturnValue({ activeGraphId: "main", setActiveGraphId: vi.fn() }),
}));

// ── Router mock (TanStack Router requires some stubs) ─────────────────────────

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    Link: ({
      children,
      ...props
    }: { children: React.ReactNode; to?: string; search?: unknown }) => (
      <a href={props.to ?? "#"} data-testid="link">
        {children}
      </a>
    ),
    createRoute: vi.fn(() => ({ useSearch: vi.fn(() => ({ path: "" })) })),
  };
});

// ── Sample data ───────────────────────────────────────────────────────────────

const sampleSource = {
  path: "src/lib.rs",
  content: "// library code\nfn hello() {}",
  truncated: false,
  binary: false,
  size: 30,
};

// ── Render helper ─────────────────────────────────────────────────────────────

function renderFilePage(
  filePath = "src/lib.rs",
  overrides: {
    comments?: Array<{
      commentId: string;
      body: string;
      span: string;
      status: "open";
      author: string;
      anchorSha: string;
      currentHead: boolean;
    }>;
    postMutate?: ReturnType<typeof vi.fn>;
    items?: Array<{
      nodeId: string;
      type: string;
      name: string;
      signature?: string;
      span?: string;
      terms: string[];
    }>;
  } = {}
) {
  const postMutate = overrides.postMutate ?? vi.fn();

  const fileView = {
    path: "src/lib.rs",
    language: "rust",
    nodeId: "node-file-1",
    blobRef: undefined,
    terms: [],
    items: overrides.items ?? [],
  };

  vi.mocked(hooks.useCodeFile).mockReturnValue({
    data: fileView,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCodeFile>);

  vi.mocked(hooks.useCodeSource).mockReturnValue({
    data: sampleSource,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCodeSource>);

  vi.mocked(hooks.useClassify).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooks.useClassify>);

  vi.mocked(hooks.useCodeComments).mockReturnValue({
    data: { comments: overrides.comments ?? [] },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCodeComments>);

  vi.mocked(hooks.usePostCodeComment).mockReturnValue({
    mutate: postMutate,
    isPending: false,
  } as unknown as ReturnType<typeof hooks.usePostCodeComment>);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={qc}>
      <CodeFilePage filePath={filePath} />
    </QueryClientProvider>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CodeFilePage — comment composer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedFileProps.current = {};
  });

  it("clicking a line number opens the composer with span prefilled", async () => {
    renderFilePage();

    // Verify the source panel rendered
    expect(screen.getByTestId("pierre-file")).toBeInTheDocument();

    // Simulate line number click
    await act(async () => {
      capturedFileProps.current.options?.onLineNumberClick?.({
        lineNumber: 5,
        type: "line",
        lineElement: document.createElement("div"),
        numberElement: document.createElement("div"),
        numberColumn: true,
        event: new PointerEvent("click"),
      });
    });

    // Composer should open
    expect(screen.getByTestId("comment-composer")).toBeInTheDocument();
    // Span is shown in the composer
    expect(screen.getByText(/L5/)).toBeInTheDocument();
  });

  it("save fires POST with correct payload", async () => {
    const postMutate = vi.fn((vars, opts) => {
      opts?.onSuccess?.({ commentId: "c-1", status: "saved", anchorSha: "abc123" });
    });
    renderFilePage("src/lib.rs", { postMutate });

    // Open composer for line 3
    await act(async () => {
      capturedFileProps.current.options?.onLineNumberClick?.({
        lineNumber: 3,
        type: "line",
        lineElement: document.createElement("div"),
        numberElement: document.createElement("div"),
        numberColumn: true,
        event: new PointerEvent("click"),
      });
    });

    // Fill in the body
    const textarea = screen.getByTestId("comment-body");
    fireEvent.change(textarea, { target: { value: "This needs review." } });

    // Click Save
    const saveBtn = screen.getByTestId("comment-save");
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Check POST payload
    expect(postMutate).toHaveBeenCalledOnce();
    expect(postMutate.mock.calls[0][0]).toMatchObject({
      span: "L3",
      body: "This needs review.",
      by: "owner",
    });

    // Composer closes after save
    expect(screen.queryByTestId("comment-composer")).not.toBeInTheDocument();
  });

  it("cancel closes the composer without posting", async () => {
    const postMutate = vi.fn();
    renderFilePage("src/lib.rs", { postMutate });

    // Open composer
    await act(async () => {
      capturedFileProps.current.options?.onLineNumberClick?.({
        lineNumber: 7,
        type: "line",
        lineElement: document.createElement("div"),
        numberElement: document.createElement("div"),
        numberColumn: true,
        event: new PointerEvent("click"),
      });
    });

    expect(screen.getByTestId("comment-composer")).toBeInTheDocument();

    // Click Cancel
    await act(async () => {
      fireEvent.click(screen.getByTestId("comment-cancel"));
    });

    // Composer closes, no POST
    expect(screen.queryByTestId("comment-composer")).not.toBeInTheDocument();
    expect(postMutate).not.toHaveBeenCalled();
  });
});

describe("CodeFilePage — comment annotations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedFileProps.current = {};
  });

  it("renders existing comments via annotation with body and author", async () => {
    const comments = [
      {
        commentId: "c-1",
        body: "Check this function.",
        span: "L1",
        status: "open" as const,
        author: "alice",
        anchorSha: "abc123abc123abc123abc123abc123abc123abc123",
        currentHead: true,
      },
    ];

    renderFilePage("src/lib.rs", { comments });

    // The annotation should be rendered in the pierre-file mock
    expect(screen.getByTestId("annotation-1")).toBeInTheDocument();
    const annotation = screen.getByTestId("code-comment-annotation");
    expect(annotation).toBeInTheDocument();
    expect(annotation).toHaveTextContent("Check this function.");
    expect(annotation).toHaveTextContent("alice");
  });

  it("shows 'posted against an older revision' when currentHead is false", async () => {
    const comments = [
      {
        commentId: "c-2",
        body: "Old note.",
        span: "L2",
        status: "open" as const,
        author: "bob",
        anchorSha: "oldshaoldshaoldshaoldshaoldshaoldsha1234",
        currentHead: false,
      },
    ];

    renderFilePage("src/lib.rs", { comments });

    const annotation = screen.getByTestId("code-comment-annotation");
    expect(annotation).toHaveTextContent("posted against an older revision");
  });

  it("does not show older revision caption when currentHead is true", async () => {
    const comments = [
      {
        commentId: "c-3",
        body: "Fresh note.",
        span: "L3",
        status: "open" as const,
        author: "carol",
        anchorSha: "abc123abc123abc123abc123abc123abc123abc123",
        currentHead: true,
      },
    ];

    renderFilePage("src/lib.rs", { comments });

    const annotation = screen.getByTestId("code-comment-annotation");
    expect(annotation).not.toHaveTextContent("posted against an older revision");
  });
});

describe("CodeFilePage — comment count chip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedFileProps.current = {};
  });

  it("shows comment count chip when there are comments", async () => {
    const comments = [
      {
        commentId: "c-1",
        body: "Note 1.",
        span: "L1",
        status: "open" as const,
        author: "alice",
        anchorSha: "abc123",
        currentHead: true,
      },
      {
        commentId: "c-2",
        body: "Note 2.",
        span: "L5",
        status: "open" as const,
        author: "bob",
        anchorSha: "abc123",
        currentHead: true,
      },
    ];

    renderFilePage("src/lib.rs", { comments });

    const chip = screen.getByTestId("comment-count-chip");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("2 notes");
  });

  it("does not show comment count chip when there are no comments", async () => {
    renderFilePage("src/lib.rs", { comments: [] });

    expect(screen.queryByTestId("comment-count-chip")).not.toBeInTheDocument();
  });
});

describe("CodeFilePage — hover card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    capturedFileProps.current = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const indexedItems = [
    {
      nodeId: "n-hello",
      type: "fn",
      name: "hello",
      span: "2:0-2:14",
      terms: ["greeting@v1"],
    },
  ];

  it("onLineEnter is wired in PierreFile options and lineHoverHighlight is enabled", () => {
    renderFilePage("src/lib.rs", { items: indexedItems });
    expect(capturedFileProps.current.options?.onLineEnter).toBeTypeOf("function");
    expect(capturedFileProps.current.options?.onLineLeave).toBeTypeOf("function");
    expect(capturedFileProps.current.options?.lineHoverHighlight).toBe("line");
  });

  it("hovering over a line of an indexed item shows the hover card after debounce", async () => {
    renderFilePage("src/lib.rs", { items: indexedItems });

    // Simulate Pierre calling onLineEnter for line 2 (within hello's span 2:0-2:14)
    await act(async () => {
      capturedFileProps.current.options?.onLineEnter?.({
        lineNumber: 2,
        type: "line",
        lineElement: document.createElement("div"),
        numberElement: document.createElement("div"),
        numberColumn: false,
        event: new PointerEvent("pointermove"),
      });
    });

    // Card is not yet visible — debounce hasn't fired
    expect(screen.queryByTestId("hover-card")).not.toBeInTheDocument();

    // Advance past the 100 ms debounce
    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    const card = screen.getByTestId("hover-card");
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent("hello");
    expect(card).toHaveTextContent("fn");
  });

  it("hovering over a line with no indexed item shows no hover card", async () => {
    renderFilePage("src/lib.rs", { items: indexedItems });

    await act(async () => {
      // Line 1 is not within the hello span (which starts at line 2)
      capturedFileProps.current.options?.onLineEnter?.({
        lineNumber: 1,
        type: "line",
        lineElement: document.createElement("div"),
        numberElement: document.createElement("div"),
        numberColumn: false,
        event: new PointerEvent("pointermove"),
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    expect(screen.queryByTestId("hover-card")).not.toBeInTheDocument();
  });

  it("onLineLeave clears the hover card after debounce", async () => {
    renderFilePage("src/lib.rs", { items: indexedItems });

    // Enter line 2 and wait for card
    await act(async () => {
      capturedFileProps.current.options?.onLineEnter?.({
        lineNumber: 2,
        type: "line",
        lineElement: document.createElement("div"),
        numberElement: document.createElement("div"),
        numberColumn: false,
        event: new PointerEvent("pointermove"),
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByTestId("hover-card")).toBeInTheDocument();

    // Leave the line
    await act(async () => {
      capturedFileProps.current.options?.onLineLeave?.({
        lineNumber: 2,
        type: "line",
        lineElement: document.createElement("div"),
        numberElement: document.createElement("div"),
        numberColumn: false,
        event: new PointerEvent("pointermove"),
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    expect(screen.queryByTestId("hover-card")).not.toBeInTheDocument();
  });

  it("onLineNumberClick is wired in PierreFile options", () => {
    renderFilePage("src/lib.rs");
    expect(capturedFileProps.current.options?.onLineNumberClick).toBeTypeOf("function");
  });
});
