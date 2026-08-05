# M4 Foundation Fix Report — 2026-08-05

## Test result

207 passed, 1 skipped (24 test files). Original baseline: 205 passed. Net addition: 2 new tests.

---

## Fix 1+2: Remove trailing graphId params; derive from fh.graphId inside

**Files:** `packages/core/src/recall.ts`, `packages/core/src/graphview.ts`, `packages/core/src/indexer.ts`

Removed `graphId: string = DEFAULT_GRAPH_ID` as the last parameter from `recall()`, `recentMemories()`, `memoryIndex()`, `memoryGraph()`, internal `indexRows()`, and `reindex()`. Each function now opens with `const graphId = freehold.graphId;` instead.

Removed now-unused `DEFAULT_GRAPH_ID` imports from `recall.ts`, `graphview.ts`, and `indexer.ts`.

**Call sites updated:**
- `packages/api/src/routes/retrieval.ts`: dropped explicit `fh.graphId` arg from all four calls
- `packages/api/src/routes/governance.ts`: dropped explicit `fh.graphId` from `reindex()` call
- `packages/core/tests/index.test.ts`: dropped explicit graphId args from `recall()` (×2) and `reindex()` (×1) in isolation tests

**Key implementation note:** The `@freehold/core` package resolves to `dist/` via package.json exports. After changing sources, `pnpm --filter @freehold/core build` was required so that API tests importing from `@freehold/core` pick up the new signatures. Without rebuilding, the old dist had `graphId = DEFAULT_GRAPH_ID` as a default parameter, causing isolation tests to break when retrieval.ts stopped passing the explicit `fh.graphId` arg.

---

## Fix 3: changesetDirFor wrong for repo graphs

**File:** `packages/api/src/routes/retrieval.ts`

Changed the `getEntity` call in the `/entities/:id` handler from:
```ts
changesetDir: changesetDirFor(fh.home, fh.graphName),
```
to:
```ts
changesetDir: join(fh.graphDir, ".allod", "changesets"),
```

`fh.graphDir` is the allod graph root for both memory and repo graphs. The old `changesetDirFor(home, graphName)` constructed `{home}/graphs/{graphName}/.allod/changesets`, which is wrong for repo graphs (where `graphDir` is the checkout root, not `{home}/graphs/{name}`).

Added `import { join } from "node:path"` to retrieval.ts and removed the `changesetDirFor` import from `@freehold/core`.

---

## Fix 4: manager.ts registerRepo — duplicate-id check before side effects

**File:** `packages/core/src/manager.ts`

Reordered `registerRepo()` so the registry duplicate check happens before any side effects:

1. Validate `.allod/graph.yaml` exists (unchanged)
2. Compute id/name/embedder
3. **NEW: SELECT check — throw immediately if id already registered**
4. Open the graph (openFreehold)
5. Install review ontology
6. Read metadata (allodGraphId, originRemote)
7. INSERT (removed `ON CONFLICT DO NOTHING` since we already checked)
8. Cache and index

The original code opened the graph and installed the ontology before the duplicate check, meaning a race could install the review ontology in a second repo before the insert failed. The reordered check throws before any file system changes on the new repo.

---

## Fix 5: manager.ts get() vs remove() race

**File:** `packages/core/src/manager.ts`

Added a re-verification check inside `get()` after `await promise` resolves. If a concurrent `remove()` deleted the id from `inFlight` while `_open()` was awaited, the check `!this.inFlight.has(id)` is true and the function throws rather than caching a resurrected entry:

```typescript
if (!this.inFlight.has(id)) {
  throw new Error(`Graph not registered: ${id} (removed during open)`);
}
```

This is safe in the normal (no-remove) path: `inFlight.has(id)` is true when the check runs because the `finally { inFlight.delete(id) }` has not yet executed.

---

## Fix 6: openapi.ts missing /graphs routes + regenerate types

**File:** `packages/api/src/openapi.ts`

Added three new Zod schemas:
- `GraphInfo` — shape of a registered graph entry (id, name, path, kind, autoPushNotes, embedder, allodGraphId, originRemote)
- `RegisterGraphBody` — POST /graphs request body (path required, id/name optional)
- `UpdateGraphBody` — PATCH /graphs/{id} request body (name/autoPushNotes/embedder all optional)

Registered all three schemas as OpenAPI components in `buildRegistry()`.

Added four route registrations:
- `GET /api/v1/graphs` — list all graphs
- `POST /api/v1/graphs` — register a repo graph (201 Created)
- `PATCH /api/v1/graphs/{id}` — update graph settings (200)
- `DELETE /api/v1/graphs/{id}` — remove a graph (204/404/409)

Ran `pnpm --filter @freehold/api openapi` to regenerate `packages/api/openapi.json`.

Ran `pnpm --filter @freehold/client generate` to regenerate `packages/client/src/types.ts`.

---

## New tests added

### MCP recall with graph param (packages/api/tests/mcp.test.ts)

Added test `"recall with graph: 'main' returns results array"` inside the existing `describe("recall")` block. Writes a note via `remember`, waits 300ms, calls `recall` with `{ query: "test", graph: "main" }`, asserts `body.results` is an array.

### Manager duplicate-id guard fires before side effects (packages/core/tests/manager.test.ts)

Added test `"registerRepo() duplicate-id check fires before side effects — review ontology not installed in new repo"`:
1. Creates manager + registers repo1 with id `"collision-test"`
2. Creates a valid allod graph at fresh temp dir (repo2)
3. Counts changesets in repo2 before the failed registration
4. Calls `manager.registerRepo(repo2, { id: "collision-test" })` and expects it to throw `"graph id already registered"`
5. Asserts changeset count is unchanged (review ontology was not installed in repo2)

The test checks changeset count rather than directory emptiness because `createGraph` (called by `makeRepoGraph`) already creates initial changesets — the guard being tested prevents the ontology-install changesets from being added.
