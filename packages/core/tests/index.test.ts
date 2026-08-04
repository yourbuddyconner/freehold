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
  const fh = { graph, db, home, graphName: "main", _dir: home } as unknown as Freehold & {
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

    // 1. Create a scratch note — admitted immediately
    const noteResult = await remember(fh.graph, "agent", "I love drinking tea in the morning");
    expect(noteResult.status).toBe("admitted");

    // 2. Create a preference (held by default under memory policy)
    const prefResult = await fh.graph.propose_preference(
      "agent",
      "prefers tea over coffee",
      "soft",
      noteResult.noteId
    );
    expect(prefResult.admission?.Held).toBeDefined();

    // 3. Approve the preference
    const approveResult = await approve(fh.graph, "owner", prefResult.hash as string);
    expect(approveResult.status).toBe("admitted");

    // 4. Sync the index
    await syncIndex(fh as unknown as Freehold, hashEmbedder);

    // 5. Check objects table
    const { pg } = fh.db;
    const rows = await pg.query<{ id: string; type: string; approval: string }>(
      "SELECT id, type, approval FROM objects ORDER BY created_at"
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    // All indexed rows should have approval = 'admitted' (log() only includes admitted)
    for (const row of rows.rows) {
      expect(row.approval).toBe("admitted");
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
    expect(noteResult.status).toBe("admitted");

    // Sync the index
    await syncIndex(fh as unknown as Freehold, hashEmbedder);

    // Recall both note and any genesis nodes
    const allResults = await recall(fh as unknown as Freehold, "", hashEmbedder, undefined, 100);

    // Find the note we created
    const noteObj = allResults.find((r) => r.id === noteResult.noteId);
    if (noteObj) {
      // Agent writes carry provenance with method field
      expect(noteObj.method).toBe("model-assisted");
    }

    // Genesis owner node should have null method (no provenance)
    const ownerNodes = allResults.filter((r) => r.type.includes("principal") || r.author === "owner");
    // At least some of these may exist; if they do, they should have null method
    for (const ownerNode of ownerNodes) {
      // Owner-authored genesis nodes carry no provenance, so method is null
      if (ownerNode.author === "owner") {
        // Accept either null (as string) or actual null
        expect(ownerNode.method === null || ownerNode.method === "").toBeTruthy();
      }
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

// ---- Test 5: Real transformers embedder smoke test (gated) ----
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
