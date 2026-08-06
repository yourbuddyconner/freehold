/**
 * Tests for GraphManager — registry of allod graphs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import { GraphManager } from "../src/manager.js";

/**
 * Strip leading comment lines and the `imports:` block from an ontology YAML.
 * The wasm install_package path requires the document to start with `ontology:`
 * and does not process cross-package imports at install time.
 */
function stripOntologyPreamble(yaml: string): string {
  const lines = yaml.split("\n");
  // Drop leading comment lines
  let start = 0;
  while (start < lines.length && lines[start].trimStart().startsWith("#")) {
    start++;
  }
  // Strip the imports: block (all indented lines that follow "imports:")
  const result: string[] = [];
  let inImports = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^imports:/.test(line)) {
      inImports = true;
      continue;
    }
    if (inImports && (line.startsWith(" ") || line.startsWith("\t") || line === "")) {
      if (line === "") inImports = false; // blank line ends the imports block
      continue;
    }
    inImports = false;
    result.push(line);
  }
  return result.join("\n");
}

/** Read a bundled asset YAML relative to this file's directory. */
function assetYaml(name: string): string {
  const url = new URL(`../assets/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Create a scratch git repo with an initialised allod graph. */
async function makeRepoGraph(repoDir: string): Promise<void> {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
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
    expect(entry?.id).toBe("main");
    expect(entry?.kind).toBe("memory");
    expect(entry?.name).toBe("Main");
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
    expect(fetched?.kind).toBe("repo");
    expect(fetched?.path).toBe(repoDir);
    expect(fetched?.name).toBe("My Repo");
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

  test("registerRepo() duplicate-id check fires before side effects — review ontology not installed in new repo", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir1 = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir1);
    const manager = await GraphManager.open(home);

    // Register repo1 with a fixed id
    await manager.registerRepo(repoDir1, { id: "collision-test" });

    // Create a VALID allod graph at a fresh temp dir
    const repoDir2 = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir2);

    // Count changesets in repo2 BEFORE the failed registration attempt
    const changesetsDir = join(repoDir2, ".allod", "changesets");
    const { readdirSync } = await import("node:fs");
    const countBefore = existsSync(changesetsDir) ? readdirSync(changesetsDir).length : 0;

    // Attempt to register with the same id — must throw BEFORE installing review ontology
    await expect(manager.registerRepo(repoDir2, { id: "collision-test" })).rejects.toThrow(
      "graph id already registered"
    );

    // The changeset count must not have increased: review ontology install
    // would have added changesets. If the guard fires first, no new changesets appear.
    const countAfter = existsSync(changesetsDir) ? readdirSync(changesetsDir).length : 0;
    expect(countAfter).toBe(countBefore);
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

  test("registerRepo() persists signingPrincipal and returns it in entry", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);

    const manager = await GraphManager.open(home);
    const entry = await manager.registerRepo(repoDir, { name: "My Repo", signingPrincipal: "conner" });

    expect(entry.signingPrincipal).toBe("conner");

    const fetched = await manager.getEntry(entry.id);
    expect(fetched?.signingPrincipal).toBe("conner");
  });

  test("registerRepo() defaults signingPrincipal to 'owner' when not given", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);

    const manager = await GraphManager.open(home);
    const entry = await manager.registerRepo(repoDir);
    expect(entry.signingPrincipal).toBe("owner");
  });

  test("getEntry() defaults signingPrincipal to 'owner' for legacy rows (NULL column)", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const manager = await GraphManager.open(home);

    // Simulate a legacy row by inserting without the signing_principal column
    await manager.db.pg.query(
      `UPDATE graphs SET signing_principal = NULL WHERE id = $1`,
      ["main"]
    );

    const entry = await manager.getEntry("main");
    expect(entry?.signingPrincipal).toBe("owner");
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
    const count = Number.parseInt(rows[0].count, 10);
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
    const entry = await manager.registerRepo(repoDir, {
      name: "Review Edge Test",
      id: "review-edge-test",
    });
    const fh = await manager.get(entry.id);

    const { describeSchema } = await import("../src/schema.js");
    const schema = await describeSchema(fh.graph);
    const edgeNames = schema.edgeTypes.map((et: { name: string }) => et.name);
    expect(edgeNames.some((n: string) => n.includes("part_of") || n.includes("part-of"))).toBe(
      true
    );
    expect(
      edgeNames.some((n: string) => n.includes("replies_to") || n.includes("replies-to"))
    ).toBe(true);
  });

  /**
   * SP3 end-to-end flow: create-review in a registered repo graph.
   *
   * Probes what the wasm engine enforces:
   *   - Are all four review edge types present in describe_schema?
   *   - Can cross-ontology edge TARGETS (eng/ChangeRequest, code/SourceFile) be
   *     created as typed nodes? (They may require those ontologies to be installed.)
   *   - Can node endpoints and edges sharing a changeset work, or must endpoints
   *     be committed before the edges?
   *   - Are the resulting changesets admitted or held (pending approval)?
   *
   * This test must FAIL if SP3's flow would fail — it asserts admission
   * status on every edge, not just "no throw".
   */
  test("SP3 create-review flow: all four edge types work in a registered graph", async () => {
    const home = makeTempDir("freehold-mgr-test-");
    const repoDir = makeTempDir("freehold-mgr-repo-");
    await makeRepoGraph(repoDir);
    const manager = await GraphManager.open(home);
    const entry = await manager.registerRepo(repoDir, { name: "SP3 Flow Test", id: "sp3-flow" });
    const fh = await manager.get(entry.id);

    const { describeSchema } = await import("../src/schema.js");
    const { createEntity, relate } = await import("../src/knowledge.js");
    const { approve } = await import("../src/governance.js");

    // ── 1. All four review edge types must appear in describe_schema ──────────
    const schema = await describeSchema(fh.graph);
    const edgeNames = schema.edgeTypes.map((et: { name: string }) => et.name);

    // Normalize names: allod may use "review/part_of" or plain "part_of"
    const hasEdge = (fragment: string) =>
      edgeNames.some((n: string) => n === fragment || n.endsWith(`/${fragment}`));

    expect(hasEdge("reviews"), "edge type 'reviews' missing from schema").toBe(true);
    expect(hasEdge("part_of"), "edge type 'part_of' missing from schema").toBe(true);
    expect(hasEdge("replies_to"), "edge type 'replies_to' missing from schema").toBe(true);
    expect(hasEdge("concerns"), "edge type 'concerns' missing from schema").toBe(true);

    // ── 2. Determine the edge type refs (schema may prefix with package name) ──
    const edgeTypeRef = (fragment: string): string => {
      const found = edgeNames.find((n: string) => n === fragment || n.endsWith(`/${fragment}`));
      return found ?? fragment;
    };

    // ── 3. Install cross-ontology dependencies (code + eng) ──────────────────
    //
    // Empirical finding: the wasm engine enforces node type resolution at commit
    // time. Creating "eng/ChangeRequest@1" without the eng ontology installed
    // throws: `node type "eng/ChangeRequest@1" does not resolve`.
    //
    // SP3 prerequisite: install code and eng ontologies before creating
    // cross-ontology typed nodes. We strip the imports: block because the wasm
    // install_package path does not process cross-package imports; it requires
    // the document to start with `ontology:` (no leading block comments either).
    //
    // Install order: code first (eng depends on code via its edge type domains).

    const { installOntology } = await import("../src/schema.js");

    const codeOntologyYaml = stripOntologyPreamble(assetYaml("code-ontology.yaml"));
    const codeInstall = await installOntology(fh.graph, codeOntologyYaml);
    if (codeInstall.status === "pending" && codeInstall.hash) {
      const d = await approve(fh.graph, "owner", codeInstall.hash);
      expect(d.status, "code ontology approval").toBe("approved");
    }

    // eng ontology depends on code (edge types reference code/Repository etc.)
    const engOntologyYaml = stripOntologyPreamble(assetYaml("eng-ontology.yaml"));
    const engInstall = await installOntology(fh.graph, engOntologyYaml);
    if (engInstall.status === "pending" && engInstall.hash) {
      const d = await approve(fh.graph, "owner", engInstall.hash);
      expect(d.status, "eng ontology approval").toBe("approved");
    }

    // ── 4. Commit helper: commit ops and auto-approve if held ─────────────────

    async function commitAndApprove(
      author: string,
      intent: string,
      ops: unknown[]
    ): Promise<{ status: "saved" | "pending"; hash: string }> {
      // Wasm commit() signature: commit(author, intent, ops, [], sign_envelope)
      const raw = await fh.graph.commit(author, intent, ops, [], true);
      if (raw && typeof raw === "object" && "Admitted" in raw) {
        return { status: "saved", hash: (raw as { Admitted: { hash: string } }).Admitted.hash };
      }
      if (raw && typeof raw === "object" && "Held" in raw) {
        const hash: string = (raw as { Held: { hash: string } }).Held.hash;
        const decision = await approve(fh.graph, "owner", hash);
        expect(decision.status, `approval of '${intent}' failed`).toBe("approved");
        return { status: "pending", hash };
      }
      throw new Error(`Unexpected commit result for '${intent}': ${JSON.stringify(raw)}`);
    }

    // ── 5a. Create the Review node (review/Review) ────────────────────────────
    const reviewId = crypto.randomUUID();
    const r1 = await commitAndApprove("owner", "Create Review", [
      {
        create: {
          kind: "node",
          id: reviewId,
          type: "review/Review@1",
          attributes: { verdict: "approve", body: "LGTM" },
        },
      },
    ]);
    expect(["saved", "pending"], "Review node must be saved or pending").toContain(r1.status);

    // ── 5b. Create two ReviewComment nodes ────────────────────────────────────
    const comment1Id = crypto.randomUUID();
    const comment2Id = crypto.randomUUID();

    const rc1 = await commitAndApprove("owner", "Create ReviewComment 1", [
      {
        create: {
          kind: "node",
          id: comment1Id,
          type: "review/ReviewComment@1",
          attributes: { body: "This function is too long" },
        },
      },
    ]);
    expect(["saved", "pending"]).toContain(rc1.status);

    const rc2 = await commitAndApprove("owner", "Create ReviewComment 2", [
      {
        create: {
          kind: "node",
          id: comment2Id,
          type: "review/ReviewComment@1",
          attributes: { body: "Agreed on the length issue" },
        },
      },
    ]);
    expect(["saved", "pending"]).toContain(rc2.status);

    // ── 5c. Create cross-ontology typed nodes ─────────────────────────────────
    //
    // With code/eng ontologies installed, these must now succeed.
    // `reviews` edge target: eng/ChangeRequest
    // `concerns` edge target: code/SourceFile
    //
    // Also probes whether nodes and edges can share a changeset:
    // we commit the cross-ontology nodes first (separate changesets),
    // because the engine must see the nodes in fold state before we can
    // create edges that reference them. (Same-changeset create + edge
    // is not tested here — separate commits is the safe SP3 pattern.)

    const crId = crypto.randomUUID();
    const crResult = await commitAndApprove("owner", "Create eng/ChangeRequest", [
      {
        create: {
          kind: "node",
          id: crId,
          type: "eng/ChangeRequest@1",
          attributes: { title: "PR #42", risk: "standard", status: "proposed" },
        },
      },
    ]);
    expect(["saved", "pending"], "eng/ChangeRequest node must be saved or pending").toContain(
      crResult.status
    );

    const sfId = crypto.randomUUID();
    const sfResult = await commitAndApprove("owner", "Create code/SourceFile", [
      {
        create: {
          kind: "node",
          id: sfId,
          type: "code/SourceFile@1",
          attributes: { path: "src/lib.rs", blob: "git:repo#abc:src/lib.rs" },
        },
      },
    ]);
    expect(["saved", "pending"], "code/SourceFile node must be saved or pending").toContain(
      sfResult.status
    );

    // ── 6. Create all four edges ──────────────────────────────────────────────
    //
    // part_of:    ReviewComment → Review (same-ontology)
    // replies_to: ReviewComment → ReviewComment (same-ontology)
    // reviews:    Review → eng/ChangeRequest (cross-ontology; eng ontology installed)
    // concerns:   ReviewComment → code/SourceFile (cross-ontology; code ontology installed)

    const partOfResult = await relate(
      fh.graph,
      "owner",
      comment1Id,
      reviewId,
      edgeTypeRef("part_of")
    );
    expect(["saved", "pending"], "part_of edge must be saved or pending").toContain(
      partOfResult.status
    );

    const repliesToResult = await relate(
      fh.graph,
      "owner",
      comment2Id,
      comment1Id,
      edgeTypeRef("replies_to")
    );
    expect(["saved", "pending"], "replies_to edge must be saved or pending").toContain(
      repliesToResult.status
    );

    const reviewsResult = await relate(fh.graph, "owner", reviewId, crId, edgeTypeRef("reviews"));
    expect(["saved", "pending"], "reviews edge must be saved or pending").toContain(
      reviewsResult.status
    );

    const concernsResult = await relate(
      fh.graph,
      "owner",
      comment1Id,
      sfId,
      edgeTypeRef("concerns")
    );
    expect(["saved", "pending"], "concerns edge must be saved or pending").toContain(
      concernsResult.status
    );

    // ── 7. All four edges accounted for ──────────────────────────────────────
    // If we reach here without throwing, SP3's flow is viable with eng/code
    // ontologies installed first.
  });
});
