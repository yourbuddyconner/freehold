/**
 * @freehold/core — PGlite database initialization
 *
 * Opens (or creates) a PGlite database with pgvector and the Freehold schema.
 * Uses raw SQL for DDL because drizzle's type-safe schema declarations don't
 * handle vector(384) and tsvector cleanly with the pglite adapter.
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

export type DbHandle = { pg: PGlite };

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS objects (
  id text PRIMARY KEY,
  kind text NOT NULL,
  type text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',
  author text NOT NULL DEFAULT '',
  method text NOT NULL DEFAULT '',
  approval text NOT NULL DEFAULT 'admitted',
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
`;

/**
 * Format a number[] vector as the '[x,y,z,...]' literal PGlite's vector type expects.
 * Shared by indexer.ts and recall.ts to avoid duplication.
 */
export function fmtVec(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export async function openDb(pgDir: string): Promise<DbHandle> {
  const pg = new PGlite(pgDir, { extensions: { vector } });
  await pg.waitReady;
  await pg.exec(SCHEMA_SQL);
  return { pg };
}
