# Task 2 Report: Graph-scoped PGlite index tables

**Status:** Complete  
**Commit:** e5a5d48  
**Test summary:** 148 passed, 1 skipped (real-embedder E2E gate, expected), 0 failed — all pre-existing tests green, 5 new dbscope tests pass

## What was done

### Schema changes (db.ts)

- `DEFAULT_GRAPH_ID = "main"` exported from db.ts
- `graph_id text NOT NULL DEFAULT 'main'` added to `objects`, `graph_edges`, `node_terms`, `meta` via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (idempotent; existing rows get `'main'`)
- `objects_graph_idx` and `graph_edges_graph_idx` indexes created with `IF NOT EXISTS`
- `node_terms` PK recreated as `(graph_id, subject_id, term)` — old `(subject_id, term)` dropped first via guarded `DO $$ BEGIN … EXCEPTION WHEN OTHERS THEN NULL END $$` block
- `meta` PK recreated as `(graph_id, key)` — same guarded pattern
- `meta` table DDL in SCHEMA_SQL changed from `key text PRIMARY KEY` to `key text NOT NULL` so fresh DBs land with no single-column PK, then the migration block adds the composite PK

### New helpers exported from db.ts

`upsertObject(graphId, pg, params)`, `listObjects(graphId, pg)`, `getIndexedHead(graphId, pg)`, `setIndexedHead(graphId, pg, head)`, `deleteIndexedHead(graphId, pg)`, `upsertEdge(graphId, pg, params)`, `upsertNodeTerm(graphId, pg, params)`

### Call-site threading

- `indexer.ts` (`syncIndex`, `reindex`): replaced all raw `pg.query` calls on graph-scoped tables with the new helpers; `graphId = DEFAULT_GRAPH_ID` at call sites
- `recall.ts` (`recall`, `recentMemories`): added `graphId: string = DEFAULT_GRAPH_ID` trailing parameter; vector search JOINs through `objects` to filter by `graph_id`; FTS and row-fetch queries also filter by `graph_id`
- `graphview.ts` (`indexRows`, `memoryIndex`, `memoryGraph`): all queries filter by `graph_id = DEFAULT_GRAPH_ID`

### Tests (packages/core/tests/dbscope.test.ts)

5 tests using `openDb`, `upsertObject`, `listObjects`, `getIndexedHead`, `setIndexedHead`:
1. `DEFAULT_GRAPH_ID is 'main'` — constant check
2. `rows written under graph A are invisible to graph B queries` — cross-graph isolation
3. `meta indexed_head is per graph` — independent cursors for two graphs
4. `DEFAULT_GRAPH_ID rows are visible under 'main'` — default-graph round-trip
5. `getIndexedHead returns 0 when no head is set for a graph` — zero-default behavior

## Concerns

None. The `objects.id` PK remains a single-column global-unique PK as required (UUID collision across graphs not a practical concern; avoids FK cascade changes in `embeddings`). All existing tests pass unmodified.

---

## Review fix-up (2026-08-05)

Four open findings from Task 2 code review resolved:

### 1. Critical — reindex is now graph-scoped (indexer.ts)

`TRUNCATE TABLE objects CASCADE` / `TRUNCATE TABLE graph_edges` / `TRUNCATE TABLE node_terms` replaced with graph-scoped `DELETE FROM <table> WHERE graph_id = $1`. The `reindex` signature gains an optional `graphId: string = DEFAULT_GRAPH_ID` parameter. The `objects → embeddings` FK has `ON DELETE CASCADE` so the embedded vector rows are cleaned up automatically without a separate delete. The `deleteIndexedHead` call was already graph-scoped; updated to pass the explicit `graphId` argument rather than the constant.

### 2. Important — memoryIndex and memoryGraph thread graphId (graphview.ts)

Both public functions now accept a trailing `graphId: string = DEFAULT_GRAPH_ID` parameter (matching the existing `recall` / `recentMemories` convention). The parameter is forwarded to `indexRows` and to every `WHERE graph_id = $1` query inside both functions (terms queries, edge query). `DEFAULT_GRAPH_ID` remains in the import because it is used as the default value in `indexRows` and both public signatures.

### 3. Minor — upsertObject graph_id update-clause comment (db.ts)

Added a 5-line comment above the `graph_id = EXCLUDED.graph_id` line in the `ON CONFLICT DO UPDATE` clause explaining: within a single PGlite instance object ids are expected globally unique, so a UUID collision means the same object is being re-indexed under a new graph; drop `graph_id` from the update clause if cross-graph UUID stability is ever required.

### 4. Minor — afterEach cleanup + reindex isolation test (dbscope.test.ts)

- Added `rmSync(tmpDir, { recursive: true, force: true })` in `afterEach` so each test's PGlite directory is removed after the test completes.
- Added a 6th test: `"graph-scoped delete (reindex path) leaves graph B rows intact"` — inserts rows under graphs "a" and "b", executes `DELETE FROM objects WHERE graph_id = 'a'` (the exact query used by `reindex`), then asserts graph "a" is empty and graph "b" has its row.

**Test result:** 149 passed, 1 skipped, 0 failed (20 test files, all green).
