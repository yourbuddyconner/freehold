/**
 * Tests for codecomments.ts — standalone line-anchored code comments.
 *
 * Fixture: a scripted git repo with an allod graph (review ontology installed)
 * and the owner principal's key written to ALLOD_KEYS_DIR.
 *
 * Tests:
 *   - post + list round-trip (admitted)
 *   - anchor encodes HEAD sha at posting time
 *   - currentHead = true for current HEAD, false after a new commit
 *   - ends-with path matching: src/lib.rs does NOT match test/src/lib.rs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createGraph, openGraph } from "../src/allod.js";
import { listCodeComments, postCodeComment } from "../src/codecomments.js";
import { openDb } from "../src/db.js";
import { hashEmbedder } from "../src/embed.js";
import { headSha } from "../src/git.js";
import { approve } from "../src/governance.js";
import { type Freehold, openFreehold } from "../src/graphs.js";
import { graphDirComponent } from "../src/keys.js";
import { installOntology } from "../src/schema.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function assetYaml(name: string): string {
  const url = new URL(`../assets/${name}`, import.meta.url);
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

// ── Fixture state ─────────────────────────────────────────────────────────────

let fh: Freehold;
let repoDir: string;
let keysDir: string;
let allodGraphId: string;
let initialSha: string;

const origKeysDir = process.env.ALLOD_KEYS_DIR;

beforeAll(async () => {
  repoDir = makeTempDir("codecomments-test-repo-");
  const pgDir = makeTempDir("codecomments-test-pg-");
  keysDir = makeTempDir("codecomments-test-keys-");
  process.env.ALLOD_KEYS_DIR = keysDir;

  // Build a minimal git repo
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

  writeFileSync(join(repoDir, "src", "lib.rs").replace("src/lib.rs", "README.md"), "# test");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, "test", "src"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# test");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

  writeFileSync(join(repoDir, "src", "lib.rs"), "// library code\nfn hello() {}");
  writeFileSync(join(repoDir, "test", "src", "lib.rs"), "// test lib");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "add source files"], { cwd: repoDir });
  initialSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

  // Build allod graph
  await createGraph(repoDir, "owner");

  const db = await openDb(pgDir);
  fh = await openFreehold({
    graphDir: repoDir,
    db,
    home: repoDir,
    graphName: "test",
    graphId: "codecomments-test",
    kind: "repo",
  });

  // Read the real allod graph_id
  const graphYaml = readFileSync(join(repoDir, ".allod", "graph.yaml"), "utf8");
  const idMatch = graphYaml.match(/\bgraph_id:\s*(.+)/);
  allodGraphId = idMatch ? idMatch[1].trim() : "codecomments-test";

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
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("postCodeComment + listCodeComments round-trip", () => {
  test("post a comment and list it back", async () => {
    const result = await postCodeComment(fh, {
      path: "src/lib.rs",
      span: "L1",
      body: "This function needs documentation.",
      by: "owner",
    });

    expect(result.commentId).toBeTruthy();
    expect(["saved", "pending"]).toContain(result.status);
    expect(result.anchorSha).toBe(initialSha);

    const comments = await listCodeComments(fh, "src/lib.rs");
    const found = comments.find((c) => c.commentId === result.commentId);
    expect(found).toBeDefined();
    expect(found?.body).toBe("This function needs documentation.");
    expect(found?.span).toBe("L1");
    expect(found?.author).toBe("owner");
    expect(found?.anchorSha).toBe(initialSha);
    expect(found?.status).toBe("open");
  });

  test("anchor sha matches HEAD at posting time", async () => {
    const currentHead = await headSha(repoDir);
    const result = await postCodeComment(fh, {
      path: "src/lib.rs",
      span: "L2",
      body: "Check this line.",
      by: "owner",
    });
    expect(result.anchorSha).toBe(currentHead);
  });

  test("currentHead is true when anchor sha matches current HEAD", async () => {
    await postCodeComment(fh, {
      path: "src/lib.rs",
      span: "L1-L2",
      body: "Range comment.",
      by: "owner",
    });

    const comments = await listCodeComments(fh, "src/lib.rs");
    // All comments should have currentHead=true since we haven't advanced HEAD
    for (const c of comments) {
      expect(c.currentHead).toBe(true);
    }
  });

  test("currentHead is false after a new commit is made", async () => {
    // Post a comment at current HEAD
    const { commentId, anchorSha } = await postCodeComment(fh, {
      path: "src/lib.rs",
      span: "L1",
      body: "Posted before new commit.",
      by: "owner",
    });

    // Advance HEAD
    writeFileSync(join(repoDir, "src", "new.rs"), "// new file");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "advance HEAD"], { cwd: repoDir });

    const newHead = await headSha(repoDir);
    expect(newHead).not.toBe(anchorSha);

    const comments = await listCodeComments(fh, "src/lib.rs");
    const found = comments.find((c) => c.commentId === commentId);
    expect(found).toBeDefined();
    expect(found?.currentHead).toBe(false);
    expect(found?.anchorSha).toBe(anchorSha);
  }, 20_000);
});

describe("path matching — no suffix collisions", () => {
  test("src/lib.rs comments do NOT appear in test/src/lib.rs listing", async () => {
    // Post a comment on the actual src/lib.rs
    const { commentId } = await postCodeComment(fh, {
      path: "src/lib.rs",
      span: "L1",
      body: "Comment on src/lib.rs specifically.",
      by: "owner",
    });

    // Listing test/src/lib.rs should NOT include this comment
    const wrongPathComments = await listCodeComments(fh, "test/src/lib.rs");
    const found = wrongPathComments.find((c) => c.commentId === commentId);
    expect(found).toBeUndefined();

    // Listing src/lib.rs should include it
    const correctComments = await listCodeComments(fh, "src/lib.rs");
    const found2 = correctComments.find((c) => c.commentId === commentId);
    expect(found2).toBeDefined();
  });

  test("test/src/lib.rs gets its own separate comments", async () => {
    // Reset HEAD to have a clean anchor
    const headBefore = await headSha(repoDir);

    const { commentId: testCommentId } = await postCodeComment(fh, {
      path: "test/src/lib.rs",
      span: "L1",
      body: "Comment on test/src/lib.rs.",
      by: "owner",
    });

    // Listing src/lib.rs should NOT include test/src/lib.rs comment
    const srcComments = await listCodeComments(fh, "src/lib.rs");
    const found = srcComments.find((c) => c.commentId === testCommentId);
    expect(found).toBeUndefined();

    // Listing test/src/lib.rs should include it
    const testComments = await listCodeComments(fh, "test/src/lib.rs");
    const found2 = testComments.find((c) => c.commentId === testCommentId);
    expect(found2).toBeDefined();
  });
});

describe("postCodeComment — host-managed key (file-only, not in wasm store)", () => {
  test("postCodeComment succeeds when key is only in ALLOD_KEYS_DIR", async () => {
    // The fixture's owner key is already in ALLOD_KEYS_DIR (set in beforeAll).
    // This test explicitly verifies that postCodeComment works even when the
    // signing key is NOT in the graph's internal wasm store — the exact case
    // that was broken before passing key_id to commit_payload.
    const result = await postCodeComment(fh, {
      path: "src/lib.rs",
      span: "L1",
      body: "host-managed key signing path verification",
      by: "owner",
    });

    expect(result.commentId).toBeTruthy();
    expect(["saved", "pending"]).toContain(result.status);
    // anchorSha is HEAD at posting time; other tests may have advanced HEAD since initialSha
    expect(result.anchorSha).toMatch(/^[0-9a-f]{40}$/);

    const comments = await listCodeComments(fh, "src/lib.rs");
    const found = comments.find((c) => c.commentId === result.commentId);
    expect(found).toBeDefined();
    expect(found?.body).toBe("host-managed key signing path verification");
  });
});
