/**
 * Tests for git shell-out helpers in git.ts
 * Builds a scratch git repo in a temp dir, makes commits, and tests all functions.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appendDecision,
  commitMeta,
  diffTreeOps,
  headSha,
  originRemote,
  readDecisions,
} from "../src/git.js";

describe("git helpers", () => {
  let repoDir: string;
  let sha1: string;
  let sha2: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "freehold-git-test-"));

    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

    // First commit (root commit)
    writeFileSync(join(repoDir, "file.txt"), "hello");
    execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });
    sha1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

    // Second commit (has one parent)
    writeFileSync(join(repoDir, "second.txt"), "world");
    execFileSync("git", ["add", "second.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: repoDir });
    sha2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  });

  test("headSha resolves to a 40-char hex string", async () => {
    const sha = await headSha(repoDir);
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(sha).toBe(sha2);
  });

  test("headSha resolves a named ref", async () => {
    const sha = await headSha(repoDir, sha1);
    expect(sha).toBe(sha1);
  });

  test("commitMeta returns correct fields for root commit", async () => {
    const meta = await commitMeta(repoDir, sha1);
    expect(meta.sha).toBe(sha1);
    expect(meta.author).toBe("Test User");
    expect(meta.email).toBe("test@example.com");
    expect(meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.message).toBe("initial commit");
    expect(meta.parents).toEqual([]);
  });

  test("commitMeta returns correct fields for second commit with parent", async () => {
    const meta = await commitMeta(repoDir, sha2);
    expect(meta.sha).toBe(sha2);
    expect(meta.message).toBe("second commit");
    expect(meta.parents).toEqual([sha1]);
  });

  test("diffTreeOps on root commit uses --root flag and returns correct ops", async () => {
    const ops = await diffTreeOps(repoDir, sha1);
    expect(Array.isArray(ops)).toBe(true);
    expect(ops.length).toBeGreaterThan(0);
    // Root commit added file.txt
    const fileTxt = ops.find(([, path]) => path === "file.txt");
    expect(fileTxt).toBeDefined();
    expect(fileTxt?.[0]).toBe("A");
  });

  test("diffTreeOps on second commit returns correct ops", async () => {
    const ops = await diffTreeOps(repoDir, sha2);
    expect(Array.isArray(ops)).toBe(true);
    // Second commit added second.txt
    const secondTxt = ops.find(([, path]) => path === "second.txt");
    expect(secondTxt).toBeDefined();
    expect(secondTxt?.[0]).toBe("A");
    // file.txt should not appear (unchanged)
    const fileTxt = ops.find(([, path]) => path === "file.txt");
    expect(fileTxt).toBeUndefined();
  });

  test("readDecisions on a sha with no note returns []", async () => {
    const decisions = await readDecisions(repoDir, sha1);
    expect(decisions).toEqual([]);
  });

  test("appendDecision then readDecisions round-trips a record", async () => {
    const record = { kind: "approve", author: "alice", timestamp: "2026-08-05T00:00:00Z" };
    await appendDecision(repoDir, sha1, record);
    const decisions = await readDecisions(repoDir, sha1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject(record);
  });

  test("appendDecision accumulates multiple records", async () => {
    const r1 = { kind: "approve", author: "alice" };
    const r2 = { kind: "request-changes", author: "bob" };
    await appendDecision(repoDir, sha1, r1);
    await appendDecision(repoDir, sha1, r2);
    const decisions = await readDecisions(repoDir, sha1);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject(r1);
    expect(decisions[1]).toMatchObject(r2);
  });

  test("originRemote returns null when no remote configured", async () => {
    const remote = await originRemote(repoDir);
    expect(remote).toBeNull();
  });

  test("headSha rejects dash-leading ref", async () => {
    await expect(headSha(repoDir, "--not-a-ref")).rejects.toThrow();
  });

  test("readDecisions rejects dash-leading sha", async () => {
    await expect(readDecisions(repoDir, "--bad")).rejects.toThrow(/unsafe sha/);
  });

  test("appendDecision rejects dash-leading sha", async () => {
    await expect(appendDecision(repoDir, "--bad", {})).rejects.toThrow(/unsafe sha/);
  });

  test("concurrent appendDecision calls on the same sha both survive", async () => {
    // Two concurrent appends — neither should overwrite the other
    await Promise.all([
      appendDecision(repoDir, sha1, { verdict: "approve", by: "alice" }),
      appendDecision(repoDir, sha1, { verdict: "reject", by: "bob" }),
    ]);
    const decisions = await readDecisions(repoDir, sha1);
    expect(decisions).toHaveLength(2);
    // Both records must be present (order may vary)
    const bys = (decisions as Array<{ by: string }>).map((d) => d.by).sort();
    expect(bys).toEqual(["alice", "bob"]);
  });

  test("diffTreeOps on merge commit uses first-parent two-tree diff", async () => {
    // Get the current branch name (may be "main" or "master" depending on git config)
    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
    })
      .toString()
      .trim();

    const branchFile = join(repoDir, "branch-only.txt");
    const mainFile = join(repoDir, "main-after.txt");

    // Create a branch from sha1 (first commit)
    execFileSync("git", ["checkout", sha1, "-b", "feature-branch"], { cwd: repoDir });
    writeFileSync(branchFile, "branch content");
    execFileSync("git", ["add", "branch-only.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "branch commit"], { cwd: repoDir });

    // Go back to the original branch, add a file, then merge with --no-ff
    execFileSync("git", ["checkout", currentBranch], { cwd: repoDir });
    writeFileSync(mainFile, "main content");
    execFileSync("git", ["add", "main-after.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "main commit after branch"], { cwd: repoDir });
    const mainBeforeMergeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
      .toString()
      .trim();

    execFileSync("git", ["merge", "--no-ff", "feature-branch", "-m", "merge branch"], {
      cwd: repoDir,
    });
    const mergeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

    // diffTreeOps must use first-parent diff: mainBeforeMergeSha → mergeSha
    const ops = await diffTreeOps(repoDir, mergeSha);

    // The expected ops equal git diff-tree --no-renames --name-status -r <p1> <sha>
    const directOut = execFileSync(
      "git",
      ["diff-tree", "--no-renames", "--name-status", "-r", mainBeforeMergeSha, mergeSha],
      { cwd: repoDir }
    ).toString();
    const expectedOps: Array<[string, string]> = directOut
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        const parts = l.trim().split(/\t/);
        return [parts[0], parts[1]] as [string, string];
      });

    expect(ops).toEqual(expectedOps);

    // branch-only.txt was brought in by the merge (it was in feature-branch).
    // Compared to first parent (p1 = mainBeforeMergeSha), the merge commit added it.
    // So it DOES appear in the first-parent diff as "A".
    const branchOnlyOp = ops.find(([, p]) => p === "branch-only.txt");
    expect(branchOnlyOp).toBeDefined();
    expect(branchOnlyOp?.[0]).toBe("A");
  });
});
