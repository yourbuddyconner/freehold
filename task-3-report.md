# Task 3 Report

## Features Implemented

### Feature 1: Graph Tab (neighborhood route + UI)

**Backend:**
- Added `GET /code/neighborhood?path=` to `packages/api/src/routes/code.ts` wiring `codeNeighborhood(fh, path)` from `@freehold/core`
- Added `CodeNeighborhood` schema to `packages/api/openapi.json` (components/schemas + path entry)
- Regenerated `packages/client/src/types.ts` via `pnpm tsx generate.ts`
- Added `export type CodeNeighborhood` and `codeNeighborhood(path)` method to `packages/client/src/client.ts`
- Added `useCodeNeighborhood` hook to `packages/web/src/lib/hooks.ts`

**Frontend:**
- Created `packages/web/src/routes/code.graph.tsx` — React Flow canvas with `CodeNode` type (type chip + term chips); simple grid layout for small neighborhoods; empty state when no nodes; registered as child of Code route
- Added "Graph" tab link (`data-testid="graph-tab-link"`) to the file page header in `code.file.tsx`
- Updated `routeTree.gen.ts` to register `code.graph` route

### Feature 2: Classification from UI

- Added `useClassify()` mutation hook to `packages/web/src/lib/hooks.ts` — reads `sessionData.owner`, calls `apiClient.classify({ agent, nodeId, term, basis: "manual" })`
- Added inline `ClassifyPanel` component to `packages/web/src/routes/code.file.tsx` — term input + Apply button, shows "Saved." or "Pending — review in the Inbox." after submission
- Added inline `ClassifyPanel` to `packages/web/src/routes/code.item.tsx`

### Feature 3: GitHub Blob Link

- Added `useListGraphs()` hook to `packages/web/src/lib/hooks.ts` — fetches full `GraphInfo[]` including `originRemote`
- Added `useGitHubBlobUrl(filePath)` hook — parses HTTPS and SSH GitHub remote formats, returns `https://github.com/<org>/<repo>/blob/HEAD/<path>` or `null`
- Rendered conditional `<a data-testid="github-blob-link">View on GitHub →</a>` on the file page in `code.file.tsx`

## Tests Added

**API (`packages/api/tests/code.test.ts`):**
- 4 new tests for `GET /code/neighborhood`: 200 with nodes/edges for indexed path, 200 with empty arrays for unindexed path, 400 when path missing, 400 on memory graph

**Web (`packages/web/src/routes/code.test.tsx`):**
- 2 classify affordance tests: input and button render, heading visible
- 2 blob link tests: absent when null, present with correct href when URL provided
- 3 graph tab tests: Graph link renders on file page, graph page renders node labels, graph page shows empty state when no nodes

## Test Results

- `pnpm --filter @freehold/web exec tsc -b --force`: zero errors
- Web tests: 16 tests pass in code.test.tsx (143 total web tests pass)
- Root `pnpm test`: 26 test files pass, 249 tests pass (1 skipped)
