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
  key text PRIMARY KEY,
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
  term text NOT NULL,
  PRIMARY KEY (subject_id, term)
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

  return { pg };
}
