# Freehold v0 — design

**Date:** 2026-08-03
**Status:** Approved, pending implementation plan
**Scope:** Freehold is a governed memory backend for AI agents, built on
the Allod format. v0 is the dogfood release: it becomes the memory layer
for the owner's own agents (Claude Code first), running locally as one
binary with a full owner console. It is deliberately built "right the
first time" rather than as a throwaway MVP: the public API, the storage
discipline, the console, and the packaging are the shapes the product
keeps. Freehold is agent memory first, but it exposes as much of Allod's
surface as is reasonable: typed entities and edges, classifications,
documents, provenance, and the schema itself.

## What Freehold is

Every other memory product effectively leases you back your own data.
Freehold is the freehold: your agents' accumulated knowledge lives in an
Allod graph you own — an append-only log of signed changes, verifiable
from your keys alone, governed by rules you declare. Freehold the product
is the operator around that graph: the daemon your agents talk to, the
recall index, the owner console, and the verification surface.

Memory here is not a pile of notes. It is a typed knowledge graph: a
`Preference` with a strength, a `Colleague` with a Slack ID, a `relates_to`
edge with dates, a source document anchored by content hash — under a
schema the agent can read, and, with your approval, extend. The founding
loop: an agent writes freely into scratch; a consequential write is
**held** by policy; you approve it in the inbox; the approval is a signed
decision record; recall returns the memory with its provenance; `verify`
proves the whole history. A held write is the product working, not an
error.

## Product surface

### For agents (MCP tools, HTTP API)

The tool surface is idiomatic to Allod's data model — objects are typed,
writes are atomic changesets, admission status is always explicit, and
the schema is itself readable and extensible. Every write tool returns
either `{ status: "admitted", changeset }` or
`{ status: "held", proposal, rule }`.

**Knowledge:**

- `remember(content)` — the ergonomic fast path: a scratch
  `memory/Note`, admitted immediately. Sugar over `create_entity`.
- `create_entity(type, attributes, classify?, relate?)` — create a typed
  node with optional classifications and edges in one atomic changeset
  ("a `memory/Preference` classified `life/health`, derived from that
  note"). The type is any entity type installed in the graph, not a
  fixed menu.
- `update_entity(id, attributes)` — revise, with optimistic concurrency
  against the entity's current revision.
- `relate(from, to, edge_type, attributes?)` — a typed edge; time lives
  on edges (`from`/`until`), per the corp-ontology convention.
- `classify(subject, term)` — place a node, edge, or document in the
  taxonomy. Classification routes policy, so this can be held.
- `attach_document(content, media_type)` — anchor source material by
  content hash, so claims can cite exact bytes.

**Retrieval:**

- `recall(query, filters?)` — hybrid semantic + full-text search;
  filters by type, region, author, approval status. Every result
  carries provenance.
- `get_entity(id)` — one object in full: attributes, classifications,
  edges, provenance chain, revision history.
- `traverse(from, edge_types?, direction?, depth?)` — walk the typed
  graph ("what does this preference derive from?").
- `pending_approvals()` — the agent's view of its own held writes.

**Schema:**

- `describe_schema()` — the graph's installed ontologies as data: entity
  types with attribute schemas and inheritance, edge types with
  domain/range/cardinality, the taxonomy tree, versions and import
  hashes. This is how an agent learns what this graph can hold — read
  from the graph itself, not from documentation.
- `propose_ontology_change(change)` — the agent evolves its world-model
  under governance: add an entity type (`Colleague extends
  core/Person`), add an edge type, add a taxonomy term. Schema changes
  are always held (the `schema-changes-are-serious` rule), reviewed in
  the owner's inbox, and installed on approval. This is the Allod
  spec's Appendix B scenario — the agent's ontology after months of
  use — as a product flow.

The MCP tools are a strict subset of the HTTP API: agents never get
approval, rejection, policy mutation, or key operations through the tool
surface.

**Arbitrary ontologies.** The graph starts with `core` + `memory`, but
any Allod ontology package can be installed (an owner action in
Settings): add `research` and the same agent tools store claims with
evidence chains; add `corp` and they track people and agreements.
Freehold's tools are generic over whatever the graph's schema says —
that is the point of building on a real format.

**A known seam:** allod's schema-as-object materialization has not
shipped (schema currently lives as installed documents). v0 implements
ontology changes as a governed Freehold flow — proposal, owner decision
record, then schema-doc install — and migrates to true in-graph schema
changesets when allod materializes them. The product behavior is
identical; the substrate underneath improves.

### For the owner (the console)

Six areas, one binary, served at the daemon's port:

1. **Inbox** — pending proposals, newest first: knowledge writes and
   schema proposals in one queue, schema proposals visually distinct.
   Each card: which agent, its stated intent, a plain-language summary,
   the diff, and the rule that held it. Approve signs a decision record
   with the owner key; reject records a signed rejection that stays
   auditable.
2. **Memory** — everything the graph knows. Hybrid search, filters by
   region, type, author, and approval status, a taxonomy sidebar, and
   entity detail with attributes, classifications, typed edges (walkable
   in both directions), the provenance chain, and revision history.
3. **Schema** — the ontology viewer. Entity types as cards with their
   attribute tables and inheritance (`Colleague extends core/Person`),
   edge types as a domain→range table, and the taxonomy rendered as a
   navigable tree. Every type shows its version, which package declared
   it, and — for agent-proposed types — the provenance of the change
   that added it. Pending schema proposals surface here as well as in
   the Inbox. Ontology package installation lives in Settings; the
   viewer is read-only truth.
4. **Policy** — the rules in force, in human terms above their exact
   selector and requirements, with each rule's recent applications.
   Editing a rule is itself a governed change routed through the Inbox.
5. **Verify** — the trust dashboard: three-level verification with
   per-level results, degraded items with reasons, state hash, and the
   changeset timeline.
6. **Settings** — principals and keys, agent registration (ends on a
   copyable MCP config snippet), key revocation, ontology package
   installation, the API bearer token, embedding provider config, and
   theme.

### The memory lifecycle (the through-line)

Write → (held → approved) → admitted → indexed → recalled → verified.
Every surface shows the same lifecycle vocabulary and the same status
badges: `scratch`, `held`, `approved`, `rejected`, `degraded`,
`verified`. A memory's status is never ambiguous, and every status is
clickable through to the evidence behind it. Schema changes ride the
same lifecycle — a proposed entity type is `held` exactly like a
proposed preference.

## Foundation

Freehold consumes `@allod/core`, the WASM npm package produced by the
Allod library refactor (see
`~/code/allod/docs/specs/2026-08-03-library-refactor-wasm-design.md`).
That sub-project ships first, and its API is generic over the data
model — object and changeset builders, registry introspection, schema
install — not memory-specific sugar, which is what makes Freehold's
generic tool surface possible. Graphs are stored in the native Allod
on-disk layout, so the Rust `allod` CLI can open and verify any graph
Freehold writes — cross-implementation verification is a standing
conformance check, not a demo.

## Decisions (locked)

1. **One binary, two personalities** (valet pattern). `freehold serve`
   boots the full product: HTTP API, MCP endpoint, and the console on
   one local port. Every other subcommand (`status`, `pending`,
   `approve`, `reject`, `remember`, `recall`, `verify`, `reindex`,
   `mcp setup`) is a client of a running instance **through the public
   HTTP API only** — no side-door into the engine, which keeps the CLI a
   permanent conformance consumer of the API and avoids two processes
   sharing PGlite.

2. **Stack** (valet dev-v2 chain, proven): pnpm workspace, Node ≥ 22,
   TypeScript, Hono + `@hono/node-server`, PGlite (embedded Postgres,
   WASM) with the pgvector extension, drizzle for index-schema
   migrations, vitest, tsx for dev, esbuild bundle, Bun `compile` for
   per-platform single binaries. **No native `.node` modules anywhere in
   the dependency tree** — the discipline that makes the single binary
   possible. PGlite and `@allod/core` are both WASM, and embeddings run
   on transformers.js (WASM ONNX), not fastembed, for the same reason.

3. **Packages.**
   - `packages/core` — the only package that touches Allod. Wraps the
     `@allod/core` graph, owns PGlite, and exposes typed operations
     mirroring the product surface: the knowledge ops (`remember`,
     `createEntity`, `updateEntity`, `relate`, `classify`,
     `attachDocument`), retrieval (`recall`, `getEntity`, `traverse`),
     schema (`describeSchema`, `proposeOntologyChange`,
     `installOntology`), and governance (`pending`, `approve`,
     `reject`, `verify`, `reindex`, `principals`, `policy`).
   - `packages/api` — the daemon and the CLI in one artifact: Hono
     routes defined schema-first with `@hono/zod-openapi` (the routes
     generate `openapi.json`), the `/mcp` endpoint, static serving of
     the console with SPA fallback, and the CLI subcommands.
   - `packages/client` — generated from `openapi.json` by
     openapi-typescript in CI; never hand-edited; the build fails if it
     drifts from the spec. Used by the CLI, the console, and any future
     integration equally.
   - `packages/web` — the console (see Front-end design below).

4. **Data flow.** Agent → MCP tool or HTTP → `core` → Allod admission.
   Scratch-classified notes admit immediately; governed writes return
   `{ status: "held", proposal, rule }`. On every admitted changeset,
   core folds the new objects into PGlite: one row per object plus an
   embedding computed locally. Approval in the console signs a decision
   record with the owner key; the write is then admitted and indexed.
   Every recall result carries provenance: changeset hash, author,
   approval status.

5. **Recall is hybrid.** pgvector cosine similarity merged with
   Postgres full-text search, over the same PGlite database. Default
   embedding model: `bge-small-en-v1.5` (384-dim) via transformers.js,
   in-process — **memory never leaves the machine by default**. The
   embedding provider is an interface; a config change can point it at
   an API for users who choose that trade.

6. **The index is disposable.** PGlite carries nothing the log cannot
   reproduce, except embeddings, which are derived data. `freehold
   reindex` rebuilds the database from the graph log and must land on
   identical indexed state (embeddings recompute). This is Allod design
   principle 1 enforced by a test, and it is also the recovery story.

7. **MCP over HTTP, no stdio bridge** (valet's locked decision). The
   daemon serves streamable-HTTP MCP at `/mcp` with the tool surface
   defined in Product surface. `freehold mcp setup claude-code` writes
   the agent config in one command; `--print` emits config JSON for any
   other agent.

8. **Local-first auth.** The daemon binds `127.0.0.1`. A bearer token is
   auto-minted into `~/.freehold/config.json` (0600) at first boot; the
   CLI, the console, and MCP config use it. Multi-user and remote come
   later and do not shape v0.

9. **Layout on disk.** `~/.freehold/` holds `config.json`, `pg/` (the
   PGlite data dir, single-owner discipline), and `graphs/<name>/` in
   native Allod format — openable by the Rust CLI. Keys live in the
   graph directory, plain-keypair profile, per the spec's reference
   profile.

10. **Errors.** Structured, mirrored in the OpenAPI spec: policy
    rejection, schema violation, signature failure, index-out-of-date,
    unreachable instance. `held` is a first-class success shape, never
    an error. CLI: `--json` for machine output, meaningful exit codes
    (valet's convention).

## Front-end design

### Bones (inherited from valet dev-v2)

React 19 + Vite. TanStack Router with colocated `-route.test.tsx` route
tests, TanStack Query for all server state (zustand only where server
state genuinely doesn't fit). Tailwind + Radix primitives in a
`components/primitives/` directory (button, card, badge, dialog,
dropdown, input, scroll-area, separator, tooltip — valet's set, ported).
lucide-react icons. Light/dark/system theming via `data-theme` on
`<html>`, applied before first paint (valet's `theme.ts` pattern, ported
with its tests). The console consumes `packages/client` only — the same
public-API conformance rule the CLI follows.

### Identity (Freehold's own, not a valet clone)

The aesthetic is **the title deed**: memory as owned property, recorded
in a ledger you can hold. Concretely:

- **Type.** Newsreader (serif) for memory content and display headings —
  the recorded-document voice. A neutral sans (system stack) for UI
  chrome. Mono for hashes, key fingerprints, type names, and rule
  selectors, always truncated with copy-on-click.
- **Surfaces.** Paper-like cards on a quiet background, ruled hairline
  separators, generous whitespace. Density belongs to tables (Verify
  timeline, edge-type table), not to memory content.
- **Status is ink, not decoration.** One consistent status palette
  everywhere: verified/approved in green ink, held in amber, degraded in
  slate with a reason, rejected in red. A status chip is always a link
  to its evidence (the decision record, the failing check, the rule).
- **Provenance is a first-class component.** Every memory, everywhere it
  appears, renders with a `ProvenanceFooter`: author chip (which agent,
  which human), method chip (`manual` / `model-assisted` + tool),
  approval badge, changeset hash. No memory is ever shown context-free.
  Schema types carry it too: an agent-proposed entity type shows who
  proposed it and who approved it.

### Layout and screens

App shell: left sidebar nav — Inbox (with pending-count badge), Memory,
Schema, Policy, Verify, Settings — over a content pane. Entity and type
detail open as routes (linkable), not modals.

- **Inbox card:** header (agent avatar-mark, intent, relative time), a
  one-line plain-language summary ("jarvis wants to record a preference:
  *prefers morning meetings*" / "jarvis wants to add an entity type:
  *Colleague extends core/Person*"), the held-by rule chip, an
  expandable object diff (added attributes in green, changed in amber,
  YAML-shaped), and Approve / Reject actions. Schema proposals get a
  distinct card accent and show the type definition as it would appear
  in the Schema viewer. Approve confirms with what signing means: "This
  signs a decision record with your key."
- **Memory browser:** search bar (hybrid, same engine as agents), filter
  chips, taxonomy tree in a collapsible sidebar, results as cards with
  content in serif and the provenance footer. Entity detail adds the
  full attribute table, classification list, typed edges grouped by
  edge type and walkable in both directions, revision history, and the
  lineage chain rendered as a vertical trail (this claim ← this note ←
  this changeset).
- **Schema viewer:** three tabs. *Types* — entity-type cards showing
  attribute tables (name, type expression, required), inheritance
  rendered as a breadcrumb (`Colleague ← core/Person`), version, and
  declaring package; agent-added types carry their provenance footer.
  *Edges* — the domain→range table with cardinality and attributes.
  *Taxonomy* — the term tree as an expandable outline, each term
  showing its parents (it is a DAG, not a tree — multi-parent terms
  appear under each parent with a link-back), and which policy rules
  key on it. Pending schema proposals render inline, amber, where they
  would land.
- **Policy:** one card per rule — plain-language title, selector and
  requirements in a mono block, and a "recent applications" list.
  "Edit" opens the YAML in a drawer with a diff preview; submitting
  creates a proposal and routes you to the Inbox to approve your own
  change — the loop made visible.
- **Verify:** a run button, three level rows (integrity, authorship,
  governance) that fill in as checks complete, each expandable to
  per-changeset results; degraded items always carry their reason and a
  link to the object. Below: the changeset timeline (hash, author,
  intent, op count) — valet's density-table styling.
- **Settings:** principal cards with key fingerprints and status;
  "Register agent" flow ends on a copyable MCP config snippet;
  revocation warns that it is a governed change and routes through the
  Inbox; ontology package installation with the package's contents
  previewed in Schema-viewer components before confirming.
- **Empty states** teach the product: an empty Inbox explains the
  founding loop; an empty Memory page shows the MCP setup command; an
  empty Schema tab explains that agents can propose types.

Out of scope for v0's console: the force-directed memory graph view
(valet's `memory-graph` shows the shape; it returns in v0.1), bulk
operations, and mobile layouts beyond not-broken.

## Exit criteria (the dogfood)

On a clean machine: download one file → `./freehold serve` → console in
the browser. `freehold mcp setup claude-code` makes the tools available
in a live Claude Code session. Then, driven by the agent:

1. **The memory loop.** A scratch note admits immediately;
   `propose_preference`-shaped governed writes (via `create_entity`) are
   held; the hold appears in the Inbox with summary, diff, and rule;
   approving it admits the write; `recall` returns it with provenance.
2. **The schema loop.** The agent calls `describe_schema`, finds no
   type for what it wants to store, proposes `Colleague extends
   core/Person` with a `slack_id` attribute, and the proposal is held.
   The owner approves it in the Inbox. The agent then creates a
   `Colleague` entity and relates it to an existing note. The Schema
   viewer shows the new type with its provenance; the Memory browser
   shows the typed entity with its edges.
3. **The trust loop.** In the console: the Policy page shows the rules
   with these applications listed; the Verify page runs green with the
   `evidence: none` envelope reported as degraded, exactly as the Allod
   spec requires. From the terminal: `allod verify` (the Rust CLI)
   passes on the graph Freehold wrote; SIGKILL the daemon mid-write,
   restart, nothing lost; `freehold reindex` reproduces identical
   indexed state.

When Freehold is the memory backend for the owner's daily Claude Code
sessions, v0 is shipped.

## Testing

- End-to-end loop in vitest against a spawned `freehold serve`: all
  three exit-criteria loops through the public API, in human and
  `--json` modes, with the exit-code matrix.
- Contract test: the generated client and the daemon agree with
  `openapi.json`; CI fails on drift.
- Console route tests colocated with routes (valet convention): inbox
  approve/reject for both knowledge and schema proposals, memory search
  and detail provenance rendering, schema viewer tabs, policy
  edit-becomes-proposal, verify report states — against a mocked
  `packages/client`.
- Reindex golden test: fold, index, snapshot; wipe PGlite; reindex;
  identical state.
- Cross-implementation check in CI: build the Rust `allod` CLI and run
  `allod verify` against a graph produced by the TypeScript test suite —
  including the graph from the schema loop.
- MCP round-trip: each tool exercised against a live daemon.
- PGlite kill-test: SIGKILL durability against the compiled binary
  (valet's criterion, inherited).

## Non-goals for v0

Multi-tenant hosting, remote instances and profiles, semantic search
beyond hybrid retrieval (re-ranking, memory consolidation), the memory
graph visualization, agent-authored policy changes (schema yes, policy
owner-only), ontology deprecation and migration tooling beyond what
admission requires, the attested gate (L3), federation between Freehold
instances, and any billing surface. The architecture leaves room for
each; v0 builds none of them.
