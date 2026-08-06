import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommentDraft,
  clearDrafts,
  loadDrafts,
  saveDrafts,
  serializeSuggestionBody,
  parseSuggestionBody,
} from "./reviewDrafts";

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

describe("serializeSuggestionBody", () => {
  it("wraps replacement in suggestion fence with prose", () => {
    const result = serializeSuggestionBody("looks good", "fn replaced() {}");
    expect(result).toBe("looks good\n```suggestion\nfn replaced() {}\n```");
  });

  it("emits only the fence when prose is empty string", () => {
    const result = serializeSuggestionBody("", "fn replaced() {}");
    expect(result).toBe("```suggestion\nfn replaced() {}\n```");
  });

  it("round-trips: parseSuggestionBody extracts prose and suggestion", () => {
    const body = serializeSuggestionBody("nice fix", "fn new() {}");
    const parsed = parseSuggestionBody(body);
    expect(parsed.prose).toBe("nice fix");
    expect(parsed.suggestion).toBe("fn new() {}");
  });
});

describe("parseSuggestionBody", () => {
  it("returns suggestion null for a plain body with no fence", () => {
    const result = parseSuggestionBody("just a comment");
    expect(result).toEqual({ prose: "just a comment", suggestion: null });
  });

  it("extracts suggestion with empty prose when fence is first", () => {
    const body = "```suggestion\nfn new() {}\n```";
    const result = parseSuggestionBody(body);
    expect(result.prose.trim()).toBe("");
    expect(result.suggestion).toBe("fn new() {}");
  });

  it("extracts suggestion from body with leading whitespace around fence", () => {
    const body = "prose line\n\n```suggestion\nfn new() {}\n```\n";
    const result = parseSuggestionBody(body);
    expect(result.prose.trim()).toBe("prose line");
    expect(result.suggestion).toBe("fn new() {}");
  });

  it("multi-line suggestion is preserved verbatim", () => {
    const suggestion = "line one\nline two\nline three";
    const body = serializeSuggestionBody("", suggestion);
    const { suggestion: parsed } = parseSuggestionBody(body);
    expect(parsed).toBe(suggestion);
  });

  it("body with no fence returns prose equal to full body", () => {
    const result = parseSuggestionBody("no fence here");
    expect(result.prose).toBe("no fence here");
    expect(result.suggestion).toBeNull();
  });
});

describe("CommentDraft with suggestion field", () => {
  it("round-trips a draft with suggestion through saveDrafts/loadDrafts", () => {
    const draft: CommentDraft = {
      path: "src/lib.rs",
      span: "L5-L7",
      body: "replace with this",
      suggestion: "fn new() {}",
    };
    saveDrafts(SHA, [draft]);
    const loaded = loadDrafts(SHA);
    expect(loaded[0]).toEqual(draft);
  });

  it("round-trips a draft without suggestion (field is absent)", () => {
    const draft: CommentDraft = { path: "src/lib.rs", span: "L5", body: "comment only" };
    saveDrafts(SHA, [draft]);
    const loaded = loadDrafts(SHA);
    expect(loaded[0].suggestion).toBeUndefined();
  });
});
