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

    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

    // First commit (root commit)
    writeFileSync(join(repoDir, "file.txt"), "hello");
    execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });
    sha1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
      .toString()
      .trim();

    // Second commit (has one parent)
    writeFileSync(join(repoDir, "second.txt"), "world");
    execFileSync("git", ["add", "second.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: repoDir });
    sha2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
      .toString()
      .trim();
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
    expect(fileTxt![0]).toBe("A");
  });

  test("diffTreeOps on second commit returns correct ops", async () => {
    const ops = await diffTreeOps(repoDir, sha2);
    expect(Array.isArray(ops)).toBe(true);
    // Second commit added second.txt
    const secondTxt = ops.find(([, path]) => path === "second.txt");
    expect(secondTxt).toBeDefined();
    expect(secondTxt![0]).toBe("A");
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
});
