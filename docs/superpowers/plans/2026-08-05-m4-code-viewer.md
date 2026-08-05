# M4 Code Viewer Implementation Plan (sub-project 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Code area for repo graphs: file tree with classification chips, file/item pages with blast radius and manual classification, a neighborhood graph tab, and a governed-paths panel showing what review each path costs.

**Architecture:** A `codeview.ts` module in packages/core answers tree/file/item queries from the PGlite index (objects/graph_edges/node_terms are already graph-scoped) — no wasm lock needed for structure. The governed-paths computation (`code/regions`) goes through wasm `git_checklist` per file path (policy logic stays in wasm), cached against the graph head. Four API routes under the existing scoped mount; the web Code area reuses the Memory workspace's two-pane pattern and React Flow machinery.

**Tech Stack:** TypeScript, PGlite, Hono, @allod/core wasm (git_checklist), React + React Flow, vitest.

Spec: `docs/specs/2026-08-04-governed-review-surface-design.md` (sub-project 2 section).

## Global Constraints

- No policy logic in TypeScript: region membership comes ONLY from wasm `git_checklist` (ops `[["M", path]]` per file; a rule with a `region:` or path selector matching means the path is governed by it). No reimplementation of glob or reach in TS.
- All wasm access through `withGraph`. PGlite reads need no lock.
- Code routes exist only for repo graphs: memory graphs get 400 `{ error: "code view is only available for repo graphs" }`.
- Classification from the UI uses the EXISTING `POST /classifications` route (scoped), basis fixed `manual`; outcomes render in saved/pending vocabulary. No new classification backend.
- Whole-graph rendering is a non-goal: the graph tab scopes to the selected file's neighborhood.
- Not-yet-indexed honesty: a path in the git checkout with no SourceFile node renders as not-yet-indexed with `allod git index` guidance — never silently reachless (spec sub-project 3 language, applies to the file page here).
- Node types in the index: `code/SourceFile@1` (attributes include `path`, `language`), `code/Function@1` / `code/Type@1` (signature, span), edges `code/declares@1`, `code/calls@1`, `code/in_repo@1`. Verify exact attribute names from the objects table content of an indexed graph (the allod repo's committed `.allod` graph is ground truth) before hardcoding.
- Suite: root `pnpm test`; web build must pass.

---

### Task 1: codeview.ts core module

**Files:**
- Create: `packages/core/src/codeview.ts`, export from index.ts
- Create: `packages/core/tests/codeview.test.ts`

**Interfaces:**

```ts
export interface CodeTreeNode { name: string; path: string; kind: "dir" | "file"; language?: string; terms: string[]; children?: CodeTreeNode[] }
export async function codeTree(fh: Freehold): Promise<CodeTreeNode[]>;
// from objects WHERE graph_id AND type LIKE 'code/SourceFile%': build nested dirs from paths;
// file terms from node_terms; dir terms = union of descendants.

export interface CodeItem { nodeId: string; type: string; name: string; signature?: string; span?: string; terms: string[] }
export interface CodeFileView {
  path: string; language?: string; nodeId: string; blobRef?: string;
  terms: string[]; items: CodeItem[];
}
export async function codeFile(fh: Freehold, path: string): Promise<CodeFileView | null>;
// null → caller renders not-yet-indexed. items via declares edges from the file node.

export interface CodeItemView extends CodeItem {
  filePath?: string;
  callersIn: CodeItem[];  // calls edges pointing at this node
  callsOut: CodeItem[];   // calls edges from this node
}
export async function codeItem(fh: Freehold, nodeId: string): Promise<CodeItemView | null>;

export interface CodeNeighborhood { nodes: Array<{ id: string; label: string; type: string; terms: string[] }>; edges: Array<{ id: string; from: string; to: string; type: string }> }
export async function codeNeighborhood(fh: Freehold, path: string): Promise<CodeNeighborhood>;
// the file node + its declared items + one hop of calls edges in/out.

export interface RegionRule { rule: string; region?: string; reviewers: unknown; paths: string[] }
export async function codeRegions(fh: Freehold): Promise<RegionRule[]>;
// for each SourceFile path: withGraph(fh.graph, () => fh.graph.git_checklist(repo, "refs/heads/main", [["M", path]]))
// → matched rules; group paths by rule. Cache per (fh.graphId, head) — head via the wasm log/state
// (find the cheapest head accessor already used by the indexer cursor logic). repo name: derive from
// the policy's rule selectors if they bind repo, else the graph entry's basename — inspect how the
// allod governance policy names the repo ("allod") and store repoName on the GraphEntry if needed;
// simplest correct: accept a repo name argument resolved by the API layer from the graph entry.
```

Test fixture: build a registered-style graph in a temp dir (reuse the manager test fixture) and create code nodes/edges via ops (the SP1 Task-3 SP3-guard test shows the exact create+approve pattern): two SourceFiles in nested dirs, two Functions declared by one file, a calls edge between the Functions, a classification term on one Function, and a policy containing one path rule + one region rule (the SP1 wasm region test in allod shows the YAML shape). Tests: tree nesting + term rollup; codeFile items + null for unknown path; codeItem callers/calls; neighborhood contents; codeRegions groups the classified path under the region rule and the path-rule paths match the glob — asserting counts and membership, not snapshot blobs.

- [ ] Steps: failing tests → implement → suite green → commit `feat(core): codeview — tree/file/item/neighborhood/regions over the scoped index + wasm checklist`.

---

### Task 2: code API routes

**Files:**
- Create: `packages/api/src/routes/code.ts`; mount in app.ts's buildApiRoutes
- Modify: `packages/api/src/openapi.ts` (+ regenerate openapi.json and client types per the generate.ts workflow)
- Modify: `packages/client/src/client.ts` (codeTree/codeFile/codeItem/codeRegions methods, graph-scoped)
- Create: `packages/api/tests/code.test.ts`

**Routes (all under the scoped mount; unscoped alias serves the default graph which is memory → 400):**
- `GET /code/tree` → `{ tree: CodeTreeNode[] }`
- `GET /code/file?path=` → `CodeFileView` or 404 `{ error: "not indexed", hint: "run: allod git index" }`
- `GET /code/item/:nodeId` → `CodeItemView` or 404
- `GET /code/regions` → `{ rules: RegionRule[] }`
- Every route: `if (fh.kind !== "repo") return c.json({ error: "code view is only available for repo graphs" }, 400)`.

Tests via app.request(): 400 on memory graph; tree/file/item/regions round-trip on a registered fixture graph (reuse Task 1's fixture through the API); 404 hint shape for unknown path.

- [ ] Steps: failing tests → implement → openapi regen → suite green → commit `feat(api): code viewer routes for repo graphs`.

---

### Task 3: web Code area

**Files:**
- Create: `packages/web/src/routes/code.tsx` (+ child routes per the router's file conventions: `code.$` splat or `code.file`/`code.item` — follow how memory.$id is structured), regenerate routeTree per the repo's workflow
- Modify: `packages/web/src/components/AppShell.tsx` (Code nav item, repo graphs only, icon `Code` from the icon set in use)
- Create/modify tests per the web test conventions (route tests exist for other areas — mirror one)

**Behavior:**
- Two-pane like Memory: left = tree (directories collapsible, language + classification chips using the existing chip components), right = file page (path, language, blob link when `originRemote` is a GitHub URL — `https://github.com/<org>/<repo>/blob/<default branch>/<path>`; omit the link otherwise), declared items with signature/span/chips, expandable blast radius (callersIn/callsOut lists linking to item pages).
- Classify on files and items: reuse the existing classification picker/flow from the Memory workspace (basis `manual` fixed), outcome shown in saved/pending vocabulary; a pending classification links to the Inbox.
- Graph tab: React Flow with the existing machinery, fed by `codeNeighborhood` for the selected file; default scoped to that neighborhood.
- Governed-paths panel: a panel (tab or section in the tree pane footer) listing each rule from `code/regions` with its reviewers and the paths in reach; clicking a path opens its file page.
- Not-yet-indexed: file page for a 404 path renders the hint verbatim: guidance text includes `allod git index`.

Tests: nav gating (Code visible only for repo graphs — extend the existing AppShell tests); tree renders fixture data; file page shows items + classify affordance; regions panel renders rules (mock client).

- [ ] Steps: client/API mocks + failing route tests → implement → web build green → root suite green → commit `feat(web): Code area — tree, file/item pages, neighborhood graph, governed paths`.

---

### Task 4: smoke + spec status

- [ ] Register a scratch fixture repo graph against a temp-home daemon (SP1 Task-7 pattern), curl the four code endpoints, record the transcript in the report; assert the memory graph 400s.
- [ ] Spec: mark sub-project 2 shipped + deviations.
- [ ] Full suite + web build green. Commit `docs: M4 sub-project 2 shipped`.

## Self-review notes

- Spec coverage: tree pane w/ rollup (T1/T3), file page incl. blob link + blast radius + classify (T1/T3), graph tab neighborhood-scoped (T1/T3), governed-paths panel + code/regions (T1/T2/T3), four endpoints under /graphs/:id (T2), per-graph lock only where wasm is touched (T1 regions), not-yet-indexed honesty (T2/T3).
- codeRegions repo-name resolution is delegated to the API layer from the GraphEntry — T2 passes it; T1's signature takes it as an argument if needed (implementer aligns the two; both tasks name the same function).
