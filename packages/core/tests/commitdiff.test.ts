/**
 * Tests for commitDiff — per-file full old/new content from a git commit.
 *
 * Fixture repo has:
 *   commit 1 (root): adds file.txt "hello\n"
 *   commit 2:        modifies file.txt → "hello world\n", adds second.txt "two\n"
 *   commit 3:        deletes second.txt
 *   commit 4 (merge): first-parent is commit 3 — should only show first-parent diff
 */

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commitDiff } from "../src/git.js";

describe("commitDiff (content form)", () => {
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

  test("returns old and new content for a modified file", async () => {
    // sha2: file.txt changed from "hello\n" → "hello world\n"
    const { files, truncated } = await commitDiff(repoDir, sha2);
    expect(truncated).toBe(false);
    const mod = files.find((f) => f.path === "file.txt");
    expect(mod).toBeDefined();
    expect(mod).toMatchObject({
      path: "file.txt",
      verb: "M",
      binary: false,
      oldContent: "hello\n",
      newContent: "hello world\n",
      truncated: false,
    });
  });

  test("add has empty oldContent; delete has empty newContent", async () => {
    // sha2 also adds second.txt
    const { files: files2 } = await commitDiff(repoDir, sha2);
    const add = files2.find((f) => f.path === "second.txt");
    expect(add).toBeDefined();
    expect(add).toMatchObject({
      verb: "A",
      binary: false,
      oldContent: "",
      newContent: "two\n",
      truncated: false,
    });

    // sha3 deletes second.txt
    const { files: files3 } = await commitDiff(repoDir, sha3);
    const del = files3.find((f) => f.path === "second.txt");
    expect(del).toBeDefined();
    expect(del).toMatchObject({
      verb: "D",
      binary: false,
      oldContent: "two\n",
      newContent: "",
      truncated: false,
    });
  });

  test("root commit diffs against the empty tree (all adds)", async () => {
    const { files } = await commitDiff(repoDir, sha1);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.verb === "A" && f.oldContent === "")).toBe(true);
  });

  test("merge commit diffs against first parent only", async () => {
    const { files } = await commitDiff(repoDir, mergeSha);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("side.txt");
    const fileTxt = files.find((f) => f.path === "file.txt");
    expect(fileTxt).toBeUndefined();
  });

  test("rename carries oldPath and both contents", async () => {
    // Create a rename commit
    const renameRepo = mkdtempSync(join(tmpdir(), "freehold-rename-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: renameRepo });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: renameRepo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: renameRepo });

    writeFileSync(join(renameRepo, "a.txt"), "alpha\n");
    execFileSync("git", ["add", "a.txt"], { cwd: renameRepo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: renameRepo });

    execFileSync("git", ["mv", "a.txt", "b.txt"], { cwd: renameRepo });
    execFileSync("git", ["commit", "-m", "rename a to b"], { cwd: renameRepo });
    const renameSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: renameRepo })
      .toString()
      .trim();

    const { files } = await commitDiff(renameRepo, renameSha);
    const renamed = files.find((f) => f.path === "b.txt");
    expect(renamed).toBeDefined();
    expect(renamed).toMatchObject({
      path: "b.txt",
      oldPath: "a.txt",
      verb: "R",
      oldContent: "alpha\n",
      newContent: "alpha\n",
    });
  });

  test("binary file ships empty contents, binary true", async () => {
    // Write a file with a NUL byte to mark it as binary
    const binaryRepo = mkdtempSync(join(tmpdir(), "freehold-binary-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: binaryRepo });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: binaryRepo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: binaryRepo });

    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]); // PNG-ish with NUL
    writeFileSync(join(binaryRepo, "image.bin"), buf);
    execFileSync("git", ["add", "image.bin"], { cwd: binaryRepo });
    execFileSync("git", ["commit", "-m", "add binary"], { cwd: binaryRepo });
    const binSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: binaryRepo })
      .toString()
      .trim();

    const { files } = await commitDiff(binaryRepo, binSha);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      binary: true,
      oldContent: "",
      newContent: "",
      truncated: false,
    });
  });

  test("a side over 512 KB truncates the file", async () => {
    const bigRepo = mkdtempSync(join(tmpdir(), "freehold-big-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: bigRepo });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: bigRepo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: bigRepo });

    // Write a 600 KB text file (no NUL bytes)
    const bigContent = "x".repeat(600 * 1024);
    writeFileSync(join(bigRepo, "big.txt"), bigContent);
    execFileSync("git", ["add", "big.txt"], { cwd: bigRepo });
    execFileSync("git", ["commit", "-m", "add big file"], { cwd: bigRepo });
    const bigSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: bigRepo }).toString().trim();

    const { files, truncated } = await commitDiff(bigRepo, bigSha);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      truncated: true,
      oldContent: "",
      newContent: "",
    });
    expect(truncated).toBe(true);
  });

  test("invalid sha throws", async () => {
    await expect(commitDiff(repoDir, "-bad")).rejects.toThrow(/unsafe/);
  });

  test("unknown sha throws", async () => {
    await expect(commitDiff(repoDir, "deadbeef1234567")).rejects.toThrow();
  });
});
