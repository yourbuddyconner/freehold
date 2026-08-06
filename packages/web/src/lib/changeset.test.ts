import { act, renderHook } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangesetProvider, useChangeset } from "./changeset";

const GRAPH_ID = "test-graph";
const STORAGE_KEY = `freehold:changeset:${GRAPH_ID}`;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(ChangesetProvider, { graphId: GRAPH_ID, children });
}

describe("changeset store", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, String(v)),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts empty", () => {
    const { result } = renderHook(() => useChangeset(), { wrapper });
    expect(result.current.entries).toHaveLength(0);
  });

  it("stage adds an entry with a generated id", () => {
    const { result } = renderHook(() => useChangeset(), { wrapper });
    act(() => {
      result.current.stage({
        kind: "policy",
        label: "policy: edit rule foo",
        payload: { rules: [] },
      });
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].label).toBe("policy: edit rule foo");
    expect(typeof result.current.entries[0].id).toBe("string");
    expect(result.current.entries[0].id.length).toBeGreaterThan(0);
  });

  it("unstage removes the entry by id", () => {
    const { result } = renderHook(() => useChangeset(), { wrapper });
    act(() => {
      result.current.stage({ kind: "policy", label: "edit A", payload: null });
      result.current.stage({ kind: "policy", label: "edit B", payload: null });
    });
    const idA = result.current.entries[0].id;
    act(() => {
      result.current.unstage(idA);
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].label).toBe("edit B");
  });

  it("clear empties the list and removes from localStorage", () => {
    const { result } = renderHook(() => useChangeset(), { wrapper });
    act(() => {
      result.current.stage({ kind: "policy", label: "edit A", payload: null });
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.entries).toHaveLength(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("persists entries to localStorage on stage", () => {
    const { result } = renderHook(() => useChangeset(), { wrapper });
    act(() => {
      result.current.stage({ kind: "policy", label: "edit A", payload: { rules: [] } });
    });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("edit A");
    expect(parsed[0].payload).toEqual({ rules: [] });
  });

  it("rehydrates entries from localStorage on mount", () => {
    const existing = [
      { id: "abc", kind: "policy", label: "policy: edit rule bar", payload: { rules: [] } },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    const { result } = renderHook(() => useChangeset(), { wrapper });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].id).toBe("abc");
    expect(result.current.entries[0].label).toBe("policy: edit rule bar");
  });

  it("setIntent updates the intent string", () => {
    const { result } = renderHook(() => useChangeset(), { wrapper });
    act(() => {
      result.current.setIntent("Tighten scratch region rules");
    });
    expect(result.current.intent).toBe("Tighten scratch region rules");
  });

  it("persists preview to localStorage when under size cap", () => {
    const { result } = renderHook(() => useChangeset(), { wrapper });
    const preview = {
      name: "policy.json",
      before: '{"rules":[]}',
      after: '{"rules":[{"name":"new"}]}',
    };
    act(() => {
      result.current.stage({
        kind: "policy",
        label: "policy: edit rule foo",
        payload: { rules: [] },
        preview,
      });
    });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "");
    expect(parsed[0].preview).toBeDefined();
    expect(parsed[0].preview.name).toBe("policy.json");
    expect(parsed[0].preview.before).toBe('{"rules":[]}');
  });

  it("strips preview from localStorage when over size cap (100KB per side)", () => {
    const { result } = renderHook(() => useChangeset(), { wrapper });
    const largeString = "x".repeat(101 * 1024);
    const preview = { name: "policy.json", before: largeString, after: '{"rules":[]}' };
    act(() => {
      result.current.stage({
        kind: "policy",
        label: "policy: edit rule bar",
        payload: { rules: [] },
        preview,
      });
    });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "");
    expect(parsed[0].preview).toBeUndefined();
  });
});
