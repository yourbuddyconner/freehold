# Memory workspace design

Date: 2026-08-04
Status: approved for planning

## What this is

The console's Memory area becomes a workspace: a typed tree of everything in memory, a
graph of how items connect, and item pages where documents render as Markdown and can be
edited. Every edit ends in a signed changeset, and the user sees the diff before signing.
The reference for layout and feel is Valet v2's memory area; the difference is that
Freehold's items are typed nodes in a governed graph, not files on disk.

## Decisions already made

- The tree is derived from the ontology (the type hierarchy). Taxonomy terms are labels
  and filters on items, not folders.
- Owner edits show a diff preview first; committing the diff writes the signed changeset.
  Agent edits remain proposals through the existing pending flow.
- Linkages appear twice: a global force-directed graph tab, and a per-item connections
  panel.
- The document editor is `@pierre/diffs`' editor (source editing with highlighting) with
  a live rendered preview beside it. `@pierre/diffs` also replaces the hand-rolled
  `DiffView` everywhere, including Inbox proposals.

## Layout

`/memory` is a two-pane layout.

Left pane, always mounted:
- Search box. While a query is active, the pane shows ranked results (the existing
  recall search) instead of the tree.
- Tabs: **Files** and **Graph**. Files shows the tree; Graph routes the right pane to
  the global graph.
- The tree (see below).

Right pane, routed:
- `/memory` index: resting state (prompt to select an item, or the existing empty state
  when memory is empty).
- `/memory/$id`: item page.
- `/memory/graph`: global graph canvas.

The current card-list page and its filter-chip row are removed. Type and status filters
move into the tree and search pane. `TaxonomyTree` in its sidebar role is removed from
this page (the schema page keeps its own use if any).

## The tree

Client-derived from one flat listing, like Valet. No tree shape on the server.

Server: extend the existing listing route — `GET /api/v1/memories?scope=all` — to
return every non-meta node: `id`, `type`, `title`
(derived server-side: attributes.title, name, statement, or first line of content),
`approval`, `author`, `updated_at`, and taxonomy terms. No content bodies. Cap high
(e.g. 5000) rather than paging; a personal memory graph fits.

Client (`buildMemoryTree`, pure function):
- Top-level folders come from the root types of the ontology (People, Notes, Documents,
  Events, Preferences — display names mapped from type refs like `memory/Note@1`).
- Sub-folders follow the type hierarchy where the schema nests types; items are leaves.
- Items sort by updated time descending within a folder; folders sort alphabetically.
- Pending items appear in place with the existing pending marker. Status is visible in
  the tree, not a separate section.
- Open/closed state persists in localStorage. Small trees default open.
- Taxonomy terms render as small label chips on tree rows only where space allows;
  the full chips live on item pages.

## Item pages (`/memory/$id`)

Three layers, top to bottom:

1. **Content.**
   - Nodes whose attributes carry prose (`content` or `statement`): rendered Markdown
     via `react-markdown` + `remark-gfm`, styled with the console's prose styles.
   - Entities (people, things): a properties panel — each attribute as a labeled field.
   - Taxonomy term chips under the title.
2. **Connections.** Typed edges in both directions, each row a link to the other node:
   outgoing ("mentions → Sam Okafor") and incoming ("← authored-by this"). Data comes
   from a per-node neighbors call (core `traverse` already exists; expose it as
   `GET /api/v1/memories/:id/neighbors` if not already reachable).
3. **Provenance and history.** The existing `ProvenanceFooter`, plus a History section
   listing the node's changeset lineage (existing `LineageTrail` data). Each step
   expands into a Pierre `FileDiff` of the node's attributes/content at that step.

## Editing and signing

Read mode shows rendered content with an **Edit** button (owner session only).

Edit mode swaps the content layer for a split view:
- Left: Pierre editor (`CodeView`/`File` with `editorOptions` under an `EditProvider`)
  over the Markdown source. Highlighting, undo, find come from the library.
- Right: live rendered preview (same `react-markdown` pipeline), synchronized scroll.

**Save** opens the commit step: a Pierre `FileDiff` of stored content vs. edited
content, with two actions:
- **Commit** — calls the update API. The write path is core `updateEntity`, which reads
  `node_rev` and commits inside the same lock, so a concurrent write cannot interleave.
  The owner is the signing principal. On success, return to read mode showing the new
  content; the new changeset hash appears in provenance.
- **Keep editing** — back to the split view with edits intact.

If the node changed since the editor opened (the API reports a prior-hash mismatch or
the changeset lands pending unexpectedly), the commit step re-fetches the stored
content and re-renders the diff against the new base instead of surfacing a raw error.

Entity properties edit the same way: fields in edit mode, then a diff of the attribute
change (rendered as a text diff of the serialized attributes), then Commit.

API: add `PATCH /api/v1/memories/:id` (owner auth) with `{ attributes, prior? }`,
backed by `updateEntity`. The response carries `{ status, changeset }` like other
writes.

## Diff rendering everywhere

`@pierre/diffs` replaces the current `DiffView` component:
- the commit step above,
- History steps on item pages,
- Inbox proposal review (`ProposalCard` / inbox route).

One rendering engine (Shiki) for the editor and every diff, so an agent's proposed
change and the owner's own pending edit look identical. Use unified (stacked) layout by
default to fit the console's column widths; split view where width allows on the commit
step. Load Shiki grammars for markdown and json only.

## Global graph (`/memory/graph`)

Canvas: `@xyflow/react` (React Flow 12). Layout: `d3-force`, run synchronously for a
fixed tick count so the result is deterministic — no animation wander, and filter
toggles re-run layout without randomness (Valet's approach).

Data: new `GET /api/v1/graph` returning all non-meta nodes (id, type, title, approval)
and all edges (id, type, from, to). Server-side from the index; no stored layout.

Rendering:
- Node size scales with degree (incoming + outgoing edge count).
- Node color by root type, matching the tree's type grouping.
- Type-hub toggle: optional synthetic hub node per root type with containment edges,
  default on, so sparse graphs still cluster visibly.
- Pending nodes render with the pending treatment (reduced opacity + marker).
- Click navigates to `/memory/$id`. Hover shows title and type.
- Edge labels (the edge type) appear on hover, not persistently.

## Dependencies added to `packages/web`

- `@pierre/diffs` ^1.3.2 (Apache-2.0) — editor, FileDiff, CodeView.
- `@xyflow/react` ^12 — graph canvas.
- `d3-force` ^3 — layout.
- `react-markdown` ^9 + `remark-gfm` ^4 — Markdown rendering.

All support React 19. No changes to core/api dependencies.

## Server additions

- `GET /api/v1/memories` gains `scope=all`: the full flat listing with server-derived
  titles and taxonomy terms, no content bodies.
- `GET /api/v1/memories/:id/neighbors` — typed edges both directions (skip if the
  existing traverse route already serves this shape).
- `GET /api/v1/graph` — nodes + edges for the canvas.
- `PATCH /api/v1/memories/:id` — owner update via `updateEntity`.
- All registered in the OpenAPI document; client types regenerated; hand-written client
  gains `listAllMemories`, `neighbors`, `graph`, `updateMemory`.

## Error handling

- Commit conflict (prior mismatch): re-fetch, re-diff, keep the user's edit. Never lose
  editor content.
- Commit lands `pending` (policy routed it to review): say so plainly in the commit
  step result ("This change is pending review") and link to the Inbox. Owner edits are
  expected to save; this path exists because policy decides, not the UI.
- Graph endpoint on a large memory: the canvas renders up to a bounded node count and
  states how many were left out (no silent truncation).
- Pierre editor is beta: pin the exact version; the plain textarea fallback is the
  rollback path if a blocking defect appears (swap the editor pane component only —
  the split-view container, save flow, and diff step do not depend on it).

## Testing

- `buildMemoryTree`: pure-function unit tests (nesting, sorting, pending placement,
  title fallbacks).
- Routes: extend the existing vitest + testing-library route tests. Mock the new hooks
  as the memory tests already do. Pierre components and React Flow need jsdom stubs
  (canvas, ResizeObserver, workers) — mock at the component boundary: tests assert the
  wrapper receives the right props (old/new content, language), not Shiki output.
- API: integration tests per new route in `packages/api/tests`, including the PATCH
  conflict path (write, then PATCH with a stale prior, expect the mismatch response)
  and that a PATCH by an agent principal lands pending while the owner's lands saved.
- The OpenAPI drift check continues to gate client/server shape.

## Build order

1. Flat listing endpoint + workspace layout + tree (skeleton: navigate, select, read
   raw content).
2. Item pages: Markdown rendering, properties panel, connections, provenance/history.
3. Edit → diff → commit loop (Pierre editor + FileDiff + PATCH route).
4. Diff unification: History steps and Inbox proposals move to Pierre diffs; delete
   `DiffView`.
5. Graph tab (endpoint + canvas).

Each stage lands working and tested before the next.

## Out of scope

- WYSIWYG block editing (decided against; source + preview).
- Creating new documents/entities from the console (agents create; the console can gain
  a "new note" affordance later — it is one `createEntity` call away but not in this
  design).
- Deleting or archiving memories (append-only model; no delete surface exists today).
- Real-time multi-client sync (the console refetches on navigation and after writes).
- Graph layout persistence or manual node pinning.
