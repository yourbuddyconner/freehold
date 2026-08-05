/**
 * @freehold/core — Semantic recall
 *
 * Hybrid search combining vector similarity (pgvector cosine distance) and
 * full-text search, fused via Reciprocal Rank Fusion (RRF, k=60).
 */

import { fmtVec } from "./db.js";
import type { Embedder } from "./embed.js";
import type { Freehold } from "./graphs.js";

export interface RecallResult {
  id: string;
  type: string;
  content: unknown;
  author: string;
  method: string | null;
  approval: string;
  changeset: string;
  score: number;
}

export interface RecallFilters {
  type?: string;
  author?: string;
  approval?: string;
}

interface ObjectRow {
  id: string;
  type: string;
  content: unknown;
  author: string;
  method: string | null;
  approval: string;
  changeset: string;
}

const RRF_K = 60;

/**
 * Hybrid semantic recall over the PGlite index.
 *
 * 1. Embed the query with the provided embedder.
 * 2. Run vector search (cosine distance, top-60) and FTS (top-60) independently.
 * 3. Fuse rankings with RRF (k=60): score = 1/(RRF_K + vec_rank) + 1/(RRF_K + fts_rank).
 *    Results absent from one list get rank=RRF_K (same numeric value as k), giving a
 *    minimum contribution of 1/(60+60) = 1/120.
 * 4. Fetch up to 120 top-scored candidates from the objects table, then apply optional
 *    filters (type / author / approval). Note: when filters are active the returned
 *    slice may contain fewer than `limit` entries — the pre-filter candidate window is
 *    fixed at 120 and is not extended to compensate for filter shrinkage.
 * 5. Return the top `limit` results with full provenance metadata.
 */
export async function recall(
  freehold: Freehold,
  query: string,
  embedder: Embedder,
  filters?: RecallFilters,
  limit = 10
): Promise<RecallResult[]> {
  const { pg } = freehold.db;
  const graphId = freehold.graphId;

  // Step 1: embed the query
  const [qvec] = await embedder.embed([query]);

  // Step 2a: vector search — returns object_ids ordered by cosine distance,
  // scoped to the graph via a join on objects.
  const vecResult = await pg.query<{ object_id: string }>(
    `SELECT e.object_id FROM embeddings e
     JOIN objects o ON o.id = e.object_id
     WHERE o.graph_id = $2
     ORDER BY e.vec <=> $1::vector LIMIT 60`,
    [fmtVec(qvec), graphId]
  );
  const vecRanks = new Map<string, number>(); // id → 0-based rank
  vecResult.rows.forEach((row, i) => vecRanks.set(row.object_id, i));

  // Step 2b: FTS search, scoped to the graph
  const ftsResult = await pg.query<{ id: string }>(
    `SELECT id FROM objects
     WHERE graph_id = $2
       AND to_tsvector('english', search_text) @@ plainto_tsquery('english', $1)
     ORDER BY ts_rank(to_tsvector('english', search_text), plainto_tsquery('english', $1)) DESC
     LIMIT 60`,
    [query, graphId]
  );
  const ftsRanks = new Map<string, number>(); // id → 0-based rank
  ftsResult.rows.forEach((row, i) => ftsRanks.set(row.id, i));

  // Collect all candidate IDs
  const allIds = new Set<string>([...vecRanks.keys(), ...ftsRanks.keys()]);

  // Step 4: apply filters — fetch candidate rows to filter on metadata
  if (allIds.size === 0) return [];

  // Build a filtered candidate list using RRF scores, then fetch rows.
  // notFound=60 means "absent from this list gets the worst position still within the
  // top-60 window" → contribution 1/(RRF_K + 60) = 1/120. Same value as RRF_K by design:
  // any absent result scores no better than the last result in either ranked list.
  const notFound = 60;

  // Score each candidate with RRF
  const scored: Array<{ id: string; score: number }> = [];
  for (const id of allIds) {
    const vr = vecRanks.get(id) ?? notFound;
    const fr = ftsRanks.get(id) ?? notFound;
    const score = 1 / (RRF_K + vr) + 1 / (RRF_K + fr);
    scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // Step 6: fetch full rows (batch), then apply filters and take limit
  // Fetch up to top 120 candidates before filtering (to handle filter shrinkage)
  const topCandidates = scored.slice(0, 120);
  const idList = topCandidates.map((c) => c.id);

  if (idList.length === 0) return [];

  // Build parameterized IN query (graph_id constraint is redundant here since
  // candidates already came from graph-scoped searches, but kept for correctness)
  const placeholders = idList.map((_, i) => `$${i + 1}`).join(",");
  const rowsResult = await pg.query<ObjectRow>(
    `SELECT id, type, content, author, method, approval, changeset FROM objects WHERE id IN (${placeholders}) AND graph_id = $${idList.length + 1}`,
    [...idList, graphId]
  );

  const rowMap = new Map<string, ObjectRow>();
  for (const row of rowsResult.rows) {
    rowMap.set(row.id, row);
  }

  const results: RecallResult[] = [];
  for (const { id, score } of topCandidates) {
    const row = rowMap.get(id);
    if (!row) continue;

    // Apply filters
    if (filters?.type && row.type.split("@")[0] !== filters.type && row.type !== filters.type)
      continue;
    if (filters?.author && row.author !== filters.author) continue;
    if (filters?.approval && row.approval !== filters.approval) continue;

    results.push({
      id: row.id,
      type: row.type,
      content: row.content,
      author: row.author,
      method: row.method,
      approval: row.approval,
      changeset: row.changeset,
      score,
    });

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * List the most recently indexed memories, newest first, in the same shape
 * as recall results (score 0). Backs the Memory browser's no-query view.
 * Schema objects (meta/*) are excluded.
 */
export async function recentMemories(
  freehold: Freehold,
  filters?: RecallFilters,
  limit = 50
): Promise<RecallResult[]> {
  const { pg } = freehold.db;
  const graphId = freehold.graphId;
  const rowsResult = await pg.query<ObjectRow>(
    `SELECT id, type, content, author, method, approval, changeset FROM objects
     WHERE kind = 'node' AND type NOT LIKE 'meta/%' AND graph_id = $2
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit * 3, graphId]
  );

  const results: RecallResult[] = [];
  for (const row of rowsResult.rows) {
    if (filters?.type && row.type.split("@")[0] !== filters.type && row.type !== filters.type)
      continue;
    if (filters?.author && row.author !== filters.author) continue;
    if (filters?.approval && row.approval !== filters.approval) continue;

    results.push({
      id: row.id,
      type: row.type,
      content: row.content,
      author: row.author,
      method: row.method,
      approval: row.approval,
      changeset: row.changeset,
      score: 0,
    });

    if (results.length >= limit) break;
  }
  return results;
}
