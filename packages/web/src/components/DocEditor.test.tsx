import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @pierre/diffs edit module — happy-dom cannot run the real editor.
vi.mock("@pierre/diffs/edit", () => ({
  Editor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@pierre/diffs/react", () => ({
  EditProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  File: ({
    editorOptions,
  }: { editorOptions?: { onChange?: (f: { contents: string }) => void } }) => (
    <textarea
      data-testid="pierre-file-editor"
      onChange={(e) => editorOptions?.onChange?.({ contents: e.target.value })}
    />
  ),
}));

vi.mock("~/components/PierreDiff", () => ({
  PierreDiff: ({ oldText, newText }: { oldText: string; newText: string }) => (
    <pre data-testid="pierre-diff">{`${oldText}\n---\n${newText}`}</pre>
  ),
}));

vi.mock("~/components/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown-view">{children}</div>
  ),
}));

import type React from "react";
import { DocEditor } from "./DocEditor";

const PANE_KEY = "freehold-editor-pane";

function renderEditor(props: { initial?: string; name?: string } = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <DocEditor
      initial={props.initial ?? "Hello world"}
      name={props.name ?? "memory.md"}
      onSave={onSave}
      onCancel={onCancel}
    />
  );
  return { onSave, onCancel };
}

describe("DocEditor — Preview | Diff pane toggle", () => {
  // Stub localStorage with a simple Map — happy-dom's impl may lack Storage methods.
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.useFakeTimers();
    store.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, String(v)),
        removeItem: (k: string) => store.delete(k),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows the Preview pane by default when localStorage has no entry", () => {
    renderEditor();
    expect(screen.getByTestId("doc-editor-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("pierre-diff")).not.toBeInTheDocument();
  });

  it("shows the Preview pane when localStorage is set to 'preview'", () => {
    store.set(PANE_KEY, "preview");
    renderEditor();
    expect(screen.getByTestId("doc-editor-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("pierre-diff")).not.toBeInTheDocument();
  });

  it("shows the Diff pane (no changes state) when localStorage is set to 'diff'", () => {
    store.set(PANE_KEY, "diff");
    renderEditor();
    expect(screen.queryByTestId("doc-editor-preview")).not.toBeInTheDocument();
    // No edits yet → "No changes." (draft equals saved)
    expect(screen.getByText("No changes.")).toBeInTheDocument();
  });

  it("clicking 'Diff' switches from Preview to Diff pane", () => {
    renderEditor();
    expect(screen.getByTestId("doc-editor-preview")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));

    expect(screen.queryByTestId("doc-editor-preview")).not.toBeInTheDocument();
    // No edits yet → "No changes." shown in diff pane
    expect(screen.getByText("No changes.")).toBeInTheDocument();
  });

  it("clicking 'Preview' switches from Diff to Preview pane", () => {
    store.set(PANE_KEY, "diff");
    renderEditor();
    // Diff pane with no changes shows "No changes."
    expect(screen.getByText("No changes.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(screen.getByTestId("doc-editor-preview")).toBeInTheDocument();
    expect(screen.queryByText("No changes.")).not.toBeInTheDocument();
  });

  it("persists pane choice to localStorage when switching to Diff", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(store.get(PANE_KEY)).toBe("diff");
  });

  it("persists pane choice to localStorage when switching to Preview", () => {
    store.set(PANE_KEY, "diff");
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(store.get(PANE_KEY)).toBe("preview");
  });

  it("diff pane passes saved content as oldText and debouncedDraft as newText", async () => {
    store.set(PANE_KEY, "diff");
    renderEditor({ initial: "saved text" });

    const editor = screen.getByTestId("pierre-file-editor");
    fireEvent.change(editor, { target: { value: "updated text" } });

    // Before debounce fires: debouncedDraft still equals initial → "No changes."
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(screen.queryByTestId("pierre-diff")).not.toBeInTheDocument();
    expect(screen.getByText("No changes.")).toBeInTheDocument();

    // After debounce fires: debouncedDraft = "updated text" ≠ initial → diff shown
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const diffEl = screen.getByTestId("pierre-diff");
    expect(diffEl.textContent).toContain("saved text");
    expect(diffEl.textContent).toContain("updated text");
  });

  it("diff pane renders PierreDiff after edits are made", async () => {
    store.set(PANE_KEY, "diff");
    renderEditor({ initial: "original", name: "notes.md" });

    // Type a change to get out of no-changes state
    const editor = screen.getByTestId("pierre-file-editor");
    fireEvent.change(editor, { target: { value: "changed" } });

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(screen.getByTestId("pierre-diff")).toBeInTheDocument();
  });

  it("shows 'No changes.' when draft equals saved content", async () => {
    store.set(PANE_KEY, "diff");
    renderEditor({ initial: "same content" });

    // Advance debounce so debouncedDraft equals initial
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(screen.queryByTestId("pierre-diff")).not.toBeInTheDocument();
    expect(screen.getByText("No changes.")).toBeInTheDocument();
  });

  it("'No changes.' disappears once the user edits content", async () => {
    store.set(PANE_KEY, "diff");
    renderEditor({ initial: "same content" });

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("No changes.")).toBeInTheDocument();

    const editor = screen.getByTestId("pierre-file-editor");
    fireEvent.change(editor, { target: { value: "changed content" } });

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(screen.queryByText("No changes.")).not.toBeInTheDocument();
    expect(screen.getByTestId("pierre-diff")).toBeInTheDocument();
  });

  it("segmented control has both 'Preview' and 'Diff' buttons", () => {
    renderEditor();
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument();
  });
});
