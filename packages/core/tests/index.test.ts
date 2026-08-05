/**
 * F3 acceptance tests: embed, index, recall.
 *
 * All tests use hashEmbedder so no model download is needed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import { openDb } from "../src/db.js";
import { hashEmbedder, transformersEmbedder } from "../src/embed.js";
import { approve } from "../src/governance.js";
import type { Freehold } from "../src/graphs.js";
import { reindex, syncIndex } from "../src/indexer.js";
import { remember } from "../src/knowledge.js";
import { recall } from "../src/recall.js";

// ---- Helpers ----

/**
 * Build a minimal Freehold-like object backed by a fresh temp graph + pglite.
 * We don't call Freehold.open() to avoid loading the full config machinery.
 */
async function makeFreehold(dir?: string): Promise<Freehold & { _dir: string }> {
  const home = dir ?? mkdtempSync(join(tmpdir(), "freehold-f3-test-"));
  const graphDir = join(home, "graphs", "main");
  const graph = await createGraph(graphDir, "owner");
  await graph.principal_add("agent", "agent", "owner");
  const db = await openDb(join(home, "pg"));

  // Cast to Freehold — shape-compatible
  const fh = {
    graph,
    db,
    home,
    graphName: "main",
    graphId: "main",
    kind: "memory" as const,
    graphDir,
    _dir: home,
  } as unknown as Freehold & {
    _dir: string;
  };
  return fh;
}

// Helper: snapshot objects table (sorted by id, without timestamps)
async function snapshot(pg: PGlite): Promise<
  Array<{
    id: string;
    kind: string;
    type: string;
    author: string;
    method: string | null;
    approval: string;
    search_text: string;
  }>
> {
  const result = await pg.query<{
    id: string;
    kind: string;
    type: string;
    author: string;
    method: string | null;
    approval: string;
    search_text: string;
  }>("SELECT id, kind, type, author, method, approval, search_text FROM objects ORDER BY id");
  return result.rows;
}

// ---- Test 1: hashEmbedder determinism ----

describe("hashEmbedder", () => {
  test("produces identical vectors for the same input", async () => {
    const v1 = await hashEmbedder.embed(["hello world"]);
    const v2 = await hashEmbedder.embed(["hello world"]);
    expect(v1[0]).toEqual(v2[0]);
    expect(v1[0].length).toBe(384);
    // Unit vector: magnitude ≈ 1
    const mag = Math.sqrt(v1[0].reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1.0, 5);
  });

  test("produces different vectors for different inputs", async () => {
    const v1 = await hashEmbedder.embed(["hello world"]);
    const v2 = await hashEmbedder.embed(["goodbye world"]);
    // Vectors should differ
    const allSame = v1[0].every((x, i) => x === v2[0][i]);
    expect(allSame).toBe(false);
  });
});

// ---- Test 2: index after memory loop ----

describe("syncIndex", () => {
  test("index after memory loop has note + preference rows with correct approval", async () => {
    const fh = await makeFreehold();

    // 1. Create a scratch note — saved immediately
    const noteResult = await remember(fh.graph, "agent", "I love drinking tea in the morning");
    expect(noteResult.status).toBe("saved");

    // 2. Create a preference (pending by default under memory policy)
    const prefResult = await fh.graph.propose_preference(
      "agent",
      "prefers tea over coffee",
      "soft",
      noteResult.noteId
    );
    expect(prefResult.admission?.Held).toBeDefined();

    // 3. Approve the preference
    const approveResult = await approve(fh.graph, "owner", prefResult.hash as string);
    expect(approveResult.status).toBe("approved");

    // 4. Sync the index
    await syncIndex(fh as unknown as Freehold, hashEmbedder);

    // 5. Check objects table
    const { pg } = fh.db;
    const rows = await pg.query<{ id: string; type: string; approval: string }>(
      "SELECT id, type, approval FROM objects ORDER BY created_at"
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    // All indexed rows should have approval = 'saved' (log() only includes saved/approved changesets)
    for (const row of rows.rows) {
      expect(row.approval).toBe("saved");
    }

    // Check indexed_head is updated
    const meta = await pg.query<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'indexed_head'"
    );
    expect(meta.rows.length).toBe(1);
    expect(Number.parseInt(meta.rows[0].value, 10)).toBeGreaterThan(0);
  });

  test("syncIndex is idempotent (safe to call twice)", async () => {
    const fh = await makeFreehold();
    await remember(fh.graph, "agent", "some note");
    await syncIndex(fh as unknown as Freehold, hashEmbedder);
    await syncIndex(fh as unknown as Freehold, hashEmbedder);
    const { pg } = fh.db;
    const rows = await pg.query<{ id: string }>("SELECT id FROM objects");
    // Should not have duplicates
    const ids = rows.rows.map((r) => r.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });
});

// ---- Test 3: recall("tea") finds preference ----

describe("recall", () => {
  test("finds the tea preference with provenance", async () => {
    const fh = await makeFreehold();

    // Create note about tea
    const noteResult = await remember(fh.graph, "agent", "I love drinking tea in the morning");

    // Create preference about tea (held, then approve)
    const prefResult = await fh.graph.propose_preference(
      "agent",
      "prefers tea over coffee",
      "soft",
      noteResult.noteId
    );
    await approve(fh.graph, "owner", prefResult.hash as string);

    // Sync
    await syncIndex(fh as unknown as Freehold, hashEmbedder);

    // Recall
    const results = await recall(fh as unknown as Freehold, "tea", hashEmbedder);
    expect(results.length).toBeGreaterThan(0);

    // Each result has the required fields
    const first = results[0];
    expect(typeof first.id).toBe("string");
    expect(typeof first.type).toBe("string");
    expect(typeof first.author).toBe("string");
    // method is string or null (for unrecorded provenance)
    expect(first.method === null || typeof first.method === "string").toBe(true);
    expect(typeof first.approval).toBe("string");
    expect(typeof first.changeset).toBe("string");
    expect(typeof first.score).toBe("number");
    expect(first.score).toBeGreaterThan(0);
  });

  test("indexes agent write with model-assisted method and genesis owner node with null method", async () => {
    const fh = await makeFreehold();

    // Create an agent-authored note (should have method = "model-assisted" from provenance)
    const noteResult = await remember(fh.graph, "agent", "an agent note");
    expect(noteResult.status).toBe("saved");

    // Sync the index
    await syncIndex(fh as unknown as Freehold, hashEmbedder);

    // Recall both note and any genesis nodes
    const allResults = await recall(fh as unknown as Freehold, "", hashEmbedder, undefined, 100);

    // Find the note we created
    const noteObj = allResults.find((r) => r.id === noteResult.noteId);
    expect(noteObj).toBeDefined();
    if (noteObj) {
      // Agent writes carry provenance with method field
      expect(noteObj.method).toBe("model-assisted");
    }

    // Genesis owner node should have null method (no provenance).
    // The principal/owner node is created during graph init and has no provenance stamp.
    const ownerNodes = allResults.filter((r) => r.author === "owner");
    expect(ownerNodes.length).toBeGreaterThan(0);
    for (const ownerNode of ownerNodes) {
      // Owner-authored genesis nodes carry no provenance, so method must be null
      expect(ownerNode.method).toBeNull();
    }
  });
});

// ---- Test 4: REINDEX GOLDEN ----

describe("reindex golden", () => {
  test("wipe pg dir, reindex, identical rows", async () => {
    const home = mkdtempSync(join(tmpdir(), "freehold-reindex-golden-"));
    const fh = await makeFreehold(home);

    // Add some data
    await remember(fh.graph, "agent", "first note about coffee");
    await remember(fh.graph, "agent", "second note about tea");
    const prefResult = await fh.graph.propose_preference(
      "agent",
      "prefers coffee in the morning",
      "hard",
      undefined
    );
    // Approve the preference
    if (prefResult.hash) {
      await approve(fh.graph, "owner", prefResult.hash as string);
    }

    // Step 1: syncIndex and snapshot
    await syncIndex(fh as unknown as Freehold, hashEmbedder);
    const snap1 = await snapshot(fh.db.pg);

    // Step 2: wipe pg dir and re-open it
    await fh.db.pg.close();
    rmSync(join(home, "pg"), { recursive: true, force: true });

    // Re-open fresh pg
    const db2 = await openDb(join(home, "pg"));
    (fh as { db: typeof db2 }).db = db2;

    // Step 3: reindex
    await reindex(fh as unknown as Freehold, hashEmbedder);
    const snap2 = await snapshot(db2.pg);

    // Step 4: compare
    expect(snap2).toEqual(snap1);
  });
});

// ---- Test 5: Approved preference survives reindex ----

describe("reindex: approved preference row", () => {
  test("held → approve → reindex: Preference row exists with search_text=statement and approval=admitted", async () => {
    const fh = await makeFreehold();
    const statement = "prefers quiet workspaces over open-plan offices";

    // 1. Propose a preference (pending by default under memory policy)
    const prefResult = await fh.graph.propose_preference("agent", statement, "soft", undefined);
    expect(prefResult.admission?.Held).toBeDefined();
    const prefHash = prefResult.hash as string;

    // 2. Owner approves — this saves the preference node via decide()
    const approveResult = await approve(fh.graph, "owner", prefHash);
    expect(approveResult.status).toBe("approved");

    // 3. Full reindex (wipes pg and rebuilds from scratch)
    await reindex(fh as unknown as Freehold, hashEmbedder);

    // 4. Assert the Preference row exists with correct fields
    const { pg } = fh.db;
    const prefRows = await pg.query<{
      id: string;
      type: string;
      search_text: string;
      approval: string;
    }>("SELECT id, type, search_text, approval FROM objects WHERE type LIKE '%Preference%'");

    expect(prefRows.rows.length).toBe(1);
    const row = prefRows.rows[0];
    expect(row.search_text).toBe(statement);
    expect(row.approval).toBe("saved");

    // 5. recall() finds the preference ranked above unrelated rows
    //    (words from the statement overlap with the FTS/embedding query)
    const results = await recall(fh as unknown as Freehold, "quiet workspaces", hashEmbedder);
    expect(results.length).toBeGreaterThan(0);
    // The preference row must appear in the results
    const prefInResults = results.find((r) => r.id === row.id);
    expect(prefInResults).toBeDefined();
    // The preference must be the top-ranked result: its statement directly
    // contains the query words "quiet" and "workspaces" so it wins both
    // vector (via hashEmbedder similarity) and FTS
    expect(results[0].id).toBe(row.id);
  });
});

// ---- Test 6: Regression — alphabetical YAML field order in changeset ----
//
// Root cause of the live reindex miss (2026-08-04): the old line-scanner relied
// on "kind: node" appearing before "id:" in each op block. The WASM YAML
// serialiser preserves JS object key insertion order, so ops built with
// attributes before kind produce "attributes → id → kind → …" YAML.
// The structural js-yaml parser is order-agnostic.
//
// This test reproduces the EXACT live delta: an op where JS key order is
// alphabetical (attributes→id→kind→provenance→type), which was the ordering
// produced by the real agent tool session that created the live Preference.

describe("reindex: alphabetical YAML field order (live-delta regression)", () => {
  test("op with attributes-before-kind YAML is indexed after approve → reindex", async () => {
    const fh = await makeFreehold();
    const statement = "uses alphabetical op key order — regression guard";

    // Build the op in alphabetical key order (replicates live YAML structure)
    const nodeId = crypto.randomUUID();
    const ops = [
      {
        create: {
          attributes: { statement, strength: "soft" },
          id: nodeId,
          kind: "node",
          provenance: {
            derived_by: "principal:agent",
            method: "model-assisted",
            tool: "freehold@0.1",
          },
          type: "memory/Preference@1",
        },
      },
    ];

    // 1. Commit via graph.commit() — produces held changeset
    const raw = (await fh.graph.commit("agent", "Create memory/Preference@1", ops, [], true)) as {
      Held?: { hash: string };
    };
    expect(raw.Held?.hash).toBeDefined();
    const hash = raw.Held?.hash as string;

    // 2. Approve so the changeset is saved to the log
    const result = await approve(fh.graph, "owner", hash);
    expect(result.status).toBe("approved");

    // 3. Full reindex (wipes pg and rebuilds from scratch)
    await reindex(fh as unknown as Freehold, hashEmbedder);

    // 4. The Preference row must exist with correct search_text
    const { pg } = fh.db;
    const rows = await pg.query<{ id: string; type: string; search_text: string }>(
      "SELECT id, type, search_text FROM objects WHERE id = $1",
      [nodeId]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].search_text).toBe(statement);

    // 5. recall() must surface the preference (was the live-reported failure)
    const results = await recall(
      fh as unknown as Freehold,
      "alphabetical regression",
      hashEmbedder
    );
    const found = results.find((r) => r.id === nodeId);
    expect(found).toBeDefined();
  });
});

// ---- Test 7: Scoped recall isolation ----
//
// A canary note written to graph "scoped" must be retrievable via recall()
// called with graphId="scoped", and must be absent from recall() called with
// graphId="main".  hashEmbedder makes this deterministic (no model download).

describe("scoped recall isolation", () => {
  test("canary retrievable from scoped graph, absent from main", async () => {
    const home = mkdtempSync(join(tmpdir(), "freehold-scope-recall-"));
    // Shared PGlite — both Freehold handles write to the same DB, different graph_id
    const db = await openDb(join(home, "pg"));

    // Graph "main" — standard makeFreehold-style handle
    const mainGraphDir = join(home, "graphs", "main");
    const mainGraph = await createGraph(mainGraphDir, "owner");
    await mainGraph.principal_add("agent", "agent", "owner");
    const mainFh = {
      graph: mainGraph,
      db,
      home,
      graphName: "main",
      graphId: "main",
      kind: "memory" as const,
      graphDir: mainGraphDir,
    } as unknown as Freehold;

    // Graph "scoped" — separate graph dir, same PGlite DB, different graphId
    const scopedGraphDir = join(home, "graphs", "scoped");
    const scopedGraph = await createGraph(scopedGraphDir, "owner");
    await scopedGraph.principal_add("agent", "agent", "owner");
    const scopedFh = {
      graph: scopedGraph,
      db,
      home,
      graphName: "scoped",
      graphId: "scoped",
      kind: "memory" as const,
      graphDir: scopedGraphDir,
    } as unknown as Freehold;

    // Write a canary note to the scoped graph only
    const canary = await remember(scopedGraph, "agent", "canary scoped note uniquetoken42");
    expect(canary.status).toBe("saved");

    // Write a decoy note to main so that recall has something to return from main
    await remember(mainGraph, "agent", "decoy main note different content");

    // Sync both indexes (each reads freehold.graphId internally)
    await syncIndex(scopedFh, hashEmbedder);
    await syncIndex(mainFh, hashEmbedder);

    // Scoped recall must find the canary
    const scopedResults = await recall(scopedFh, "uniquetoken42", hashEmbedder, undefined, 10);
    const scopedIds = scopedResults.map((r) => r.id);
    expect(scopedIds).toContain(canary.noteId);

    // Main recall must NOT contain the canary
    const mainResults = await recall(mainFh, "uniquetoken42", hashEmbedder, undefined, 10);
    const mainIds = mainResults.map((r) => r.id);
    expect(mainIds).not.toContain(canary.noteId);
  });
});

// ---- Test 8: Scoped reindex safety ----
//
// Writing to main + a scoped graph, then running reindex() with graphId="scoped",
// must rebuild the scoped graph's rows while leaving main's rows intact.

describe("scoped reindex safety", () => {
  test("scoped reindex rebuilds scoped rows and does not wipe main", async () => {
    const home = mkdtempSync(join(tmpdir(), "freehold-scope-reindex-"));
    const db = await openDb(join(home, "pg"));

    // Graph "main"
    const mainGraphDir = join(home, "graphs", "main");
    const mainGraph = await createGraph(mainGraphDir, "owner");
    await mainGraph.principal_add("agent", "agent", "owner");
    const mainFh = {
      graph: mainGraph,
      db,
      home,
      graphName: "main",
      graphId: "main",
      kind: "memory" as const,
      graphDir: mainGraphDir,
    } as unknown as Freehold;

    // Graph "scoped"
    const scopedGraphDir = join(home, "graphs", "scoped");
    const scopedGraph = await createGraph(scopedGraphDir, "owner");
    await scopedGraph.principal_add("agent", "agent", "owner");
    const scopedFh = {
      graph: scopedGraph,
      db,
      home,
      graphName: "scoped",
      graphId: "scoped",
      kind: "memory" as const,
      graphDir: scopedGraphDir,
    } as unknown as Freehold;

    // Populate both graphs and sync their indexes
    const mainNote = await remember(mainGraph, "agent", "main graph note content");
    const scopedNote = await remember(scopedGraph, "agent", "scoped graph note content");
    expect(mainNote.status).toBe("saved");
    expect(scopedNote.status).toBe("saved");

    await syncIndex(mainFh, hashEmbedder);
    await syncIndex(scopedFh, hashEmbedder);

    // Verify both are in the DB under their respective graph_ids
    const beforeMain = await db.pg.query<{ id: string }>(
      "SELECT id FROM objects WHERE graph_id = 'main'"
    );
    const beforeScoped = await db.pg.query<{ id: string }>(
      "SELECT id FROM objects WHERE graph_id = 'scoped'"
    );
    expect(beforeMain.rows.length).toBeGreaterThan(0);
    expect(beforeScoped.rows.length).toBeGreaterThan(0);
    const mainIdsBefore = beforeMain.rows.map((r) => r.id);

    // Run scoped reindex — this is the operation being guarded
    await reindex(scopedFh, hashEmbedder);

    // Main graph rows must all survive
    const afterMain = await db.pg.query<{ id: string }>(
      "SELECT id FROM objects WHERE graph_id = 'main'"
    );
    const mainIdsAfter = afterMain.rows.map((r) => r.id);
    for (const id of mainIdsBefore) {
      expect(mainIdsAfter).toContain(id);
    }

    // Scoped graph rows must be present (rebuilt by reindex)
    const afterScoped = await db.pg.query<{ id: string }>(
      "SELECT id FROM objects WHERE graph_id = 'scoped'"
    );
    expect(afterScoped.rows.length).toBeGreaterThan(0);
    // The scoped note must be re-indexed
    const scopedIds = afterScoped.rows.map((r) => r.id);
    expect(scopedIds).toContain(scopedNote.noteId);
  });
});

// ---- Test 9: Real transformers embedder smoke test (gated) ----
//
// (Renumbered from 7 — tests 7 and 8 are the scoped isolation tests above.)
//
// Run with: FREEHOLD_E2E_REAL_EMBEDDER=1 pnpm -r test
//
// Skipped in normal CI to avoid the ~30 MB one-time model download.
// When the env var is set, the test proves that transformersEmbedder returns a
// real 384-dim unit-norm vector from the Xenova/bge-small-en-v1.5 model via the
// WASM backend (onnxruntime-web, forced by the root pnpm override on onnxruntime-node).

describe("transformersEmbedder (real model, FREEHOLD_E2E_REAL_EMBEDDER=1)", () => {
  test.skipIf(!process.env.FREEHOLD_E2E_REAL_EMBEDDER)(
    "produces a 384-dim unit-norm embedding for 'hello'",
    async () => {
      const vecs = await transformersEmbedder.embed(["hello"]);
      expect(vecs).toHaveLength(1);
      const vec = vecs[0];
      expect(vec).toHaveLength(384);
      const mag = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
      // Normalized output: magnitude should be 1.0 within fp32 tolerance
      expect(mag).toBeCloseTo(1.0, 4);
    },
    // Allow up to 3 min for the first-run model download (~30 MB)
    180_000
  );
});
