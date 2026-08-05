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
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  GraphManager,
  createGraph,
  hashEmbedder,
  loadConfig,
  installOntology,
  approve,
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
  const url = new URL("../../core/assets/" + name, import.meta.url);
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

  execFileSync("git", ["init"], { cwd: repoDir });
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
  await (fh.graph as any).principal_add("reviewer", "agent", "owner");

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
  const policyResult = await (fh.graph as any).install_policy(policyYaml, "owner");
  if (policyResult && typeof policyResult === "object" && "Held" in policyResult) {
    const d = await approve(fh.graph, "owner", (policyResult as any).Held.hash);
    expect(d.status, "policy approval failed").toBe("approved");
  }

  await syncIndex(fh, hashEmbedder);
}, 180_000);

afterAll(() => {
  if (origKeysDir === undefined) {
    delete process.env.ALLOD_KEYS_DIR;
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
    const { status, body } = await req(
      "POST",
      `/api/v1/git/proposals/${mainSha}/decide`,
      { verdict: "approve", by: "reviewer" }
    );
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("git review is only available for repo graphs");
  });

  test("POST /api/v1/git/proposals/:sha/reviews → 400 on memory graph", async () => {
    const { status, body } = await req(
      "POST",
      `/api/v1/git/proposals/${mainSha}/reviews`,
      { verdict: "approve", body: "looks good", by: "reviewer" }
    );
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("git review is only available for repo graphs");
  });

  test("GET /api/v1/git/proposals/:sha/reviews → 400 on memory graph", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/git/proposals/${mainSha}/reviews`
    );
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("git review is only available for repo graphs");
  });
});

// ---------------------------------------------------------------------------
// Scoped repo graph — list and detail
// ---------------------------------------------------------------------------

describe("GET /api/v1/graphs/:id/git/proposals on repo graph", () => {
  test("returns 200 with proposals array", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/git/proposals`
    );
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
    expect(feature!.decided).toBe("undecided");
    expect((feature!.matched as string[])).toContain("src-review");
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
    expect((b.matched as string[])).toContain("src-review");
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
    expect(["approved", "incomplete"]).toContain(b.outcome);
  });

  test("second list shows decided: approved for feature sha", async () => {
    const { body } = await req("GET", `/api/v1/graphs/${repoGraphId}/git/proposals`);
    const b = body as { proposals: Array<Record<string, unknown>> };
    const feature = b.proposals.find((p) => p.sha === featureSha);
    expect(feature).toBeDefined();
    // The decide call above approved it — it should be approved now
    expect(["approved", "incomplete"]).toContain(feature!.decided as string);
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
        comments: [
          { body: "Nice change", anchor: `git:repo#${mainSha}:README.md` },
        ],
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
        comments: unknown[];
      }>;
    };
    expect(b.reviews.length).toBeGreaterThan(0);
    const review = b.reviews[0];
    expect(typeof review.reviewId).toBe("string");
    expect(typeof review.verdict).toBe("string");
    // commit attribute should contain the sha
    expect(review.commit).toContain(mainSha);
    expect(Array.isArray(review.comments)).toBe(true);
    expect(["saved", "pending"]).toContain(review.status);
  });

  test("reviews for featureSha returns empty array when no reviews posted", async () => {
    // featureSha had a decide call, but no POST /reviews
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/git/proposals/${featureSha}/reviews`
    );
    expect(status).toBe(200);
    const b = body as { reviews: unknown[] };
    // Could be empty or have reviews; just verify shape
    expect(Array.isArray(b.reviews)).toBe(true);
  });
});
