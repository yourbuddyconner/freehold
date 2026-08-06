/**
 * Tests for gitapply — apply a review suggestion as a pure git plumbing commit.
 *
 * Each test creates a fixture repo with `git init -b main` and tears it down
 * in afterEach. Tests cover:
 *   - single-line replacement
 *   - multi-line range replacement
 *   - nested path (file in a subdirectory)
 *   - trailing-newline preservation
 *   - binary file → 422 BinaryFileError
 *   - old-side span → 422 OldSideSpanError
 *   - branch-moved 409 (stale expectedTip)
 *   - branch-moved 409 via preUpdateHook (concurrent push race)
 *   - out-of-range span → 422 InvalidSpanError
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BinaryFileError,
  BranchMovedError,
  InvalidSpanError,
  OldSideSpanError,
  applySuggestion,
} from "../src/gitapply.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "freehold-gitapply-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  return dir;
}

function commit(repoDir: string, message: string): string {
  execFileSync("git", ["commit", "-m", message, "--allow-empty"], { cwd: repoDir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
}

function addFile(repoDir: string, path: string, content: string): void {
  const fullPath = join(repoDir, path);
  // Ensure parent directory exists
  const parentDir = join(repoDir, path.split("/").slice(0, -1).join("/"));
  if (parentDir !== repoDir) {
    mkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(fullPath, content);
  execFileSync("git", ["add", path], { cwd: repoDir });
}

function tipSha(repoDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
}

function blobContent(repoDir: string, sha: string, path: string): string {
  return execFileSync("git", ["show", `${sha}:${path}`], { cwd: repoDir }).toString();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("applySuggestion", () => {
  let repoDir: string;
  const tempDirs: string[] = [];

  beforeEach(() => {
    repoDir = initRepo();
    tempDirs.push(repoDir);
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // ── single-line replacement ───────────────────────────────────────────────

  test("single-line replacement produces correct blob", async () => {
    addFile(repoDir, "file.txt", "line one\nline two\nline three\n");
    const sha = commit(repoDir, "init");

    const { newSha } = await applySuggestion(repoDir, {
      branch: "main",
      path: "file.txt",
      span: "L2",
      suggestion: "replaced line",
      by: "alice",
      expectedTip: sha,
    });

    expect(newSha).toMatch(/^[0-9a-f]{40}$/);
    // Branch tip should now be newSha
    expect(tipSha(repoDir)).toBe(newSha);
    // Blob content at newSha
    const content = blobContent(repoDir, newSha, "file.txt");
    expect(content).toBe("line one\nreplaced line\nline three\n");
  });

  // ── multi-line range replacement ──────────────────────────────────────────

  test("multi-line range replacement splices correctly", async () => {
    addFile(repoDir, "file.txt", "a\nb\nc\nd\ne\n");
    const sha = commit(repoDir, "init");

    const { newSha } = await applySuggestion(repoDir, {
      branch: "main",
      path: "file.txt",
      span: "L2-L4",
      suggestion: "X\nY\n",
      by: "bob",
      expectedTip: sha,
    });

    const content = blobContent(repoDir, newSha, "file.txt");
    expect(content).toBe("a\nX\nY\ne\n");
  });

  // ── nested path ───────────────────────────────────────────────────────────

  test("nested path (subdirectory) applies correctly", async () => {
    addFile(repoDir, "src/lib.rs", "fn old() {}\n");
    const sha = commit(repoDir, "init");

    const { newSha } = await applySuggestion(repoDir, {
      branch: "main",
      path: "src/lib.rs",
      span: "L1",
      suggestion: "fn new() {}\n",
      by: "alice",
      expectedTip: sha,
    });

    const content = blobContent(repoDir, newSha, "src/lib.rs");
    expect(content).toBe("fn new() {}\n");
  });

  // ── trailing-newline preservation ─────────────────────────────────────────

  test("file without trailing newline keeps no trailing newline", async () => {
    // No trailing \n
    addFile(repoDir, "file.txt", "hello\nworld");
    const sha = commit(repoDir, "init");

    const { newSha } = await applySuggestion(repoDir, {
      branch: "main",
      path: "file.txt",
      span: "L1",
      suggestion: "goodbye",
      by: "alice",
      expectedTip: sha,
    });

    const content = blobContent(repoDir, newSha, "file.txt");
    expect(content).toBe("goodbye\nworld");
    // No trailing newline
    expect(content.endsWith("\n")).toBe(false);
  });

  test("file with trailing newline keeps trailing newline", async () => {
    addFile(repoDir, "file.txt", "alpha\nbeta\n");
    const sha = commit(repoDir, "init");

    const { newSha } = await applySuggestion(repoDir, {
      branch: "main",
      path: "file.txt",
      span: "L1",
      suggestion: "ALPHA",
      by: "alice",
      expectedTip: sha,
    });

    const content = blobContent(repoDir, newSha, "file.txt");
    expect(content).toBe("ALPHA\nbeta\n");
    expect(content.endsWith("\n")).toBe(true);
  });

  // ── commit metadata ───────────────────────────────────────────────────────

  test("new commit has correct parent and message", async () => {
    addFile(repoDir, "file.txt", "original\n");
    const sha = commit(repoDir, "init");

    const { newSha } = await applySuggestion(repoDir, {
      branch: "main",
      path: "file.txt",
      span: "L1",
      suggestion: "changed\n",
      by: "alice",
      expectedTip: sha,
    });

    const log = execFileSync("git", ["show", "-s", "--format=%P%n%s", newSha], {
      cwd: repoDir,
    }).toString();
    const lines = log.trim().split("\n");
    expect(lines[0]).toBe(sha); // parent
    expect(lines[1]).toContain("Apply suggestion to file.txt");
    expect(lines[1]).toContain("L1");
  });

  // ── binary file → 422 ────────────────────────────────────────────────────

  test("binary file throws BinaryFileError", async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const fullPath = join(repoDir, "image.bin");
    writeFileSync(fullPath, buf);
    execFileSync("git", ["add", "image.bin"], { cwd: repoDir });
    const sha = commit(repoDir, "add binary");

    await expect(
      applySuggestion(repoDir, {
        branch: "main",
        path: "image.bin",
        span: "L1",
        suggestion: "text",
        by: "alice",
        expectedTip: sha,
      })
    ).rejects.toBeInstanceOf(BinaryFileError);
  });

  // ── old-side span → 422 ───────────────────────────────────────────────────

  test("old-side span throws OldSideSpanError", async () => {
    addFile(repoDir, "file.txt", "hello\n");
    const sha = commit(repoDir, "init");

    await expect(
      applySuggestion(repoDir, {
        branch: "main",
        path: "file.txt",
        span: "old:L1",
        suggestion: "world",
        by: "alice",
        expectedTip: sha,
      })
    ).rejects.toBeInstanceOf(OldSideSpanError);
  });

  // ── out-of-range span → 422 ───────────────────────────────────────────────

  test("out-of-range span throws InvalidSpanError", async () => {
    addFile(repoDir, "file.txt", "one line\n");
    const sha = commit(repoDir, "init");

    await expect(
      applySuggestion(repoDir, {
        branch: "main",
        path: "file.txt",
        span: "L5",
        suggestion: "oops",
        by: "alice",
        expectedTip: sha,
      })
    ).rejects.toBeInstanceOf(InvalidSpanError);
  });

  test("malformed span throws InvalidSpanError", async () => {
    addFile(repoDir, "file.txt", "one line\n");
    const sha = commit(repoDir, "init");

    await expect(
      applySuggestion(repoDir, {
        branch: "main",
        path: "file.txt",
        span: "bad",
        suggestion: "oops",
        by: "alice",
        expectedTip: sha,
      })
    ).rejects.toBeInstanceOf(InvalidSpanError);
  });

  // ── stale expectedTip → 409 ───────────────────────────────────────────────

  test("stale expectedTip throws BranchMovedError", async () => {
    addFile(repoDir, "file.txt", "original\n");
    const staleSha = commit(repoDir, "first");

    // Advance branch
    addFile(repoDir, "file.txt", "modified\n");
    const _newCommit = commit(repoDir, "second");

    await expect(
      applySuggestion(repoDir, {
        branch: "main",
        path: "file.txt",
        span: "L1",
        suggestion: "replaced",
        by: "alice",
        expectedTip: staleSha, // stale — branch is now at second commit
      })
    ).rejects.toBeInstanceOf(BranchMovedError);
  });

  // ── concurrent push race via preUpdateHook → 409 ─────────────────────────

  test("preUpdateHook race throws BranchMovedError", async () => {
    addFile(repoDir, "file.txt", "original\n");
    const sha = commit(repoDir, "init");

    // Simulate a concurrent push: advance the branch inside preUpdateHook
    // before update-ref runs
    let racedSha: string | null = null;

    const preUpdateHook = async () => {
      // Create a new commit directly, bypassing the apply path
      addFile(repoDir, "file.txt", "concurrent change\n");
      racedSha = commit(repoDir, "concurrent commit");
    };

    await expect(
      applySuggestion(repoDir, {
        branch: "main",
        path: "file.txt",
        span: "L1",
        suggestion: "apply suggestion",
        by: "alice",
        expectedTip: sha,
        preUpdateHook,
      })
    ).rejects.toBeInstanceOf(BranchMovedError);

    // Branch should be at the raced commit, not the apply commit
    expect(racedSha).toBeTruthy();
    expect(tipSha(repoDir)).toBe(racedSha);
  });
});
