# Memory Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the console's Memory area as a two-pane workspace: ontology-derived tree, Markdown item pages with edit→diff→sign, Pierre diffs everywhere, and a force-directed graph tab.

**Architecture:** Core gains a flat memory index (nodes + titles + terms) and a graph export (nodes + fold-state edges). The API exposes both plus an owner PATCH backed by the existing `updateEntity`. The web package replaces the memory routes with a layout route (tree pane + outlet), item pages that render Markdown/properties, a Pierre-editor edit flow ending in a FileDiff commit step, and a React Flow graph.

**Tech Stack:** Hono, PGlite, allod-wasm (via withGraph lock), TanStack Router/Query, Tailwind v4, `@pierre/diffs` ^1.3.2, `@xyflow/react` ^12, `d3-force` ^3, `react-markdown` ^9, `remark-gfm` ^4, vitest + testing-library.

Spec: `docs/specs/2026-08-04-memory-workspace-design.md`.

## Global Constraints

- Status vocabulary: `saved`/`pending` (write status), `approved`/`rejected`/`incomplete` (decide). Index approval column values: `saved`, `pending`, `rejected`.
- Tailwind v4 CSS-var utilities use parens: `text-(--fg)`, never `bg-[--var]`.
- All graph access goes through `withGraph` (re-entrancy lock). Never call graph methods outside a critical section in core.
- Every new API route registers in `openapi.ts`; regenerate `openapi.json` + client types; the drift check (`pnpm --dir packages/client run check-drift` or equivalent test) must pass.
- Meta types (`meta/%`) never appear in listings, trees, or graphs.
- Docs/UI copy: plain declarative prose. No "not an error" reassurance register, no coined framing.
- Pin `@pierre/diffs` exact version (no `^`) in package.json.
- The daemon caches `index.html` at boot — console rebuilds need a daemon restart to show.
- Run `pnpm -r build` before cross-package tests; stale dists mask breakage.
- The registered agent principal in the live graph is `claude`; the owner principal name comes from config (`fh.config.owner` — verify exact field at Task 4).

---

### Task 1: Core — memory index listing and graph export

**Files:**
- Modify: `packages/core/src/recall.ts` (add `memoryIndex`)
- Create: `packages/core/src/graphview.ts` (add `memoryGraph`)
- Modify: `packages/core/src/index.ts` (export both)
- Test: `packages/core/tests/` (follow existing test file layout; add cases to the suite that already exercises `recentMemories`)

**Interfaces (produces):**

```ts
export interface MemoryIndexEntry {
  id: string;
  type: string;
  title: string;          // attributes.title ?? name ?? statement ?? first line of content ?? id
  approval: string;       // 'saved' | 'pending' | 'rejected'
  author: string;
  updatedAt: string;      // ISO from objects.updated_at
  terms: string[];        // taxonomy terms from entity_context classifications
}
export async function memoryIndex(fh: Freehold, cap = 5000): Promise<MemoryIndexEntry[]>

export interface GraphNode { id: string; type: string; title: string; approval: string }
export interface GraphEdge { id: string; type: string; from: string; to: string } // bare UUIDs
export async function memoryGraph(fh: Freehold, nodeCap = 2000):
  Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>
```

**Steps:**
- [ ] `memoryIndex`: SQL over `objects` (`kind = 'node' AND type NOT LIKE 'meta/%' ORDER BY updated_at DESC LIMIT $cap`), derive `title` in TS from content jsonb; then one `withGraph` section calling `entity_context(id)` per saved node for `terms` (pending/rejected nodes get `terms: []` — they are not in fold state).
- [ ] `memoryGraph`: nodes from the same SQL (id, type, title, approval, capped at `nodeCap`, `truncated` flag when the count hits the cap); edges from one `withGraph` section: for each *saved* node, `entity_context(id).edges_out` → `{ id, type, from: nodeId, to: bareId(to) }`; drop edges whose `to` is not in the node set.
- [ ] Tests: seed via existing test helpers (create entities + relate), assert title fallback order, terms present on classified nodes, edges present exactly once (no dupes from edges_in), meta nodes excluded, pending node appears in index with empty terms.
- [ ] Commit.

### Task 2: API — `scope=all`, `GET /graph`, OpenAPI + client

**Files:**
- Modify: `packages/api/src/routes/retrieval.ts` (memories route gains `scope=all` branch; new `/graph` route)
- Modify: `packages/api/src/openapi.ts` (+ regenerate `openapi.json`, client types)
- Modify: `packages/client/src/client.ts` (add `memoryIndex()`, `graph()`)
- Test: `packages/api/tests/api.test.ts`

**Steps:**
- [ ] `GET /memories?scope=all` → `{ results: MemoryIndexEntry[] }` via `memoryIndex`; without `scope` the route behaves exactly as today (existing tests must not change).
- [ ] `GET /graph` → `{ nodes, edges, truncated }` via `memoryGraph`.
- [ ] Register both in openapi.ts; regenerate; drift check green.
- [ ] API tests: scope=all returns seeded note with derived title + terms; /graph returns the relate()d edge once.
- [ ] Commit.

### Task 3: Web — deps, hooks, tree builder

**Files:**
- Modify: `packages/web/package.json` (add `@pierre/diffs` (exact pin), `@xyflow/react`, `d3-force`, `react-markdown`, `remark-gfm`, `@types/d3-force`)
- Modify: `packages/web/src/lib/hooks.ts` (add `useMemoryIndex()`, `useMemoryGraph()`, `useUpdateMemory()` placeholder comes in Task 6)
- Create: `packages/web/src/lib/memoryTree.ts`
- Test: `packages/web/src/lib/memoryTree.test.ts`

**Interfaces (produces):**

```ts
export interface TreeFolder { kind: "folder"; label: string; typePrefix: string; children: TreeNode[]; count: number }
export interface TreeLeaf { kind: "leaf"; entry: MemoryIndexEntry }
export type TreeNode = TreeFolder | TreeLeaf;
export function buildMemoryTree(entries: MemoryIndexEntry[]): TreeFolder[]
export function displayTypeName(typeRef: string): string // "memory/Note@1" → "Notes"; unknown → capitalized bare name
```

**Steps:**
- [ ] `buildMemoryTree`: group by root type ref (strip version, split path); folder labels via a display-name map (`Note→Notes`, `Person/Colleague→People`, `Document→Documents`, `Event→Events`, `Preference→Preferences`, fallback: capitalize + pluralize with "s"); sub-folders only where type refs nest (`memory/Person/Colleague@1` under People); leaves sorted `updatedAt` desc; folders sorted alphabetically.
- [ ] Unit tests: grouping, label mapping, sort order, pending leaf retains approval field, empty input → [].
- [ ] `pnpm install`, hooks wired to new client methods.
- [ ] Commit.

### Task 4: Workspace layout + tree pane

**Files:**
- Modify: `packages/web/src/routes/memory.tsx` (becomes the two-pane layout: left pane always mounted — search box, Files/Graph tabs, `MemoryTree` or search results; right pane `<Outlet/>` with resting state at exact `/memory`)
- Create: `packages/web/src/components/MemoryTree.tsx` (folders with open-state in localStorage key `freehold:memory-tree-open`, leaves are `<Link to="/memory/$id">`, pending marker via existing `StatusChip`/pending treatment, count badges)
- Modify: `packages/web/src/routes/memory.test.tsx` (rewrite for the new layout; keep author-filter coverage only where search results remain)
- Delete usage: card-list body, filter-chip row, `TaxonomyTree` from this page (component stays if schema page uses it; check `grep -rn TaxonomyTree packages/web/src`).

**Steps:**
- [ ] Layout with left pane fixed width (~ w-72), search input; typing a query swaps tree → recall results (existing `useRecall` + `MemoryCard` list); clearing restores tree.
- [ ] Tabs: Files (link `/memory`), Graph (link `/memory/graph`, route lands in Task 8; tab renders now and 404s until then is NOT acceptable — add the route file in this task with a "Graph loads in a later task" placeholder? No: instead add the tab in Task 8 with the route. In this task render only Files.)
- [ ] Tests: tree renders folders from mocked `useMemoryIndex`, leaf navigates, search swaps panes, pending marker visible.
- [ ] Commit.

### Task 5: Item pages — content, properties, connections, history

**Files:**
- Modify: `packages/web/src/routes/memory.$id.tsx`
- Create: `packages/web/src/components/MarkdownView.tsx` (react-markdown + remark-gfm + prose classes)
- Create: `packages/web/src/components/ConnectionsPanel.tsx`
- Modify: `packages/web/src/routes/memory.$id.test.tsx`

**Steps:**
- [ ] Content layer: if `attributes.content` or `attributes.statement` is a string → `MarkdownView`; else properties table (existing attribute table, restyled as labeled fields). Title = same fallback chain as server. Taxonomy chips under title.
- [ ] `ConnectionsPanel`: rows from `entity.edges`, peer title resolved from `useMemoryIndex` map (id→title), fallback to short id; arrow direction per edge; each row links to the peer.
- [ ] History section: existing `revisions` list; each step expandable — diff rendering upgraded in Task 7 (render content placeholder-free now: show hash + author line, expansion added when PierreDiff exists — acceptable because current LineageTrail already renders hashes only).
- [ ] Tests: markdown renders (assert heading text from `# Hi`), entity without content shows properties, connections show peer titles.
- [ ] Commit.

### Task 6: Owner PATCH — API + client + mutation hook

**Files:**
- Modify: `packages/api/src/routes/knowledge.ts` (PATCH `/memories/:id`)
- Modify: `packages/api/src/openapi.ts` + regenerate; `packages/client/src/client.ts` (`updateMemory(id, { attributes, prior? })`)
- Modify: `packages/web/src/lib/hooks.ts` (`useUpdateMemory(id)` — `useMutation`, invalidates `["entity", id]`, `["memory-index"]`, `["recent-memories"]`)
- Test: `packages/api/tests/api.test.ts`

**Steps:**
- [ ] Route body `{ attributes: Record<string, unknown>, prior?: string }`; principal = authenticated session's principal (owner token → owner name; agent token → agent name — reuse however existing write routes resolve the author); calls core `updateEntity(fh.graph, principal, id, typeRef, attributes, prior)`; typeRef fetched via `getEntity` inside the handler; 404 if node missing.
- [ ] Response `{ status: "saved" | "pending", changeset: string }`. On prior mismatch the wasm commit throws — map that error to 409 `{ code: "conflict" }`.
- [ ] Tests: owner PATCH lands saved and content changes; stale `prior` → 409; agent-authored PATCH lands pending.
- [ ] Commit.

### Task 7: Edit → diff → commit flow + Pierre diff unification

**Files:**
- Create: `packages/web/src/components/PierreDiff.tsx` (wrapper: props `{ oldText, newText, language, layout? }` → `FileDiff` from `@pierre/diffs/react`; single place that touches the library)
- Create: `packages/web/src/components/DocEditor.tsx` (EditProvider + editable `CodeView`/`File` over markdown source, preview pane via `MarkdownView`, props `{ initial, onSave(next), onCancel }`)
- Create: `packages/web/src/components/CommitStep.tsx` (props `{ oldText, newText, onCommit, onKeepEditing, pendingNotice? }` — renders PierreDiff + actions)
- Modify: `packages/web/src/routes/memory.$id.tsx` (Edit button → DocEditor → CommitStep → `useUpdateMemory`; 409 → refetch entity, re-diff against new base, keep edits; `status: "pending"` result → "This change is pending review" + Inbox link. History steps expand into PierreDiff. Entity property editing: fields → serialized JSON diff → same CommitStep.)
- Modify: `packages/web/src/routes/inbox.tsx` / `packages/web/src/components/ProposalCard.tsx` (swap `DiffView` → `PierreDiff`)
- Delete: `packages/web/src/components/DiffView.tsx`
- Tests: `memory.$id.test.tsx` (edit→save→commit calls mutation with new attributes; conflict path re-diffs), inbox test still green. Mock `@pierre/diffs/react` at module level in vitest setup (jsdom lacks canvas/workers): mock exports `FileDiff`, `CodeView`, `File`, `EditProvider` as prop-echoing stubs; assert the wrapper receives `{ oldText, newText }`.

**Steps:** wire, test, commit (split into 2–3 commits: PierreDiff+inbox swap; DocEditor+CommitStep; item-page wiring).

### Task 8: Graph tab

**Files:**
- Create: `packages/web/src/lib/graphLayout.ts` — `layoutGraph(nodes, edges, opts): PositionedNode[]` running d3-force synchronously (fixed 200 ticks, seeded initial positions derived from node id hash — no `Math.random` in layout), degree-scaled radius `min(26, 9 + 3.4 * sqrt(inDegree))`, type-hub synthetic nodes optional.
- Create: `packages/web/src/routes/memory.graph.tsx` — React Flow canvas; nodes colored by root type (same palette as tree), pending nodes at reduced opacity with marker, click → navigate `/memory/$id`, hover title/type; edge type label on hover; hub toggle default on; truncation notice when `truncated`.
- Modify: `packages/web/src/routes/memory.tsx` (add Graph tab now that the route exists)
- Test: `packages/web/src/lib/graphLayout.test.ts` (determinism: same input → same positions; degree scaling; hubs added when enabled). Route test with `@xyflow/react` mocked.

**Steps:** implement, test, commit.

### Task 9: Ship it locally

- [ ] `pnpm -r build`; full test run (core, api, client drift, web); biome lint.
- [ ] Rebuild console, restart the daemon (detached: `(nohup pnpm --dir packages/api exec tsx src/cli/index.ts serve > /tmp/freehold-serve.log 2>&1 &)` after killing the old listener on 8710).
- [ ] Browser-verify against live data: tree shows People/Notes folders with real items; open a note → rendered markdown; edit → diff → commit → provenance shows new changeset; Inbox proposal renders Pierre diff; graph tab renders nodes and navigates.
- [ ] Commit + push to freehold main.

## Self-review notes

- Spec coverage: layout/tree (T3–4), item pages (T5), edit+sign+conflict (T6–7), diff unification incl. DiffView deletion (T7), graph global (T1–2, T8), local connections (T5), errors (T6 409 path, T8 truncation, T7 pending notice), testing strategy embedded per task, build order preserved.
- Deviation from spec: connections' peer titles resolve client-side from the memory index instead of a neighbors endpoint — the spec allowed skipping the endpoint if existing data serves the shape; `getEntity.edges` + index map does.
- Graph route lands in Task 8 with its tab (Task 4 renders Files only) to avoid a dead tab.
