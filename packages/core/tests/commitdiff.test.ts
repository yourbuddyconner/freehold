/**
 * Tests for commitDiff — per-file unified diff entries from a git commit.
 *
 * Fixture repo has:
 *   commit 1 (root): adds file.txt "hello"
 *   commit 2:        modifies file.txt → "hello world", adds second.txt
 *   commit 3:        deletes second.txt
 *   commit 4 (merge): first-parent is commit 3 — should only show first-parent diff
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commitDiff } from "../src/git.js";

describe("commitDiff", () => {
  let repoDir: string;
  let sha1: string;
  let sha2: string;
  let sha3: string;
  let mergeSha: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "freehold-commitdiff-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });

    // commit 1 (root): add file.txt
    writeFileSync(join(repoDir, "file.txt"), "hello\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "root"], { cwd: repoDir });
    sha1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

    // commit 2: modify file.txt, add second.txt
    writeFileSync(join(repoDir, "file.txt"), "hello world\n");
    writeFileSync(join(repoDir, "second.txt"), "two\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "modify and add"], { cwd: repoDir });
    sha2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

    // commit 3: delete second.txt
    execFileSync("git", ["rm", "second.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "delete second"], { cwd: repoDir });
    sha3 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

    // branch + merge: create side branch from sha1, merge back (first-parent = sha3)
    execFileSync("git", ["checkout", "-b", "side", sha1], { cwd: repoDir });
    writeFileSync(join(repoDir, "side.txt"), "side\n");
    execFileSync("git", ["add", "side.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "side commit"], { cwd: repoDir });
    const sideSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    execFileSync("git", ["merge", "--no-ff", sideSha, "-m", "merge side"], { cwd: repoDir });
    mergeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  });

  test("root commit: entries have verb A, non-empty patch, binary false", async () => {
    const entries = await commitDiff(repoDir, sha1);
    expect(entries.length).toBe(1);
    const e = entries[0];
    expect(e.path).toBe("file.txt");
    expect(e.verb).toBe("A");
    expect(e.binary).toBe(false);
    expect(e.patch).toMatch(/\+hello/);
  });

  test("normal commit: modified file has verb M, added file has verb A", async () => {
    const entries = await commitDiff(repoDir, sha2);
    const mod = entries.find((e) => e.path === "file.txt");
    const add = entries.find((e) => e.path === "second.txt");
    expect(mod).toBeDefined();
    expect(mod?.verb).toBe("M");
    expect(mod?.binary).toBe(false);
    expect(add).toBeDefined();
    expect(add?.verb).toBe("A");
  });

  test("deleted file has verb D", async () => {
    const entries = await commitDiff(repoDir, sha3);
    const del = entries.find((e) => e.path === "second.txt");
    expect(del).toBeDefined();
    expect(del?.verb).toBe("D");
  });

  test("merge commit uses first-parent diff only", async () => {
    const entries = await commitDiff(repoDir, mergeSha);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("side.txt");
    const fileTxt = entries.find((e) => e.path === "file.txt");
    expect(fileTxt).toBeUndefined();
  });

  test("invalid sha throws", async () => {
    await expect(commitDiff(repoDir, "-bad")).rejects.toThrow(/unsafe/);
  });

  test("unknown sha throws", async () => {
    await expect(commitDiff(repoDir, "deadbeef1234567")).rejects.toThrow();
  });
});
