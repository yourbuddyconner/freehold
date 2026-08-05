/**
 * Tests for GET /git/proposals/:sha/diff API route.
 *
 * We test route-level behavior (400/404/200/truncated) by mocking
 * commitDiff and gitProposal from @freehold/core.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock @freehold/core before importing the router
vi.mock("@freehold/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@freehold/core")>();
  return {
    ...actual,
    commitDiff: vi.fn(),
    gitProposal: vi.fn(),
    listGitProposals: vi.fn().mockResolvedValue({ proposals: [] }),
    listReviewsForSha: vi.fn().mockResolvedValue([]),
    decideGit: vi.fn(),
    pushNotes: vi.fn(),
    KeyMissingError: actual.KeyMissingError,
    withGraph: vi.fn((_g: unknown, fn: () => unknown) => fn()),
  };
});

import { commitDiff, gitProposal } from "@freehold/core";
import { gitreviewRouter } from "./gitreview.js";

const mockCommitDiff = vi.mocked(commitDiff);
const mockGitProposal = vi.mocked(gitProposal);

function buildApp(kind = "repo") {
  const app = new Hono();
  const fakeFreehold = {
    kind,
    graphDir: "/tmp/fake-repo",
    graphId: "g1",
    graph: {},
  };
  app.use("*", async (c, next) => {
    c.set("freehold", fakeFreehold);
    c.set("manager", { getEntry: vi.fn().mockResolvedValue({ allodGraphId: "g1", autoPushNotes: false, originRemote: null }) });
    await next();
  });
  app.route("/", gitreviewRouter);
  return app;
}

describe("GET /git/proposals/:sha/diff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("400 for memory graph", async () => {
    const app = buildApp("memory");
    const res = await app.request("/git/proposals/abc1234/diff");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/repo graph/i);
  });

  test("400 for invalid sha", async () => {
    const app = buildApp();
    const res = await app.request("/git/proposals/-bad/diff");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
  });

  test("404 when proposal not found", async () => {
    const app = buildApp();
    mockGitProposal.mockResolvedValue(null);
    const res = await app.request("/git/proposals/abc1234abc1234/diff");
    expect(res.status).toBe(404);
  });

  test("200 with files array and truncated:false for normal diff", async () => {
    const app = buildApp();
    const fakeProposal = { sha: "abc1234abc1234abc1234abc1234abc1234abc1234", decided: "undecided" } as never;
    mockGitProposal.mockResolvedValue(fakeProposal);
    mockCommitDiff.mockResolvedValue([
      { path: "src/main.rs", verb: "M", patch: "@@ -1 +1 @@\n-old\n+new\n", binary: false },
    ]);

    const res = await app.request("/git/proposals/abc1234abc1234/diff");
    expect(res.status).toBe(200);
    const body = await res.json() as { files: unknown[]; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.files).toHaveLength(1);
    expect((body.files[0] as { path: string }).path).toBe("src/main.rs");
  });

  test("truncated:true when commitDiff returns >= 1MB total patch", async () => {
    const app = buildApp();
    const fakeProposal = { sha: "abc1234abc1234abc1234abc1234abc1234abc1234", decided: "undecided" } as never;
    mockGitProposal.mockResolvedValue(fakeProposal);

    const bigPatch = "x".repeat(600_000);
    mockCommitDiff.mockResolvedValue([
      { path: "a.txt", verb: "M", patch: bigPatch, binary: false },
      { path: "b.txt", verb: "M", patch: bigPatch, binary: false },
    ]);

    const res = await app.request("/git/proposals/abc1234abc1234/diff");
    expect(res.status).toBe(200);
    const body = await res.json() as { files: unknown[]; truncated: boolean };
    expect(body.truncated).toBe(true);
  });

  test("binary file has binary:true and empty patch", async () => {
    const app = buildApp();
    const fakeProposal = { sha: "abc1234abc1234abc1234abc1234abc1234abc1234", decided: "undecided" } as never;
    mockGitProposal.mockResolvedValue(fakeProposal);
    mockCommitDiff.mockResolvedValue([
      { path: "image.png", verb: "A", patch: "", binary: true },
    ]);

    const res = await app.request("/git/proposals/abc1234abc1234/diff");
    expect(res.status).toBe(200);
    const body = await res.json() as { files: { binary: boolean; patch: string }[]; truncated: boolean };
    expect(body.files[0].binary).toBe(true);
    expect(body.files[0].patch).toBe("");
  });
});
