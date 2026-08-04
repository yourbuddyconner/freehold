# Freehold v0 — design

**Date:** 2026-08-03
**Status:** Approved, pending implementation plan
**Scope:** Freehold is a governed memory backend for AI agents, built on
the Allod format. v0 is the dogfood release: it becomes the memory layer
for the owner's own agents (Claude Code first), running locally as one
binary. It is deliberately built "right the first time" rather than as a
throwaway MVP: the public API, the storage discipline, and the packaging
are the shapes the product keeps.

## What Freehold is

Every other memory product effectively leases you back your own data.
Freehold is the freehold: your agents' accumulated knowledge lives in an
Allod graph you own — an append-only log of signed changes, verifiable
from your keys alone, governed by rules you declare. Freehold the product
is the operator around that graph: the daemon your agents talk to, the
recall index, the approval inbox, and the verification surface.

The founding loop, end to end: an agent writes freely into scratch; a
consequential write (a preference, a private-region fact) is **held** by
policy; you approve it in the inbox; the approval is a signed decision
record; recall returns the memory with its provenance; `verify` proves
the whole history. A held write is the product working, not an error.

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
   boots the full product: HTTP API, MCP endpoint, and the web inbox on
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
     `verify`, `reindex`.
   - `packages/api` — the daemon and the CLI in one artifact: Hono
     routes defined schema-first with `@hono/zod-openapi` (the routes
     generate `openapi.json`), the `/mcp` endpoint, static serving of
     the web inbox, and the CLI subcommands.
   - `packages/client` — generated from `openapi.json` by
     openapi-typescript in CI; never hand-edited; the build fails if it
     drifts from the spec.
   - `packages/web` — the approval inbox. Vite, minimal. Each pending
     proposal shows what the agent wants to write, the diff against
     current state, the policy rule that held it, and approve/reject.

4. **Data flow.** Agent → MCP tool or HTTP → `core` → Allod admission.
   Scratch-classified notes admit immediately; governed writes return
   `{ status: "held", proposal, rule }`. On every admitted changeset,
   core folds the new objects into PGlite: one row per object plus an
   embedding computed locally. Approval in the inbox signs a decision
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
   daemon serves streamable-HTTP MCP at `/mcp` with tools `remember`,
   `recall`, `propose_preference`, and `pending_approvals`.
   `freehold mcp setup claude-code` writes the agent config in one
   command; `--print` emits config JSON for any other agent.

8. **Local-first auth.** The daemon binds `127.0.0.1`. A bearer token is
   auto-minted into `~/.freehold/config.json` (0600) at first boot; the
   CLI and MCP config use it. Multi-user and remote come later and do
   not shape v0.

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

## Exit criteria (the dogfood)

On a clean machine: download one file → `./freehold serve` → inbox in
the browser. `freehold mcp setup claude-code` makes the tools available
in a live Claude Code session. Then, driven by the agent: a scratch note
admits immediately; `propose_preference` is held; the hold appears in
the web inbox with diff and rule; approving it admits the write;
`recall` returns it with provenance. Then, from the terminal:
`allod verify` (the Rust CLI) passes on the graph Freehold wrote;
SIGKILL the daemon mid-write, restart, nothing lost; `freehold reindex`
reproduces identical indexed state. When Freehold is the memory backend
for the owner's daily Claude Code sessions, v0 is shipped.

## Testing

- End-to-end loop in vitest against a spawned `freehold serve`: the
  full founding loop through the public API, in human and `--json`
  modes, with the exit-code matrix.
- Contract test: the generated client and the daemon agree with
  `openapi.json`; CI fails on drift.
- Reindex golden test: fold, index, snapshot; wipe PGlite; reindex;
  identical state.
- Cross-implementation check in CI: build the Rust `allod` CLI and run
  `allod verify` against a graph produced by the TypeScript test suite.
- MCP round-trip: each tool exercised against a live daemon.
- PGlite kill-test: SIGKILL durability against the compiled binary
  (valet's criterion, inherited).

## Non-goals for v0

Multi-tenant hosting, remote instances and profiles, semantic search
beyond hybrid retrieval (re-ranking, memory consolidation), the attested
gate (L3), federation between Freehold instances, and any billing
surface. The architecture leaves room for each; v0 builds none of them.
