/**
 * Task 2 — Git proposal API routes tests.
 *
 * Tests:
 *   - GET /api/v1/git/proposals → 400 on memory (default) graph
 *   - GET /api/v1/graphs/:id/git/proposals → 200 { proposals: GitProposal[] }
 *   - GET /api/v1/graphs/:id/git/proposals/:sha → 200 GitProposal | 404
 *   - POST /api/v1/graphs/:id/git/proposals/:sha/decide → 200 DecideResult; 409 key-missing
 *   - POST /api/v1/graphs/:id/git/proposals/:sha/reviews → creates review nodes, returns saved/pending status
 *   - GET /api/v1/graphs/:id/git/proposals/:sha/reviews → lists reviews + comments for that sha
 *
 * Task 4 — Region-rule e2e:
 *   - Branch touching a classified path (region rule) → card shows the region requirement →
 *     decide → notes ref updated → re-list shows approved with empty unmet.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AllodGraph } from "@allod/core";
import {
  GraphManager,
  approve,
  createGraph,
  hashEmbedder,
  installOntology,
  loadConfig,
  syncIndex,
} from "@freehold/core";

/** Filesystem-safe dir component from a graph id (mirrors allod's graph_dir_component). */
function graphDirComponent(graphId: string): string {
  const stripped = graphId.startsWith("sha256:") ? graphId.slice("sha256:".length) : graphId;
  return stripped.replace(/[^A-Za-z0-9._-]/g, "-");
}
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function assetYaml(name: string): string {
  const url = new URL(`../../core/assets/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

function stripOntologyPreamble(yaml: string): string {
  const lines = yaml.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trimStart().startsWith("#")) {
    start++;
  }
  const result: string[] = [];
  let inImports = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^imports:/.test(line)) {
      inImports = true;
      continue;
    }
    if (inImports && (line.startsWith(" ") || line.startsWith("\t") || line === "")) {
      if (line === "") inImports = false;
      continue;
    }
    inImports = false;
    result.push(line);
  }
  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let home: string;
let repoDir: string;
let repoBasename: string;
let app: ReturnType<typeof createApp>;
let token: string;
let repoGraphId: string;
let manager: GraphManager;
let mainSha: string;
let featureSha: string;
let keysDir: string;
let allodGraphId: string;

const origKeysDir = process.env.ALLOD_KEYS_DIR;

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await app.request(path, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

beforeAll(async () => {
  home = makeTempDir("freehold-gitreview-api-home-");
  keysDir = makeTempDir("freehold-gitreview-api-keys-");
  process.env.ALLOD_KEYS_DIR = keysDir;

  const config = loadConfig(home);
  token = config.token;
  manager = await GraphManager.open(home);
  app = createApp(manager, hashEmbedder, config);

  // Set up git repo
  repoDir = makeTempDir("freehold-gitreview-api-repo-");
  repoBasename = basename(repoDir);

  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

  // main: initial commit
  writeFileSync(join(repoDir, "README.md"), "# test");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  mainSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

  // feature branch: commit touching src/lib.rs
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "lib.rs"), "// library");
  execFileSync("git", ["add", "src/lib.rs"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "add src/lib.rs"], { cwd: repoDir });
  featureSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  execFileSync("git", ["checkout", "main"], { cwd: repoDir });

  // Create allod graph
  await createGraph(repoDir, "owner");

  // Read allodGraphId from disk
  const graphYaml = readFileSync(join(repoDir, ".allod", "graph.yaml"), "utf8");
  const idMatch = graphYaml.match(/\bgraph_id:\s*(.+)/);
  allodGraphId = idMatch ? idMatch[1].trim() : "gitreview-api-test";

  // Register the repo graph through the API
  repoGraphId = `gitreview-api-test-${Date.now()}`;
  const { status: regStatus } = await req("POST", "/api/v1/graphs", {
    path: repoDir,
    id: repoGraphId,
    name: "GitReview API Test Repo",
  });
  expect(regStatus, "failed to register repo graph").toBe(201);

  // Get the freehold handle from the manager
  const fh = await manager.get(repoGraphId);

  // Install code ontology
  const codeYaml = stripOntologyPreamble(assetYaml("code-ontology.yaml"));
  const codeInstall = await installOntology(fh.graph, codeYaml);
  if (codeInstall.status === "pending" && codeInstall.hash) {
    const d = await approve(fh.graph, "owner", codeInstall.hash);
    expect(d.status).toBe("approved");
  }

  // Install review ontology
  const reviewYaml = stripOntologyPreamble(assetYaml("review-ontology.yaml"));
  const reviewInstall = await installOntology(fh.graph, reviewYaml);
  if (reviewInstall.status === "pending" && reviewInstall.hash) {
    const d = await approve(fh.graph, "owner", reviewInstall.hash);
    expect(d.status).toBe("approved");
  }

  // Add a `reviewer` principal with a key
  await fh.graph.principal_add("reviewer", "agent", "owner");

  // Copy reviewer key to ALLOD_KEYS_DIR
  const reviewerKeyPath = join(repoDir, ".allod", "keys", "reviewer.yaml");
  const reviewerKeyYaml = readFileSync(reviewerKeyPath, "utf8");
  const graphComp = graphDirComponent(allodGraphId);
  mkdirSync(join(keysDir, graphComp), { recursive: true });
  writeFileSync(join(keysDir, graphComp, "reviewer.yaml"), reviewerKeyYaml);

  // Install git-substrate policy binding reviewer role
  const policyYaml = `policy: gitreview-api-test-policy
version: 1
default_posture: permissive
roles:
  reviewer:
    - principal:reviewer
rules:
  - name: src-review
    select:
      substrate: git
      path: "src/**"
    require:
      reviewers:
        - role: reviewer
          quorum: 1
`;
  const policyResult = await fh.graph.install_policy(policyYaml, "owner");
  if (policyResult && typeof policyResult === "object" && "Held" in policyResult) {
    const d = await approve(
      fh.graph,
      "owner",
      (policyResult as { Held: { hash: string } }).Held.hash
    );
    expect(d.status, "policy approval failed").toBe("approved");
  }

  await syncIndex(fh, hashEmbedder);
}, 180_000);

afterAll(() => {
  if (origKeysDir === undefined) {
    process.env.ALLOD_KEYS_DIR = undefined;
  } else {
    process.env.ALLOD_KEYS_DIR = origKeysDir;
  }
  if (home) rmSync(home, { recursive: true, force: true });
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  if (keysDir) rmSync(keysDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 400 on memory (default) graph — scoped-guard test
// ---------------------------------------------------------------------------

describe("git proposal routes on memory graph return 400", () => {
  test("GET /api/v1/git/proposals → 400 with error message", async () => {
    const { status, body } = await req("GET", "/api/v1/git/proposals");
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("git review is only available for repo graphs");
  });

  test("GET /api/v1/git/proposals/:sha → 400 on memory graph", async () => {
    const { status, body } = await req("GET", `/api/v1/git/proposals/${mainSha}`);
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("git review is only available for repo graphs");
  });

  test("POST /api/v1/git/proposals/:sha/decide → 400 on memory graph", async () => {
    const { status, body } = await req("POST", `/api/v1/git/proposals/${mainSha}/decide`, {
      verdict: "approve",
      by: "reviewer",
    });
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("git review is only available for repo graphs");
  });

  test("POST /api/v1/git/proposals/:sha/reviews → 400 on memory graph", async () => {
    const { status, body } = await req("POST", `/api/v1/git/proposals/${mainSha}/reviews`, {
      verdict: "approve",
      body: "looks good",
      by: "reviewer",
    });
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("git review is only available for repo graphs");
  });

  test("GET /api/v1/git/proposals/:sha/reviews → 400 on memory graph", async () => {
    const { status, body } = await req("GET", `/api/v1/git/proposals/${mainSha}/reviews`);
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("git review is only available for repo graphs");
  });
});

// ---------------------------------------------------------------------------
// SHA validation — route 400 for injection-style params
// ---------------------------------------------------------------------------

describe("sha validation — route 400 for injection-style params", () => {
  test("GET /git/proposals/:sha rejects --output=evil", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/git/proposals/--output%3Devil`
    );
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("invalid commit sha");
  });

  test("POST /git/proposals/:sha/decide rejects --help", async () => {
    const { status, body } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/--help/decide`,
      { verdict: "approve", by: "reviewer" }
    );
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("invalid commit sha");
  });

  test("GET /git/proposals/:sha accepts 7-char hex", async () => {
    // A valid-format sha that doesn't exist → 404, not 400
    const { status } = await req("GET", `/api/v1/graphs/${repoGraphId}/git/proposals/abc1234`);
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Scoped repo graph — list and detail
// ---------------------------------------------------------------------------

describe("GET /api/v1/graphs/:id/git/proposals on repo graph", () => {
  test("returns 200 with proposals array", async () => {
    const { status, body } = await req("GET", `/api/v1/graphs/${repoGraphId}/git/proposals`);
    expect(status).toBe(200);
    const b = body as { proposals: unknown[] };
    expect(Array.isArray(b.proposals)).toBe(true);
  });

  test("proposals contain sha, ref, author, timestamp, message, decided, paths, checklist, matched, unmet", async () => {
    const { body } = await req("GET", `/api/v1/graphs/${repoGraphId}/git/proposals`);
    const b = body as { proposals: Array<Record<string, unknown>> };
    expect(b.proposals.length).toBeGreaterThan(0);
    const p = b.proposals[0];
    expect(typeof p.sha).toBe("string");
    expect(typeof p.ref).toBe("string");
    expect(typeof p.author).toBe("string");
    expect(typeof p.timestamp).toBe("string");
    expect(typeof p.message).toBe("string");
    expect(["undecided", "approved", "rejected"]).toContain(p.decided);
    expect(Array.isArray(p.paths)).toBe(true);
    expect(Array.isArray(p.checklist)).toBe(true);
    expect(Array.isArray(p.matched)).toBe(true);
    expect(Array.isArray(p.unmet)).toBe(true);
  });

  test("feature sha appears with src-review matched and decided undecided", async () => {
    const { body } = await req("GET", `/api/v1/graphs/${repoGraphId}/git/proposals`);
    const b = body as { proposals: Array<Record<string, unknown>> };
    const feature = b.proposals.find((p) => p.sha === featureSha);
    expect(feature, "feature proposal not in list").toBeDefined();
    expect(feature?.decided).toBe("undecided");
    expect(feature?.matched as string[]).toContain("src-review");
  });
});

describe("GET /api/v1/graphs/:id/git/proposals/:sha on repo graph", () => {
  test("returns 200 with correct shape for feature sha", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${featureSha}`
    );
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.sha).toBe(featureSha);
    expect(b.decided).toBe("undecided");
    expect(b.matched as string[]).toContain("src-review");
  });

  test("returns 404 for unknown sha", async () => {
    const { status } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/git/proposals/0000000000000000000000000000000000000000`
    );
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST decide
// ---------------------------------------------------------------------------

describe("POST /api/v1/graphs/:id/git/proposals/:sha/decide — approve", () => {
  test("returns 200 with outcome approved and marks proposal decided", async () => {
    const { status, body } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${featureSha}/decide`,
      { verdict: "approve", by: "reviewer" }
    );
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.outcome).toBe("approved");
    // autoPushNotes defaults to false → push skipped, not failed
    expect(b.pushed).toBe(false);
    expect(b.pushSkipped).toBe(true);
  });

  test("note persists on disk after decide", async () => {
    // git notes show the allod-decisions note for featureSha in the actual repo
    const note = execFileSync("git", ["notes", "--ref=allod-decisions", "show", featureSha], {
      cwd: repoDir,
    })
      .toString()
      .trim();
    expect(note.length).toBeGreaterThan(0);
  });

  test("second list shows decided: approved for feature sha", async () => {
    const { body } = await req("GET", `/api/v1/graphs/${repoGraphId}/git/proposals`);
    const b = body as { proposals: Array<Record<string, unknown>> };
    const feature = b.proposals.find((p) => p.sha === featureSha);
    expect(feature).toBeDefined();
    // The decide call above approved it — it should be approved now
    expect(feature?.decided).toBe("approved");
  });
});

describe("POST /api/v1/graphs/:id/git/proposals/:sha/decide — missing key → 409", () => {
  test("returns 409 with code key-missing for unknown principal", async () => {
    const { status, body } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/decide`,
      { verdict: "approve", by: "nobody" }
    );
    expect(status).toBe(409);
    const b = body as { error: string; code: string };
    expect(b.code).toBe("key-missing");
  });
});

describe("POST /api/v1/graphs/:id/git/proposals/:sha/decide — validation", () => {
  test("returns 400 when body is missing verdict", async () => {
    const { status } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/decide`,
      { by: "reviewer" }
    );
    expect(status).toBe(400);
  });

  test("returns 400 when body is missing by", async () => {
    const { status } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/decide`,
      { verdict: "approve" }
    );
    expect(status).toBe(400);
  });

  test("returns 404 for unknown sha", async () => {
    const { status } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/0000000000000000000000000000000000000000/decide`,
      { verdict: "approve", by: "reviewer" }
    );
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST reviews — creates review/Review@1 and review/ReviewComment@1 nodes
// ---------------------------------------------------------------------------

describe("POST /api/v1/graphs/:id/git/proposals/:sha/reviews", () => {
  let reviewId: string;
  let commentIds: string[];
  let reviewStatus: string;

  test("creates a review and returns reviewId, commentIds, status", async () => {
    const { status, body } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/reviews`,
      {
        verdict: "approve",
        body: "Looks good to me.",
        by: "reviewer",
        comments: [{ body: "Nice change", anchor: `git:repo#${mainSha}:README.md` }],
      }
    );
    expect(status).toBe(200);
    const b = body as { reviewId: string; commentIds: string[]; status: string };
    expect(typeof b.reviewId).toBe("string");
    expect(Array.isArray(b.commentIds)).toBe(true);
    expect(b.commentIds.length).toBe(1);
    expect(["saved", "pending"]).toContain(b.status);
    reviewId = b.reviewId;
    commentIds = b.commentIds;
    reviewStatus = b.status;
  });

  test("review status is honest (saved or pending, not 'admitted' or 'held')", async () => {
    // Already verified in previous test, but explicit assertion
    expect(["saved", "pending"]).toContain(reviewStatus);
  });

  test("POST reviews without comments works", async () => {
    const { status, body } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/reviews`,
      {
        verdict: "request-changes",
        body: "Needs more work.",
        by: "reviewer",
      }
    );
    expect(status).toBe(200);
    const b = body as { reviewId: string; commentIds: string[]; status: string };
    expect(typeof b.reviewId).toBe("string");
    expect(b.commentIds).toHaveLength(0);
  });

  test("returns 400 when verdict is missing", async () => {
    const { status } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/reviews`,
      { body: "Missing verdict", by: "reviewer" }
    );
    expect(status).toBe(400);
  });

  test("returns 400 when by is missing", async () => {
    const { status } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/reviews`,
      { verdict: "approve", body: "Missing by" }
    );
    expect(status).toBe(400);
  });

  test("returns 404 for unknown sha", async () => {
    const { status } = await req(
      "POST",
      `/api/v1/graphs/${repoGraphId}/git/proposals/0000000000000000000000000000000000000000/reviews`,
      { verdict: "approve", body: "review for unknown sha", by: "reviewer" }
    );
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET reviews — retrieves reviews + comments for sha
// ---------------------------------------------------------------------------

describe("GET /api/v1/graphs/:id/git/proposals/:sha/reviews", () => {
  // We rely on the reviews created above in the POST describe block.
  // Because describe blocks run sequentially and the beforeAll is shared,
  // the reviews for mainSha are already in the graph.

  test("returns 200 with reviews array for mainSha", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/reviews`
    );
    expect(status).toBe(200);
    const b = body as { reviews: unknown[] };
    expect(Array.isArray(b.reviews)).toBe(true);
  });

  test("reviews have reviewId, verdict, commit bound to sha, and comments array", async () => {
    const { body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/reviews`
    );
    const b = body as {
      reviews: Array<{
        reviewId: string;
        verdict: string;
        commit: string;
        body: string;
        author: string;
        status: string;
        comments: Array<{ body: string; anchor?: string }>;
      }>;
    };
    expect(b.reviews.length).toBeGreaterThan(0);
    const review = b.reviews[0];
    expect(typeof review.reviewId).toBe("string");
    expect(typeof review.verdict).toBe("string");
    // commit attribute must be in canonical git:<repo>#<sha> format
    expect(review.commit).toBe(`git:${repoBasename}#${mainSha}`);
    expect(Array.isArray(review.comments)).toBe(true);
    expect(["saved", "pending"]).toContain(review.status);
  });

  test("GET reviews round-trip: comment count and body/anchor match what was posted", async () => {
    const { body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${mainSha}/reviews`
    );
    const b = body as {
      reviews: Array<{
        verdict: string;
        comments: Array<{ body: string; anchor?: string }>;
      }>;
    };
    // The first POST review for mainSha posted 1 comment with body "Nice change"
    // and anchor `git:repo#${mainSha}:README.md`
    const reviewWithComment = b.reviews.find((r) => r.comments.length > 0);
    expect(reviewWithComment, "no review with comments found").toBeDefined();
    expect(reviewWithComment?.comments.length).toBe(1);
    expect(reviewWithComment?.comments[0].body).toBe("Nice change");
    expect(reviewWithComment?.comments[0].anchor).toBe(`git:repo#${mainSha}:README.md`);
  });

  test("reviews for featureSha returns empty array (no reviews posted for that sha)", async () => {
    // featureSha had a decide call, but no POST /reviews
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${featureSha}/reviews`
    );
    expect(status).toBe(200);
    const b = body as { reviews: unknown[] };
    expect(b.reviews.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4: Region-rule e2e exit criterion
//
// Exit criterion from the spec: branch touching a classified path (region rule,
// not just path rule) → card shows the region requirement → decide → notes ref
// updated → re-list shows approved with empty unmet.
//
// This fixture uses a fresh isolated graph so it does not share state with the
// path-rule tests above.
// ---------------------------------------------------------------------------

describe("Task 4 e2e: region-rule — classified path → proposal card → decide → re-list", () => {
  let regionHome: string;
  let regionRepoDir: string;
  let regionApp: ReturnType<typeof createApp>;
  let regionToken: string;
  let regionGraphId: string;
  let regionManager: GraphManager;
  let regionKeysDir: string;
  let regionFeatureSha: string;

  beforeAll(async () => {
    regionHome = makeTempDir("freehold-gitreview-region-home-");
    regionKeysDir = makeTempDir("freehold-gitreview-region-keys-");
    // Override ALLOD_KEYS_DIR for this fixture's decide calls.
    // The outer afterAll restores the original value at suite teardown.
    process.env.ALLOD_KEYS_DIR = regionKeysDir;

    const config = loadConfig(regionHome);
    regionToken = config.token;
    regionManager = await GraphManager.open(regionHome);
    regionApp = createApp(regionManager, hashEmbedder, config);

    // Build git repo
    regionRepoDir = makeTempDir("freehold-gitreview-region-repo-");
    execFileSync("git", ["init", "-b", "main"], { cwd: regionRepoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: regionRepoDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: regionRepoDir });

    // main: initial commit
    writeFileSync(join(regionRepoDir, "README.md"), "# region test");
    execFileSync("git", ["add", "README.md"], { cwd: regionRepoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: regionRepoDir });

    // feature branch: commit touching classified/secret.rs
    execFileSync("git", ["checkout", "-b", "feature-region"], { cwd: regionRepoDir });
    mkdirSync(join(regionRepoDir, "classified"), { recursive: true });
    writeFileSync(join(regionRepoDir, "classified", "secret.rs"), "// classified code");
    execFileSync("git", ["add", "classified/secret.rs"], { cwd: regionRepoDir });
    execFileSync("git", ["commit", "-m", "add classified/secret.rs"], { cwd: regionRepoDir });
    regionFeatureSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: regionRepoDir })
      .toString()
      .trim();
    execFileSync("git", ["checkout", "main"], { cwd: regionRepoDir });

    // Create allod graph
    await createGraph(regionRepoDir, "owner");

    // Read allodGraphId
    const graphYaml = readFileSync(join(regionRepoDir, ".allod", "graph.yaml"), "utf8");
    const idMatch = graphYaml.match(/\bgraph_id:\s*(.+)/);
    const regionAllodGraphId = idMatch ? idMatch[1].trim() : "region-test";

    // Register through API
    regionGraphId = `gitreview-region-test-${Date.now()}`;
    const { status: regStatus } = await regionReq("POST", "/api/v1/graphs", {
      path: regionRepoDir,
      id: regionGraphId,
      name: "GitReview Region Test Repo",
    });
    expect(regStatus, "failed to register region repo graph").toBe(201);

    const fh = await regionManager.get(regionGraphId);

    // Install code ontology
    const codeYaml = stripOntologyPreamble(assetYaml("code-ontology.yaml"));
    const codeInstall = await installOntology(fh.graph, codeYaml);
    if (codeInstall.status === "pending" && codeInstall.hash) {
      const d = await approve(fh.graph, "owner", codeInstall.hash);
      expect(d.status).toBe("approved");
    }

    // Install review ontology
    const reviewYaml = stripOntologyPreamble(assetYaml("review-ontology.yaml"));
    const reviewInstall = await installOntology(fh.graph, reviewYaml);
    if (reviewInstall.status === "pending" && reviewInstall.hash) {
      const d = await approve(fh.graph, "owner", reviewInstall.hash);
      expect(d.status).toBe("approved");
    }

    // Create SourceFile node for classified/secret.rs so it appears as indexed
    const sfId = crypto.randomUUID();
    const rawCs = await fh.graph.commit(
      "owner",
      "index classified/secret.rs",
      [
        {
          create: {
            kind: "node",
            id: sfId,
            type: "code/SourceFile@1",
            attributes: {
              path: "classified/secret.rs",
              language: "rust",
              blob: `git:${basename(regionRepoDir)}#HEAD:classified/secret.rs`,
            },
          },
        },
      ],
      [],
      true
    );
    if (rawCs && typeof rawCs === "object" && "Held" in rawCs) {
      const d = await approve(fh.graph, "owner", (rawCs as { Held: { hash: string } }).Held.hash);
      expect(d.status).toBe("approved");
    }

    // Install security taxonomy
    const secTaxYaml = `security-taxonomy:
  taxonomy: security-taxonomy
  version: 1
  terms:
    - { name: security, parents: [] }
    - { name: "security/critical", parents: [security] }
`;
    const taxResult = await fh.graph.install_package(secTaxYaml, "owner");
    if (taxResult && typeof taxResult === "object" && "Held" in taxResult) {
      const d = await approve(
        fh.graph,
        "owner",
        (taxResult as { Held: { hash: string } }).Held.hash
      );
      expect(d.status).toBe("approved");
    }

    // Classify classified/secret.rs as security/critical
    const clsResult = await fh.graph.classify(sfId, "security/critical", "owner", "human-reviewed");
    if (clsResult && typeof clsResult === "object" && "Held" in clsResult) {
      const d = await approve(
        fh.graph,
        "owner",
        (clsResult as { Held: { hash: string } }).Held.hash
      );
      expect(d.status).toBe("approved");
    }

    // Add reviewer principal
    await fh.graph.principal_add("reviewer", "agent", "owner");

    // Copy reviewer key to ALLOD_KEYS_DIR
    const reviewerKeyPath = join(regionRepoDir, ".allod", "keys", "reviewer.yaml");
    const reviewerKeyYaml = readFileSync(reviewerKeyPath, "utf8");
    const graphComp = graphDirComponent(regionAllodGraphId);
    mkdirSync(join(regionKeysDir, graphComp), { recursive: true });
    writeFileSync(join(regionKeysDir, graphComp, "reviewer.yaml"), reviewerKeyYaml);

    // Install policy with a REGION rule (not a path rule)
    const policyYaml = `policy: region-test-policy
version: 1
default_posture: permissive
roles:
  security-reviewer:
    - principal:reviewer
rules:
  - name: security-critical-region
    select:
      substrate: git
      region: "security/critical"
    require:
      reviewers:
        - role: security-reviewer
          quorum: 1
`;
    const policyResult = await fh.graph.install_policy(policyYaml, "owner");
    if (policyResult && typeof policyResult === "object" && "Held" in policyResult) {
      const d = await approve(
        fh.graph,
        "owner",
        (policyResult as { Held: { hash: string } }).Held.hash
      );
      expect(d.status, "region policy approval failed").toBe("approved");
    }

    await syncIndex(fh, hashEmbedder);
  }, 180_000);

  afterAll(() => {
    if (regionHome) rmSync(regionHome, { recursive: true, force: true });
    if (regionRepoDir) rmSync(regionRepoDir, { recursive: true, force: true });
    if (regionKeysDir) rmSync(regionKeysDir, { recursive: true, force: true });
  });

  function regionReq(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown }> {
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${regionToken}`,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return regionApp.request(path, init).then(async (res) => ({
      status: res.status,
      body: await res.json().catch(() => null),
    }));
  }

  test("GET proposals: feature commit touching classified path shows region rule in matched", async () => {
    const { status, body } = await regionReq(
      "GET",
      `/api/v1/graphs/${regionGraphId}/git/proposals`
    );
    expect(status).toBe(200);
    const b = body as { proposals: Array<Record<string, unknown>> };
    const feature = b.proposals.find((p) => p.sha === regionFeatureSha);
    expect(feature, "feature proposal not found in region test").toBeDefined();
    // The region rule should appear in matched
    expect(feature?.matched as string[]).toContain("security-critical-region");
  });

  test("GET proposals: feature commit has non-empty unmet (region rule requirement unsatisfied)", async () => {
    const { body } = await regionReq("GET", `/api/v1/graphs/${regionGraphId}/git/proposals`);
    const b = body as { proposals: Array<Record<string, unknown>> };
    const feature = b.proposals.find((p) => p.sha === regionFeatureSha);
    expect(feature).toBeDefined();
    expect(feature?.decided).toBe("undecided");
    expect((feature?.unmet as string[]).length).toBeGreaterThan(0);
  });

  test("GET proposals: classified path shows region badge in paths", async () => {
    const { body } = await regionReq("GET", `/api/v1/graphs/${regionGraphId}/git/proposals`);
    const b = body as { proposals: Array<Record<string, unknown>> };
    const feature = b.proposals.find((p) => p.sha === regionFeatureSha);
    expect(feature).toBeDefined();
    const paths = feature?.paths as Array<{ path: string; regions: string[]; indexed: boolean }>;
    const secretPath = paths.find((p) => p.path === "classified/secret.rs");
    expect(secretPath, "classified/secret.rs not in paths").toBeDefined();
    // The region badge should show the region rule name
    expect(secretPath?.regions).toContain("security-critical-region");
    // The path is indexed (SourceFile node was created)
    expect(secretPath?.indexed).toBe(true);
  });

  test("POST decide: approve with reviewer → outcome approved", async () => {
    const { status, body } = await regionReq(
      "POST",
      `/api/v1/graphs/${regionGraphId}/git/proposals/${regionFeatureSha}/decide`,
      { verdict: "approve", by: "reviewer" }
    );
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.outcome).toBe("approved");
  });

  test("git notes ref updated in repo after decide", () => {
    const note = execFileSync("git", ["notes", "--ref=allod-decisions", "show", regionFeatureSha], {
      cwd: regionRepoDir,
    })
      .toString()
      .trim();
    expect(note.length).toBeGreaterThan(0);
  });

  test("re-list shows approved with empty unmet after decide", async () => {
    const { body } = await regionReq("GET", `/api/v1/graphs/${regionGraphId}/git/proposals`);
    const b = body as { proposals: Array<Record<string, unknown>> };
    const feature = b.proposals.find((p) => p.sha === regionFeatureSha);
    expect(feature).toBeDefined();
    expect(feature?.decided).toBe("approved");
    expect((feature?.unmet as string[]).length).toBe(0);
  });
});
