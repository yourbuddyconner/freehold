# Freehold v0 — design

**Date:** 2026-08-03
**Status:** Approved, pending implementation plan
**Scope:** Freehold is a governed memory backend for AI agents, built on
the Allod format. v0 is the dogfood release: it becomes the memory layer
for the owner's own agents (Claude Code first), running locally as one
binary with a full owner console. It is deliberately built "right the
first time" rather than as a throwaway MVP: the public API, the storage
discipline, the console, and the packaging are the shapes the product
keeps.

## What Freehold is

Every other memory product effectively leases you back your own data.
Freehold is the freehold: your agents' accumulated knowledge lives in an
Allod graph you own — an append-only log of signed changes, verifiable
from your keys alone, governed by rules you declare. Freehold the product
is the operator around that graph: the daemon your agents talk to, the
recall index, the owner console, and the verification surface.

The founding loop, end to end: an agent writes freely into scratch; a
consequential write (a preference, a private-region fact) is **held** by
policy; you approve it in the inbox; the approval is a signed decision
record; recall returns the memory with its provenance; `verify` proves
the whole history. A held write is the product working, not an error.

## Product surface

### For agents (MCP tools, HTTP API)

Four tools in v0, deliberately few:

- `remember(content)` — a scratch note. Admits immediately under the
  scratch rule; returns the note ID and its changeset hash.
- `propose_preference(statement, strength, from_note?)` — a governed
  write. Returns `{ status: "held", proposal, rule }` and the memory
  enters the owner's inbox.
- `recall(query, filters?)` — hybrid retrieval. Every result carries
  content, type, region, author, method, approval status, and changeset
  hash. The agent can tell an owner-approved preference from its own
  scratch note, and can cite the provenance.
- `pending_approvals()` — the agent's view of its own held writes, so
  it can tell the owner "I proposed X, it's waiting for you."

The HTTP API is the same surface plus the owner-side operations the
console and CLI use (approve, reject, verify, reindex, principals,
policy). MCP tools are a strict subset: agents never get approval or
policy mutation rights through the tool surface.

### For the owner (the console)

Five areas, one binary, served at the daemon's port:

1. **Inbox** — pending proposals, newest first. Each card: which agent,
   its stated intent, a plain-language summary of what would change, the
   diff against current state, and the policy rule that held it.
   Approve signs a decision record with the owner key; reject records a
   signed rejection that stays auditable. The nav badge shows the
   pending count.
2. **Memory** — everything the graph knows. Hybrid search (same engine
   the agents use), filters by region, type, author, and approval
   status, and a taxonomy sidebar for browsing by life region. Each
   memory opens into a detail view: full content, classification chips,
   and the complete provenance chain — who wrote it, by what method,
   which changeset, who approved it, what it derives from, and every
   prior revision.
3. **Policy** — the rules in force, rendered in human terms
   ("Preferences require your approval", "Scratch admits freely") above
   their exact selector and requirements, with each rule's recent
   applications (what it held or admitted). Editing a rule is itself a
   governed change: the console turns the edit into a proposal that the
   owner approves in the Inbox — Freehold dogfooding its own
   governance.
4. **Verify** — the trust dashboard. One click runs three-level
   verification (integrity, authorship, governance) and reports
   per-level results, any degraded items with reasons, changeset and
   object counts, the current state hash, and the changeset timeline.
   This page is the product's proof: it must be legible to someone
   deciding whether to trust the graph.
5. **Settings** — principals and keys (owner and agents, with
   fingerprints), agent registration (mints a keypair and prints the
   MCP config snippet), key revocation (a governed change), the API
   bearer token, embedding provider config, and theme.

### The memory lifecycle (the through-line)

Write → (held → approved) → admitted → indexed → recalled → verified.
Every surface shows the same lifecycle vocabulary and the same status
badges: `scratch`, `held`, `approved`, `rejected`, `degraded`,
`verified`. A memory's status is never ambiguous, and every status is
clickable through to the evidence behind it.

## Foundation

Freehold consumes `@allod/core`, the WASM npm package produced by the
Allod library refactor (see
`~/code/allod/docs/specs/2026-08-03-library-refactor-wasm-design.md`).
That sub-project ships first. Graphs are stored in the native Allod
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
     `@allod/core` graph (memory ontology + `memory-local` policy from
     the allod repo), owns PGlite, and exposes typed operations:
     `remember`, `propose`, `recall`, `pending`, `approve`, `reject`,
     `verify`, `reindex`, `principals`, `policy`.
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
   daemon serves streamable-HTTP MCP at `/mcp` with the four agent
   tools. `freehold mcp setup claude-code` writes the agent config in
   one command; `--print` emits config JSON for any other agent.

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
  chrome. Mono for hashes, key fingerprints, and rule selectors, always
  truncated with copy-on-click.
- **Surfaces.** Paper-like cards on a quiet background, ruled hairline
  separators, generous whitespace. Density belongs to tables (Verify
  timeline), not to memory content.
- **Status is ink, not decoration.** One consistent status palette
  everywhere: verified/approved in green ink, held in amber, degraded in
  slate with a reason, rejected in red. A status chip is always a link
  to its evidence (the decision record, the failing check, the rule).
- **Provenance is a first-class component.** Every memory, everywhere it
  appears, renders with a `ProvenanceFooter`: author chip (which agent,
  which human), method chip (`manual` / `model-assisted` + tool),
  approval badge, changeset hash. No memory is ever shown context-free.

### Layout and screens

App shell: left sidebar nav — Inbox (with pending-count badge), Memory,
Policy, Verify, Settings — over a content pane. Memory detail opens as a
route (linkable), not a modal.

- **Inbox card:** header (agent avatar-mark, intent, relative time), a
  one-line plain-language summary ("jarvis wants to record a preference:
  *prefers morning meetings*"), the held-by rule chip, an expandable
  object diff (added attributes in green, changed in amber, YAML-shaped,
  no raw internals by default), and Approve / Reject actions. Approve
  confirms with what signing means: "This signs a decision record with
  your key."
- **Memory browser:** search bar (hybrid, same engine as agents), filter
  chips, taxonomy tree in a collapsible sidebar, results as cards with
  content in serif and the provenance footer. Detail route adds full
  attribute table, classification list, revision history, and the
  lineage chain rendered as a vertical trail (this claim ← this note ←
  this changeset).
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
  Inbox.
- **Empty states** teach the product: an empty Inbox explains the
  founding loop; an empty Memory page shows the MCP setup command.

Out of scope for v0's console: the force-directed memory graph view
(valet's `memory-graph` shows the shape; it returns in v0.1), bulk
operations, and mobile layouts beyond not-broken.

## Exit criteria (the dogfood)

On a clean machine: download one file → `./freehold serve` → console in
the browser. `freehold mcp setup claude-code` makes the tools available
in a live Claude Code session. Then, driven by the agent: a scratch note
admits immediately; `propose_preference` is held; the hold appears in
the Inbox with summary, diff, and rule; approving it admits the write;
`recall` returns it with provenance. In the console: the memory appears
in the browser with its full provenance chain; the Policy page shows the
rule that held it with this application listed; the Verify page runs
green with the `evidence: none` envelope reported as degraded, exactly
as the Allod spec requires. Then, from the terminal: `allod verify` (the
Rust CLI) passes on the graph Freehold wrote; SIGKILL the daemon
mid-write, restart, nothing lost; `freehold reindex` reproduces
identical indexed state. When Freehold is the memory backend for the
owner's daily Claude Code sessions, v0 is shipped.

## Testing

- End-to-end loop in vitest against a spawned `freehold serve`: the
  full founding loop through the public API, in human and `--json`
  modes, with the exit-code matrix.
- Contract test: the generated client and the daemon agree with
  `openapi.json`; CI fails on drift.
- Console route tests colocated with routes (valet convention): inbox
  approve/reject flows, memory search and detail provenance rendering,
  policy edit-becomes-proposal, verify report states — against a mocked
  `packages/client`.
- Reindex golden test: fold, index, snapshot; wipe PGlite; reindex;
  identical state.
- Cross-implementation check in CI: build the Rust `allod` CLI and run
  `allod verify` against a graph produced by the TypeScript test suite.
- MCP round-trip: each tool exercised against a live daemon.
- PGlite kill-test: SIGKILL durability against the compiled binary
  (valet's criterion, inherited).

## Non-goals for v0

Multi-tenant hosting, remote instances and profiles, semantic search
beyond hybrid retrieval (re-ranking, memory consolidation), the memory
graph visualization, the attested gate (L3), federation between Freehold
instances, and any billing surface. The architecture leaves room for
each; v0 builds none of them.
