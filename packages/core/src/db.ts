/**
 * @freehold/core — PGlite database initialization
 *
 * Opens (or creates) a PGlite database with pgvector and the Freehold schema.
 * Uses raw SQL for DDL because drizzle's type-safe schema declarations don't
 * handle vector(384) and tsvector cleanly with the pglite adapter.
 *
 * Binary mode (bun --compile):
 *   PGlite's pglite.data and vector.tar.gz are NOT embedded by bun's bundler
 *   automatically.  When running from a compiled binary (detected via the
 *   "/$bunfs/" prefix on import.meta.url), we load these files from sidecar
 *   paths placed next to the binary by compile-binary.mjs:
 *     <binary-dir>/freehold.pglite.data
 *     <binary-dir>/freehold.pglite.wasm
 *     <binary-dir>/freehold.initdb.wasm
 *     <binary-dir>/freehold.vector.tar.gz
 *   and pass them via PGliteOptions (fsBundle, pgliteWasmModule, etc.) so
 *   pglite never tries to read from the virtual /$bunfs filesystem.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type Extension, type ExtensionSetupResult, PGlite } from "@electric-sql/pglite";
import { vector as _vectorExt } from "@electric-sql/pglite-pgvector";

export type DbHandle = { pg: PGlite };

/** The default graph id used by all existing call sites. */
export const DEFAULT_GRAPH_ID = "main";

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS objects (
  id text PRIMARY KEY,
  kind text NOT NULL,
  type text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',
  author text NOT NULL DEFAULT '',
  method text DEFAULT NULL,
  approval text NOT NULL DEFAULT 'saved',
  changeset text NOT NULL DEFAULT '',
  search_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS objects_fts ON objects USING gin(to_tsvector('english', search_text));

CREATE TABLE IF NOT EXISTS embeddings (
  object_id text PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  -- Column named "vec" rather than "vector" because "vector" is the pgvector type
  -- name; using it as a column identifier causes parse errors in some SQL dialects.
  -- All queries in indexer.ts and recall.ts reference this column as "vec".
  vec vector(384) NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key text NOT NULL,
  value text NOT NULL
);

-- Edges and taxonomy terms mirrored from admitted changesets, so listings
-- never need per-node wasm calls.
CREATE TABLE IF NOT EXISTS graph_edges (
  id text PRIMARY KEY,
  type text NOT NULL,
  from_id text NOT NULL,
  to_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_edges_from ON graph_edges(from_id);
CREATE INDEX IF NOT EXISTS graph_edges_to ON graph_edges(to_id);

CREATE TABLE IF NOT EXISTS node_terms (
  subject_id text NOT NULL,
  term text NOT NULL
);
`;

/**
 * Format a number[] vector as the '[x,y,z,...]' literal PGlite's vector type expects.
 * Shared by indexer.ts and recall.ts to avoid duplication.
 */
export function fmtVec(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Detect whether we are running inside a `bun --compile` binary.
 *
 * In a compiled binary, all bundled module URLs have the synthetic prefix
 * "/$bunfs/" rather than a real filesystem path.
 */
function isCompiledBinary(): boolean {
  return import.meta.url.startsWith("file:///$bunfs/");
}

/**
 * Return the directory that contains the compiled binary.
 * Only call this when isCompiledBinary() is true.
 */
function binaryDir(): string {
  return path.dirname(process.execPath);
}

/**
 * Build PGlite options for the compiled binary case.
 *
 * Reads sidecar files from the directory containing the binary and returns
 * options that bypass pglite's own file-loading logic (which would look in
 * the virtual /$bunfs filesystem and fail).
 *
 * Expected sidecars (placed by compile-binary.mjs):
 *   freehold.pglite.wasm  — pglite.wasm
 *   freehold.pglite.data  — pglite.data (the FS bundle)
 *   freehold.initdb.wasm  — initdb.wasm
 *   freehold.vector.tar.gz — vector extension bundle
 */
function buildBinaryPgOptions(): {
  fsBundle: Blob;
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
  vectorBundlePath: URL;
} {
  const dir = binaryDir();

  const readSidecar = (name: string): ArrayBuffer => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      throw new Error(
        `[freehold] compiled binary is missing sidecar file: ${p}\nRun the build script to regenerate the binary with its sidecars.`
      );
    }
    const buf = fs.readFileSync(p);
    // slice() copies the underlying bytes into a plain ArrayBuffer (not SharedArrayBuffer)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  };

  const pgliteWasmBytes = readSidecar("freehold.pglite.wasm");
  const initdbWasmBytes = readSidecar("freehold.initdb.wasm");
  const pgliteDataBytes = readSidecar("freehold.pglite.data");
  const vectorTarGzPath = path.join(dir, "freehold.vector.tar.gz");
  if (!fs.existsSync(vectorTarGzPath)) {
    throw new Error(`[freehold] compiled binary is missing sidecar: ${vectorTarGzPath}`);
  }

  return {
    fsBundle: new Blob([pgliteDataBytes]),
    pgliteWasmModule: new WebAssembly.Module(pgliteWasmBytes),
    initdbWasmModule: new WebAssembly.Module(initdbWasmBytes),
    // file:// URL is accepted by pglite's extension loader for bundlePath
    vectorBundlePath: new URL(`file://${vectorTarGzPath}`),
  };
}

/**
 * Build a custom vector extension that uses a sidecar bundlePath.
 *
 * In binary mode the normal vector extension's bundlePath points into /$bunfs
 * which doesn't contain the .tar.gz file.  We replace it with a file:// URL
 * that points at the sidecar placed next to the binary.
 */
function makeSidecarVectorExt(vectorBundlePath: URL): Extension {
  return {
    name: "vector",
    setup: async (pg, emscriptenOpts): Promise<ExtensionSetupResult> => {
      // Delegate to the real vector extension's setup so we inherit all its
      // initialisation logic; then override the bundlePath it returns.
      const base = await (_vectorExt as Extension).setup(pg, emscriptenOpts);
      return { ...base, bundlePath: vectorBundlePath };
    },
  };
}

export async function openDb(pgDir: string): Promise<DbHandle> {
  let pg: PGlite;

  if (isCompiledBinary()) {
    const { fsBundle, pgliteWasmModule, initdbWasmModule, vectorBundlePath } =
      buildBinaryPgOptions();
    const sidecarVector = makeSidecarVectorExt(vectorBundlePath);
    pg = new PGlite(pgDir, {
      extensions: { vector: sidecarVector },
      fsBundle,
      pgliteWasmModule,
      initdbWasmModule,
    });
  } else {
    pg = new PGlite(pgDir, { extensions: { vector: _vectorExt as unknown as Extension } });
  }

  await pg.waitReady;
  await pg.exec(SCHEMA_SQL);

  // Migrate: make method nullable for existing databases created before commit 23ab9cd.
  // Existing databases may have 'method text NOT NULL', which blocks inserts of null values.
  // ALTER COLUMN SET NOT NULL is idempotent; dropping the constraint is safe if it exists.
  try {
    await pg.exec("ALTER TABLE objects ALTER COLUMN method DROP NOT NULL");
  } catch {
    // Constraint may not exist on fresh databases; that's fine
  }

  // Migrate: rename approval value 'admitted' → 'saved' for existing databases created
  // before the status string rename. Idempotent: rows already holding 'saved' are unaffected.
  try {
    await pg.exec("UPDATE objects SET approval='saved' WHERE approval='admitted'");
  } catch {
    // No-op if the table doesn't exist yet (handled by the schema DDL above)
  }

  // Migrate: add graph_id columns to existing tables (additive, defaults to 'main').
  // All ALTER TABLE … ADD COLUMN IF NOT EXISTS are idempotent.
  try {
    await pg.exec(
      "ALTER TABLE objects     ADD COLUMN IF NOT EXISTS graph_id text NOT NULL DEFAULT 'main'"
    );
  } catch {
    // Column may already exist
  }
  try {
    await pg.exec(
      "ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS graph_id text NOT NULL DEFAULT 'main'"
    );
  } catch {
    // Column may already exist
  }
  try {
    await pg.exec(
      "ALTER TABLE node_terms  ADD COLUMN IF NOT EXISTS graph_id text NOT NULL DEFAULT 'main'"
    );
  } catch {
    // Column may already exist
  }
  try {
    await pg.exec(
      "ALTER TABLE meta        ADD COLUMN IF NOT EXISTS graph_id text NOT NULL DEFAULT 'main'"
    );
  } catch {
    // Column may already exist
  }

  // Migrate: create graph-scoped indexes (IF NOT EXISTS = idempotent).
  try {
    await pg.exec(
      "CREATE INDEX IF NOT EXISTS objects_graph_idx     ON objects (graph_id)"
    );
  } catch {
    // Ignore
  }
  try {
    await pg.exec(
      "CREATE INDEX IF NOT EXISTS graph_edges_graph_idx ON graph_edges (graph_id)"
    );
  } catch {
    // Ignore
  }

  // Migrate: recreate PKs for node_terms and meta to be (graph_id, …) composite.
  // For node_terms: old PK was (subject_id, term); new PK is (graph_id, subject_id, term).
  // For meta: old PK was (key); new PK is (graph_id, key).
  // We use a DO $$ block so failures (already migrated) are caught per-statement.
  try {
    await pg.exec(`
      DO $$ BEGIN
        ALTER TABLE node_terms DROP CONSTRAINT IF EXISTS node_terms_pkey;
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$
    `);
    await pg.exec(
      "ALTER TABLE node_terms ADD PRIMARY KEY (graph_id, subject_id, term)"
    );
  } catch {
    // Already has the composite PK (fresh DB or previously migrated)
  }
  try {
    await pg.exec(`
      DO $$ BEGIN
        ALTER TABLE meta DROP CONSTRAINT IF EXISTS meta_pkey;
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$
    `);
    await pg.exec("ALTER TABLE meta ADD PRIMARY KEY (graph_id, key)");
  } catch {
    // Already has the composite PK
  }

  return { pg };
}

// ---- Graph-scoped query helpers ----
//
// Every helper that reads/writes a graph-scoped table takes `graphId: string`
// as its first argument. Pass DEFAULT_GRAPH_ID at existing call sites.

export interface ObjectRow {
  id: string;
  kind: string;
  type: string;
  content: unknown;
  author: string;
  method: string | null;
  approval: string;
  changeset: string;
  search_text: string;
}

export interface UpsertObjectParams {
  id: string;
  kind: string;
  type: string;
  content: Record<string, unknown>;
  author: string;
  method: string | null;
  approval: string;
  changeset: string;
  searchText: string;
}

/**
 * Upsert a row into the objects table for the given graph.
 */
export async function upsertObject(
  graphId: string,
  pg: PGlite,
  params: UpsertObjectParams
): Promise<void> {
  await pg.query(
    `INSERT INTO objects (id, kind, type, content, author, method, approval, changeset, search_text, graph_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind,
       type = EXCLUDED.type,
       content = EXCLUDED.content,
       author = EXCLUDED.author,
       method = EXCLUDED.method,
       approval = EXCLUDED.approval,
       changeset = EXCLUDED.changeset,
       search_text = EXCLUDED.search_text,
       graph_id = EXCLUDED.graph_id,
       updated_at = now()`,
    [
      params.id,
      params.kind,
      params.type,
      JSON.stringify(params.content),
      params.author,
      params.method,
      params.approval,
      params.changeset,
      params.searchText,
      graphId,
    ]
  );
}

/**
 * List all object rows for a given graph, ordered by created_at DESC.
 */
export async function listObjects(graphId: string, pg: PGlite): Promise<ObjectRow[]> {
  const result = await pg.query<ObjectRow>(
    `SELECT id, kind, type, content, author, method, approval, changeset, search_text
     FROM objects WHERE graph_id = $1 ORDER BY created_at DESC`,
    [graphId]
  );
  return result.rows;
}

/**
 * Get the indexed_head cursor for a graph. Returns 0 if not set.
 */
export async function getIndexedHead(graphId: string, pg: PGlite): Promise<number> {
  const result = await pg.query<{ value: string }>(
    "SELECT value FROM meta WHERE graph_id = $1 AND key = 'indexed_head'",
    [graphId]
  );
  return result.rows.length > 0 ? Number.parseInt(result.rows[0].value, 10) : 0;
}

/**
 * Set (upsert) the indexed_head cursor for a graph.
 */
export async function setIndexedHead(graphId: string, pg: PGlite, head: number): Promise<void> {
  await pg.query(
    `INSERT INTO meta (graph_id, key, value) VALUES ($1, 'indexed_head', $2)
     ON CONFLICT (graph_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [graphId, head.toString()]
  );
}

/**
 * Delete the indexed_head cursor for a graph (used during reindex).
 */
export async function deleteIndexedHead(graphId: string, pg: PGlite): Promise<void> {
  await pg.query("DELETE FROM meta WHERE graph_id = $1 AND key = 'indexed_head'", [graphId]);
}

/**
 * Upsert an edge row for a given graph.
 */
export async function upsertEdge(
  graphId: string,
  pg: PGlite,
  params: { id: string; type: string; from: string; to: string }
): Promise<void> {
  await pg.query(
    `INSERT INTO graph_edges (id, type, from_id, to_id, graph_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [params.id, params.type, params.from, params.to, graphId]
  );
}

/**
 * Upsert a node classification term for a given graph.
 */
export async function upsertNodeTerm(
  graphId: string,
  pg: PGlite,
  params: { subjectId: string; term: string }
): Promise<void> {
  await pg.query(
    `INSERT INTO node_terms (graph_id, subject_id, term) VALUES ($1, $2, $3)
     ON CONFLICT (graph_id, subject_id, term) DO NOTHING`,
    [graphId, params.subjectId, params.term]
  );
}
