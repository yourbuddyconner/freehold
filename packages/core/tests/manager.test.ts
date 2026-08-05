/**
 * Tests for GraphManager — registry of allod graphs.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import { openDb } from "../src/db.js";
import { GraphManager } from "../src/manager.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Create a scratch git repo with an initialised allod graph. */
async function makeRepoGraph(repoDir: string): Promise<void> {
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  // Create initial file + commit so HEAD exists
  writeFileSync(join(repoDir, "README.md"), "# test repo");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  // Initialise the allod graph inside the repo
  await createGraph(repoDir, "owner");
}

describe("GraphManager", () => {
  test("open() seeds the default 'main' graph entry", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);
    const entry = await manager.getEntry("main");
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("main");
    expect(entry!.kind).toBe("memory");
    expect(entry!.name).toBe("Main");
  });

  test("open() is idempotent — second open doesn't duplicate main entry", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    await GraphManager.open(home);
    const manager2 = await GraphManager.open(home);
    const entries = await manager2.list();
    const mainEntries = entries.filter((e) => e.id === "main");
    expect(mainEntries).toHaveLength(1);
  });

  test("get('main') returns a Freehold with correct fields", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);
    const fh = await manager.get("main");
    expect(fh.graphId).toBe("main");
    expect(fh.kind).toBe("memory");
    expect(fh.graphName).toBe("main");
    expect(typeof fh.graph).toBe("object");
    expect(typeof fh.db).toBe("object");
  });

  test("get('main') returns cached instance on second call", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);
    const fh1 = await manager.get("main");
    const fh2 = await manager.get("main");
    expect(fh1).toBe(fh2);
  });

  test("get() throws for unknown id", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);
    await expect(manager.get("nonexistent")).rejects.toThrow();
  });

  test("registerRepo() registers a repo graph entry", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);

    const manager = await GraphManager.open(home);
    const id = await manager.registerRepo(repoDir, { name: "My Repo" });

    const entry = await manager.getEntry(id);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe("repo");
    expect(entry!.path).toBe(repoDir);
    expect(entry!.name).toBe("My Repo");
  });

  test("registerRepo() installs the review ontology in the graph", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);

    const manager = await GraphManager.open(home);
    const id = await manager.registerRepo(repoDir, { name: "My Repo" });
    const fh = await manager.get(id);

    const { describeSchema } = await import("../src/schema.js");
    const schema = await describeSchema(fh.graph);
    const hasReview = schema.entityTypes.some((et) => et.name.startsWith("review/"));
    expect(hasReview).toBe(true);
  });

  test("list() returns all registered graphs", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);

    const manager = await GraphManager.open(home);
    await manager.registerRepo(repoDir, { name: "Repo A" });

    const entries = await manager.list();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain("main");
    expect(ids.some((id) => id !== "main")).toBe(true);
  });

  test("get() on a repo graph returns Freehold with kind=repo", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);

    const manager = await GraphManager.open(home);
    const id = await manager.registerRepo(repoDir, { name: "My Repo" });
    const fh = await manager.get(id);

    expect(fh.kind).toBe("repo");
    expect(fh.graphId).toBe(id);
    expect(fh.graphDir).toBe(repoDir);
  });
});
