import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommentDraft, clearDrafts, loadDrafts, saveDrafts } from "./reviewDrafts";

// Stub localStorage with a Map — happy-dom's impl may not be available in unit context
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "localStorage", {
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
  store.clear();
});

const SHA = "deadbeef1234567890";
const SHA2 = "aabbccdd1234567890";

const sampleDrafts: CommentDraft[] = [
  { path: "src/lib.rs", span: "L5", body: "looks good" },
  { path: "src/main.rs", span: "old:L3", body: "needs change" },
];

describe("reviewDrafts", () => {
  it("round-trips: loadDrafts after saveDrafts returns same data", () => {
    saveDrafts(SHA, sampleDrafts);
    const loaded = loadDrafts(SHA);
    expect(loaded).toEqual(sampleDrafts);
  });

  it("loadDrafts returns [] when nothing stored", () => {
    const loaded = loadDrafts(SHA);
    expect(loaded).toEqual([]);
  });

  it("clearDrafts removes the stored drafts", () => {
    saveDrafts(SHA, sampleDrafts);
    clearDrafts(SHA);
    expect(loadDrafts(SHA)).toEqual([]);
  });

  it("corrupt JSON returns empty array", () => {
    store.set(`freehold:review-drafts:${SHA}`, "NOT_JSON{{{");
    const loaded = loadDrafts(SHA);
    expect(loaded).toEqual([]);
  });

  it("different sha uses different key", () => {
    saveDrafts(SHA, sampleDrafts);
    saveDrafts(SHA2, [{ path: "other.ts", span: "L1", body: "other" }]);
    expect(loadDrafts(SHA)).toEqual(sampleDrafts);
    expect(loadDrafts(SHA2)).toEqual([{ path: "other.ts", span: "L1", body: "other" }]);
    clearDrafts(SHA);
    expect(loadDrafts(SHA)).toEqual([]);
    // SHA2 should still be there
    expect(loadDrafts(SHA2)).toEqual([{ path: "other.ts", span: "L1", body: "other" }]);
  });
});
