/**
 * Code comment API route tests.
 *
 * Tests:
 *   - GET /code/comments → 400 on memory (default) graph
 *   - POST /code/comments → 400 on memory graph
 *   - GET /api/v1/graphs/:id/code/comments?path= → 200 empty list on fresh repo
 *   - POST /api/v1/graphs/:id/code/comments → 200 with commentId + anchorSha
 *   - POST /api/v1/graphs/:id/code/comments → 409 when key is missing
 *   - GET /api/v1/graphs/:id/code/comments?path= → 200 after posting
 *   - GET requires path param
 *   - POST requires path, span, body, by
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GraphManager,
  approve,
  createGraph,
  hashEmbedder,
  installOntology,
  loadConfig,
} from "@freehold/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function graphDirComponent(graphId: string): string {
  const stripped = graphId.startsWith("sha256:") ? graphId.slice("sha256:".length) : graphId;
  return stripped.replace(/[^A-Za-z0-9._-]/g, "-");
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
let keysDir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let repoGraphId: string;
let manager: GraphManager;
let allodGraphId: string;

const origKeysDir = process.env.ALLOD_KEYS_DIR;

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
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
  home = makeTempDir("freehold-code-comments-api-test-");
  keysDir = makeTempDir("freehold-code-comments-api-keys-");
  process.env.ALLOD_KEYS_DIR = keysDir;

  const config = loadConfig(home);
  token = config.token;
  manager = await GraphManager.open(home);
  app = createApp(manager, hashEmbedder, config);

  // Build repo git dir
  repoDir = makeTempDir("freehold-code-comments-repo-");
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "lib.rs"), "// library\nfn hello() {}");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

  await createGraph(repoDir, "owner");

  // Read real allod graph_id from disk
  const graphYaml = readFileSync(join(repoDir, ".allod", "graph.yaml"), "utf8");
  const idMatch = graphYaml.match(/\bgraph_id:\s*(.+)/);
  allodGraphId = idMatch ? idMatch[1].trim() : "code-comments-api-test";

  // Register the repo graph
  repoGraphId = `code-comments-api-test-${Date.now()}`;
  const { status: regStatus } = await req("POST", "/api/v1/graphs", {
    path: repoDir,
    id: repoGraphId,
    name: "Code Comments API Test Repo",
  });
  expect(regStatus, "failed to register repo graph").toBe(201);

  const fh = await manager.get(repoGraphId);

  // Install review ontology
  const reviewYaml = stripOntologyPreamble(assetYaml("review-ontology.yaml"));
  const result = await installOntology(fh.graph, reviewYaml);
  if (result.status === "pending" && result.hash) {
    const d = await approve(fh.graph, "owner", result.hash);
    expect(d.status).toBe("approved");
  }

  // Write owner key to ALLOD_KEYS_DIR
  const ownerKeyPath = join(repoDir, ".allod", "keys", "owner.yaml");
  if (existsSync(ownerKeyPath)) {
    const graphComp = graphDirComponent(allodGraphId);
    mkdirSync(join(keysDir, graphComp), { recursive: true });
    writeFileSync(join(keysDir, graphComp, "owner.yaml"), readFileSync(ownerKeyPath, "utf8"));
  }
}, 60_000);

afterAll(() => {
  process.env.ALLOD_KEYS_DIR = origKeysDir;
  if (home) rmSync(home, { recursive: true, force: true });
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  if (keysDir) rmSync(keysDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Guards — memory graph returns 400
// ---------------------------------------------------------------------------

describe("code comment routes on memory graph return 400", () => {
  test("GET /api/v1/code/comments?path=foo → 400", async () => {
    const { status, body } = await req("GET", "/api/v1/code/comments?path=foo");
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("code view is only available for repo graphs");
  });

  test("POST /api/v1/code/comments → 400", async () => {
    const { status, body } = await req("POST", "/api/v1/code/comments", {
      path: "src/lib.rs",
      span: "L1",
      body: "comment",
      by: "owner",
    });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("code view is only available for repo graphs");
  });
});

// ---------------------------------------------------------------------------
// GET /code/comments — validation
// ---------------------------------------------------------------------------

describe("GET /api/v1/graphs/:id/code/comments validation", () => {
  test("returns 400 when path param is missing", async () => {
    const { status } = await req("GET", `/api/v1/graphs/${repoGraphId}/code/comments`);
    expect(status).toBe(400);
  });

  test("returns 200 with empty comments on fresh repo", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/code/comments?path=src/lib.rs`
    );
    expect(status).toBe(200);
    const b = body as { comments: unknown[] };
    expect(Array.isArray(b.comments)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /code/comments — round-trip
// ---------------------------------------------------------------------------

describe("POST /api/v1/graphs/:id/code/comments", () => {
  test("creates a comment and returns commentId + anchorSha", async () => {
    const { status, body } = await req("POST", `/api/v1/graphs/${repoGraphId}/code/comments`, {
      path: "src/lib.rs",
      span: "L1",
      body: "This function needs docs.",
      by: "owner",
    });
    expect(status).toBe(200);
    const b = body as { commentId: string; status: string; anchorSha: string };
    expect(typeof b.commentId).toBe("string");
    expect(b.commentId).toBeTruthy();
    expect(["saved", "pending"]).toContain(b.status);
    expect(typeof b.anchorSha).toBe("string");
    expect(b.anchorSha).toHaveLength(40); // full hex sha
  });

  test("returns 409 when signing key is not found", async () => {
    const { status, body } = await req("POST", `/api/v1/graphs/${repoGraphId}/code/comments`, {
      path: "src/lib.rs",
      span: "L2",
      body: "note",
      by: "nonexistent-principal",
    });
    expect(status).toBe(409);
    const b = body as { code: string };
    expect(b.code).toBe("key-missing");
  });

  test("returns 400 when required fields are missing", async () => {
    // Missing span
    const { status } = await req("POST", `/api/v1/graphs/${repoGraphId}/code/comments`, {
      path: "src/lib.rs",
      body: "note",
      by: "owner",
    });
    expect(status).toBe(400);
  });

  test("GET after POST returns the posted comment", async () => {
    // Post a comment
    const postRes = await req("POST", `/api/v1/graphs/${repoGraphId}/code/comments`, {
      path: "src/lib.rs",
      span: "L2",
      body: "Review this line carefully.",
      by: "owner",
    });
    expect(postRes.status).toBe(200);
    const posted = postRes.body as { commentId: string };

    // List comments
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/code/comments?path=src/lib.rs`
    );
    expect(status).toBe(200);
    const b = body as {
      comments: Array<{
        commentId: string;
        body: string;
        span: string;
        status: string;
        author: string;
        anchorSha: string;
        currentHead: boolean;
      }>;
    };
    const found = b.comments.find((c) => c.commentId === posted.commentId);
    expect(found).toBeDefined();
    expect(found?.body).toBe("Review this line carefully.");
    expect(found?.span).toBe("L2");
    expect(found?.status).toBe("open");
    expect(found?.author).toBe("owner");
    expect(typeof found?.anchorSha).toBe("string");
    expect(found?.currentHead).toBe(true);
  });
});
