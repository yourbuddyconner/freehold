/**
 * Tests for check_status integration in gitreview.ts.
 *
 * Verifies that listGitProposals/gitProposal populate the `checks` field from
 * the check_status DB table, and return an empty array when no rows exist.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import { openDb } from "../src/db.js";
import { gitProposal, listGitProposals } from "../src/gitreview.js";
import { type Freehold, openFreehold } from "../src/graphs.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

let fh: Freehold;
let repoDir: string;
let pgDir: string;
let mainSha: string;
let featureSha: string;

beforeAll(async () => {
  repoDir = makeTempDir("gitreview-checks-test-repo-");
  pgDir = makeTempDir("gitreview-checks-test-pg-");

  // Build git repo
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

  // main: initial commit
  writeFileSync(join(repoDir, "README.md"), "# checks test");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  mainSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

  // feature branch: a second commit
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "lib.rs"), "// library");
  execFileSync("git", ["add", "src/lib.rs"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "add src/lib.rs"], { cwd: repoDir });
  featureSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  execFileSync("git", ["checkout", "main"], { cwd: repoDir });

  // Build allod graph
  await createGraph(repoDir, "owner");

  const db = await openDb(pgDir);
  fh = await openFreehold({
    graphDir: repoDir,
    db,
    home: repoDir,
    graphName: "test",
    graphId: "gitreview-checks-test",
    kind: "repo",
  });
}, 60_000);

afterAll(() => {
  // nothing to clean up — temp dirs are left for OS to reclaim
});

describe("checks field — no check_status table", () => {
  test("checks is empty array when check_status table does not exist", async () => {
    const proposals = await listGitProposals(fh);
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(Array.isArray(p.checks)).toBe(true);
      expect(p.checks).toHaveLength(0);
    }
  });

  test("gitProposal checks is empty array when table does not exist", async () => {
    const p = await gitProposal(fh, mainSha);
    expect(p).not.toBeNull();
    expect(Array.isArray(p?.checks)).toBe(true);
    expect(p?.checks).toHaveLength(0);
  });
});

describe("checks field — with check_status rows", () => {
  beforeAll(async () => {
    // Create check_status table and insert rows for featureSha
    await fh.db.pg.exec(`
      CREATE TABLE IF NOT EXISTS check_status (
        graph_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        conclusion TEXT
      )
    `);

    await fh.db.pg.exec(`
      INSERT INTO check_status (graph_id, sha, name, status, conclusion)
      VALUES
        ('gitreview-checks-test', '${featureSha}', 'build', 'completed', 'success'),
        ('gitreview-checks-test', '${featureSha}', 'lint', 'completed', 'failure'),
        ('gitreview-checks-test', '${featureSha}', 'test', 'in_progress', NULL)
    `);
  });

  test("listGitProposals returns checks for feature sha", async () => {
    const proposals = await listGitProposals(fh);
    const feature = proposals.find((p) => p.sha === featureSha);
    expect(feature, "feature proposal not found").toBeDefined();

    const checks = feature?.checks;
    expect(Array.isArray(checks)).toBe(true);
    expect(checks).toHaveLength(3);

    const build = checks.find((c) => c.name === "build");
    expect(build).toBeDefined();
    expect(build?.status).toBe("completed");
    expect(build?.conclusion).toBe("success");

    const lint = checks.find((c) => c.name === "lint");
    expect(lint).toBeDefined();
    expect(lint?.status).toBe("completed");
    expect(lint?.conclusion).toBe("failure");

    const testCheck = checks.find((c) => c.name === "test");
    expect(testCheck).toBeDefined();
    expect(testCheck?.status).toBe("in_progress");
    expect(testCheck?.conclusion).toBeUndefined();
  });

  test("listGitProposals returns empty checks for main sha (no matching rows)", async () => {
    const proposals = await listGitProposals(fh);
    const main = proposals.find((p) => p.sha === mainSha);
    expect(main, "main proposal not found").toBeDefined();
    expect(main?.checks).toHaveLength(0);
  });

  test("gitProposal returns checks for feature sha", async () => {
    const p = await gitProposal(fh, featureSha);
    expect(p).not.toBeNull();
    expect(p?.checks).toHaveLength(3);

    const build = p?.checks.find((c) => c.name === "build");
    expect(build?.conclusion).toBe("success");
  });

  test("conclusion is absent (not null) when DB value is NULL", async () => {
    const p = await gitProposal(fh, featureSha);
    expect(p).not.toBeNull();
    const testCheck = p?.checks.find((c) => c.name === "test");
    expect(testCheck).toBeDefined();
    // conclusion key should not be present on the object
    expect(Object.prototype.hasOwnProperty.call(testCheck, "conclusion")).toBe(false);
  });
});
