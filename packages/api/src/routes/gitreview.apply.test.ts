/**
 * Tests for POST /git/proposals/:sha/suggestions/apply API route.
 *
 * Tests route-level behavior by mocking @freehold/core.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock @freehold/core before importing the router
vi.mock("@freehold/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@freehold/core")>();
  return {
    ...actual,
    applySuggestion: vi.fn(),
    gitProposal: vi.fn(),
    commitDiff: vi.fn(),
    listGitProposals: vi.fn().mockResolvedValue({ proposals: [] }),
    listReviewsForSha: vi.fn().mockResolvedValue([]),
    decideGit: vi.fn(),
    pushNotes: vi.fn(),
    postReview: vi.fn(),
    KeyMissingError: actual.KeyMissingError,
    BranchMovedError: actual.BranchMovedError,
    BinaryFileError: actual.BinaryFileError,
    OldSideSpanError: actual.OldSideSpanError,
    InvalidSpanError: actual.InvalidSpanError,
  };
});

import {
  BinaryFileError,
  BranchMovedError,
  InvalidSpanError,
  OldSideSpanError,
  applySuggestion,
  gitProposal,
} from "@freehold/core";
import type { AppEnv } from "../types.js";
import { gitreviewRouter } from "./gitreview.js";

const mockApplySuggestion = vi.mocked(applySuggestion);
const mockGitProposal = vi.mocked(gitProposal);

const FAKE_SHA = "abc1234abc1234abc1234abc1234abc1234abc1234";

function buildApp(kind = "repo") {
  const app = new Hono<AppEnv>();
  const fakeFreehold = {
    kind,
    graphDir: "/tmp/fake-repo",
    graphId: "g1",
    graph: {},
  };
  app.use("*", async (c, next) => {
    c.set("freehold", fakeFreehold as unknown as AppEnv["Variables"]["freehold"]);
    c.set("manager", {
      getEntry: vi
        .fn()
        .mockResolvedValue({ allodGraphId: "g1", autoPushNotes: false, originRemote: null }),
    } as unknown as AppEnv["Variables"]["manager"]);
    await next();
  });
  app.route("/", gitreviewRouter);
  return app;
}

const validBody = {
  branch: "main",
  path: "src/lib.rs",
  span: "L5",
  suggestion: "fn replaced() {}",
  by: "alice",
};

describe("POST /git/proposals/:sha/suggestions/apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("400 for memory graph", async () => {
    const app = buildApp("memory");
    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/repo graph/i);
  });

  test("400 for invalid sha", async () => {
    const app = buildApp();
    const res = await app.request("/git/proposals/-bad/suggestions/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
  });

  test("400 for invalid JSON body", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue({ sha: FAKE_SHA, decided: "undecided" } as never);
    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
  });

  test("400 for missing required fields", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue({ sha: FAKE_SHA, decided: "undecided" } as never);
    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "main" }), // missing path, span, suggestion, by
    });
    expect(res.status).toBe(400);
  });

  test("404 when proposal not found", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue(null);
    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
  });

  test("200 with newSha on success", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue({ sha: FAKE_SHA, decided: "undecided" } as never);
    mockApplySuggestion.mockResolvedValue({ newSha: "deadbeef1234567890ab" });

    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { newSha: string };
    expect(body.newSha).toBe("deadbeef1234567890ab");

    // Verify applySuggestion was called with the sha as expectedTip
    expect(mockApplySuggestion).toHaveBeenCalledWith(
      "/tmp/fake-repo",
      expect.objectContaining({
        branch: "main",
        path: "src/lib.rs",
        span: "L5",
        suggestion: "fn replaced() {}",
        by: "alice",
        expectedTip: FAKE_SHA,
      })
    );
  });

  test("409 branch-moved when BranchMovedError thrown", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue({ sha: FAKE_SHA, decided: "undecided" } as never);
    mockApplySuggestion.mockRejectedValue(new BranchMovedError("main"));

    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("branch-moved");
  });

  test("422 binary-file when BinaryFileError thrown", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue({ sha: FAKE_SHA, decided: "undecided" } as never);
    mockApplySuggestion.mockRejectedValue(new BinaryFileError("image.png"));

    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("binary-file");
  });

  test("422 old-side-span when OldSideSpanError thrown", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue({ sha: FAKE_SHA, decided: "undecided" } as never);
    mockApplySuggestion.mockRejectedValue(new OldSideSpanError("old:L5"));

    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("old-side-span");
  });

  test("422 invalid-span when InvalidSpanError thrown", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue({ sha: FAKE_SHA, decided: "undecided" } as never);
    mockApplySuggestion.mockRejectedValue(new InvalidSpanError("bad span"));

    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid-span");
  });

  test("500 on unexpected error", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue({ sha: FAKE_SHA, decided: "undecided" } as never);
    mockApplySuggestion.mockRejectedValue(new Error("unexpected failure"));

    const res = await app.request(`/git/proposals/${FAKE_SHA}/suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unexpected failure/);
  });
});
