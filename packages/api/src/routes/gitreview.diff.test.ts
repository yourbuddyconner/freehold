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
import type { AppEnv } from "../types.js";
import { gitreviewRouter } from "./gitreview.js";

const mockCommitDiff = vi.mocked(commitDiff);
const mockGitProposal = vi.mocked(gitProposal);

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
    const fakeProposal = {
      sha: "abc1234abc1234abc1234abc1234abc1234abc1234",
      decided: "undecided",
    } as never;
    mockGitProposal.mockResolvedValue(fakeProposal);
    mockCommitDiff.mockResolvedValue({
      files: [
        {
          path: "src/main.rs",
          verb: "M" as const,
          binary: false,
          oldContent: "old\n",
          newContent: "new\n",
          truncated: false,
        },
      ],
      truncated: false,
    });

    const res = await app.request("/git/proposals/abc1234abc1234/diff");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: unknown[]; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.files).toHaveLength(1);
    expect((body.files[0] as { path: string }).path).toBe("src/main.rs");
  });

  test("truncated:true when commitDiff returns truncated:true", async () => {
    const app = buildApp();
    const fakeProposal = {
      sha: "abc1234abc1234abc1234abc1234abc1234abc1234",
      decided: "undecided",
    } as never;
    mockGitProposal.mockResolvedValue(fakeProposal);

    mockCommitDiff.mockResolvedValue({
      files: [
        {
          path: "a.txt",
          verb: "M" as const,
          binary: false,
          oldContent: "",
          newContent: "",
          truncated: true,
        },
      ],
      truncated: true,
    });

    const res = await app.request("/git/proposals/abc1234abc1234/diff");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: unknown[]; truncated: boolean };
    expect(body.truncated).toBe(true);
  });

  test("binary file has binary:true and empty contents", async () => {
    const app = buildApp();
    const fakeProposal = {
      sha: "abc1234abc1234abc1234abc1234abc1234abc1234",
      decided: "undecided",
    } as never;
    mockGitProposal.mockResolvedValue(fakeProposal);
    mockCommitDiff.mockResolvedValue({
      files: [
        {
          path: "image.png",
          verb: "A" as const,
          binary: true,
          oldContent: "",
          newContent: "",
          truncated: false,
        },
      ],
      truncated: false,
    });

    const res = await app.request("/git/proposals/abc1234abc1234/diff");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: { binary: boolean; oldContent: string; newContent: string }[];
      truncated: boolean;
    };
    expect(body.files[0].binary).toBe(true);
    expect(body.files[0].oldContent).toBe("");
    expect(body.files[0].newContent).toBe("");
  });
});
