/**
 * Tests for GraphManager — registry of allod graphs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
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
    const entry = await manager.registerRepo(repoDir, { name: "My Repo" });

    const fetched = await manager.getEntry(entry.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.kind).toBe("repo");
    expect(fetched!.path).toBe(repoDir);
    expect(fetched!.name).toBe("My Repo");
  });

  test("registerRepo() installs the review ontology in the graph", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);

    const manager = await GraphManager.open(home);
    const entry = await manager.registerRepo(repoDir, { name: "My Repo" });
    const fh = await manager.get(entry.id);

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
    const entry = await manager.registerRepo(repoDir, { name: "My Repo" });
    const fh = await manager.get(entry.id);

    expect(fh.kind).toBe("repo");
    expect(fh.graphId).toBe(entry.id);
    expect(fh.graphDir).toBe(repoDir);
  });

  test("registerRepo() returns GraphEntry not string", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);

    const manager = await GraphManager.open(home);
    const result = await manager.registerRepo(repoDir, { name: "My Repo", id: "my-repo" });
    expect(typeof result).toBe("object");
    expect(result.id).toBe("my-repo");
    expect(result.kind).toBe("repo");
    expect(result.path).toBe(repoDir);
  });

  test("entry() returns the graph entry for known id", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);
    const e = await manager.entry("main");
    expect(e.id).toBe("main");
  });

  test("entry() throws for unknown id", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);
    await expect(manager.entry("nonexistent")).rejects.toThrow();
  });

  test("defaultId() returns 'main'", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);
    expect(manager.defaultId()).toBe("main");
  });

  test("updateSettings() updates name and autoPushNotes", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);
    const updated = await manager.updateSettings("main", { name: "Renamed", autoPushNotes: true });
    expect(updated.name).toBe("Renamed");
    expect(updated.autoPushNotes).toBe(true);
    // Persisted
    const e = await manager.entry("main");
    expect(e.name).toBe("Renamed");
  });

  test("remove() deletes a registered repo and evicts cache", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);
    const manager = await GraphManager.open(home);
    const entry = await manager.registerRepo(repoDir, { name: "Repo", id: "removable" });
    expect(entry.id).toBe("removable");
    await manager.remove("removable");
    await expect(manager.entry("removable")).rejects.toThrow();
    // Files on disk are NOT deleted
    expect(existsSync(repoDir)).toBe(true);
  });

  test("remove() throws for the default graph", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);
    await expect(manager.remove("main")).rejects.toThrow();
  });

  test("registerRepo() throws for duplicate id", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);
    const manager = await GraphManager.open(home);
    await manager.registerRepo(repoDir, { id: "dup-id" });
    const repoDir2 = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir2);
    await expect(manager.registerRepo(repoDir2, { id: "dup-id" })).rejects.toThrow();
  });

  test("registerRepo() throws for same path twice (deterministic id collision)", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);
    const manager = await GraphManager.open(home);
    await manager.registerRepo(repoDir, { name: "First" });
    await expect(manager.registerRepo(repoDir, { name: "Second" })).rejects.toThrow();
  });

  test("registerRepo() throws when .allod/graph.yaml is missing", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const notAnAllodRepo = makeTempDir("freehold-mgr-plain-");
    const manager = await GraphManager.open(home);
    await expect(manager.registerRepo(notAnAllodRepo)).rejects.toThrow(
      `not an allod graph: no .allod/graph.yaml at ${notAnAllodRepo}`
    );
  });

  test("registerRepo() indexes the graph — rows visible under its id", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);
    const manager = await GraphManager.open(home);
    const entry = await manager.registerRepo(repoDir, { name: "Indexed Repo", id: "indexed-repo" });

    // Some rows should have been indexed (at minimum the owner node)
    const { rows } = await manager.db.pg.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM objects WHERE graph_id = $1",
      [entry.id]
    );
    const count = parseInt(rows[0].count, 10);
    expect(count).toBeGreaterThan(0);

    // Rows for indexed-repo should not appear in main's rows
    const mainRows = await manager.db.pg.query<{ id: string }>(
      "SELECT id FROM objects WHERE graph_id = 'main'",
      []
    );
    const repoRows = await manager.db.pg.query<{ id: string }>(
      "SELECT id FROM objects WHERE graph_id = $1",
      [entry.id]
    );
    for (const row of repoRows.rows) {
      expect(mainRows.rows.map((r) => r.id)).not.toContain(row.id);
    }
  });

  test("review ontology edge types part_of and replies_to are installed", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);
    const manager = await GraphManager.open(home);
    const entry = await manager.registerRepo(repoDir, { name: "Review Edge Test", id: "review-edge-test" });
    const fh = await manager.get(entry.id);

    const { describeSchema } = await import("../src/schema.js");
    const schema = await describeSchema(fh.graph);
    const edgeNames = schema.edgeTypes.map((et: { name: string }) => et.name);
    expect(edgeNames.some((n: string) => n.includes("part_of") || n.includes("part-of"))).toBe(true);
    expect(edgeNames.some((n: string) => n.includes("replies_to") || n.includes("replies-to"))).toBe(true);
  });
});
