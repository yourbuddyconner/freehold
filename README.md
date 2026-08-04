# Freehold

**A governed memory backend for AI agents. Your agents' knowledge, in a
graph you own.**

The name comes from freehold tenure: property held outright, as opposed
to leasehold. Most memory products effectively lease you back your own
data — it lives in their store, in their format, under their rules.
Freehold keeps your agents' accumulated knowledge in an
[Allod](https://github.com/yourbuddyconner/allod) graph: an append-only
log of signed changes that you own as files, can verify from your keys
alone, and govern with rules you declare.

## What it does

Freehold (`freehold serve`) runs on your machine. It gives agents a memory
they can read and write, and gives you control over what they write:

- **Agents connect over MCP** (streamable HTTP at `/mcp`) and get twelve
  tools: `remember`, `create_entity`, `update_entity`, `relate`,
  `classify`, `attach_document`, `recall`, `get_entity`, `traverse`,
  `pending_approvals`, `describe_schema`, and
  `propose_ontology_change`. Agents never get approval or policy tools.
- **You approve what matters.** Quick notes save instantly. Important
  writes — a preference about you, anything outside the scratch area —
  become **pending** proposals until you approve them. Approval signs a
  decision record with your key.
- **Memory is typed knowledge, not a pile of notes.** Entities have
  types, relationships are typed edges, and the schema itself lives in
  the graph. An agent can read the schema with `describe_schema` and,
  with your approval, extend it — propose a new entity type, get it
  reviewed in the same inbox as everything else, then use it.
- **Recall is hybrid.** Semantic search (a local embedding model — your
  memory never leaves the machine) merged with full-text search, over an
  embedded Postgres (PGlite) index. Every result carries its
  provenance: who wrote it, by what method, who approved it, and the
  changeset hash. The index is disposable: `freehold reindex` rebuilds
  it from the log.
- **The console** (served at the same port) has six areas: Inbox
  (pending proposals with diffs and the rules that stopped them), Memory
  (search, browse, entity detail with provenance), Schema (the ontology
  viewer, including agent-added types), Policy, Verify (the changeset
  timeline and verification), and Settings.
- **Anyone can check the graph.** The Rust reference implementation's
  `allod verify` passes on graphs Freehold writes — verification does
  not depend on Freehold, or on trusting Freehold.

## Quickstart

Prerequisites: Node ≥ 22, [pnpm](https://pnpm.io), and — because
`@allod/core` is consumed from a sibling checkout — Rust with
`wasm-pack` to build it once.

```bash
# 1. Clone both repos as siblings
git clone https://github.com/yourbuddyconner/allod
git clone https://github.com/yourbuddyconner/freehold

# 2. Build the Allod wasm package
cd allod/crates/allod-wasm && pnpm install && pnpm build && cd ../../..

# 3. Install and start Freehold
cd freehold && pnpm install
pnpm --dir packages/api exec tsx src/cli/index.ts serve
```

Freehold binds `127.0.0.1:8710`, creates `~/.freehold/` (config,
index, and your graph in native Allod layout), and serves the console at
[http://127.0.0.1:8710](http://127.0.0.1:8710).

Wire an agent:

```bash
freehold mcp setup claude-code   # writes the MCP config entry
freehold mcp setup --print       # or print it for any other agent
```

Then, from a second terminal or the console: watch the Inbox as your
agent works, and approve what deserves to be true.

## CLI

`freehold serve` runs the product. Every other command is a client of
the running Freehold over its public HTTP API: `status`, `remember`,
`recall`, `pending`, `approve <hash>`, `reject <hash>`, `verify`,
`reindex`, `mcp setup`. All commands take `--json`; exit codes are
`0` ok, `2` pending approval, `3` policy-rejected, `4` auth, `5` Freehold
not running.

## How it's built

| Package | Role |
|---|---|
| `packages/core` | The only package that touches Allod: graph operations, the PGlite index, embeddings, recall |
| `packages/api` | The daemon (HTTP API + `/mcp` + console serving) and the CLI, one artifact |
| `packages/client` | Generated from `openapi.json`; the CLI and console consume the API only through it |
| `packages/web` | The console: React, TanStack Router/Query, Tailwind |

Design documents live in [docs/specs/](docs/specs/) and implementation
plans in [docs/plans/](docs/plans/). The product decisions — one binary,
approval-gated writes, the disposable index, local-first auth, no native
modules — are recorded there with their reasoning.

## Status

v0, working end to end locally: agents write and recall memory with
full provenance, propose new entity and edge types through the same
approval flow, and the resulting graphs pass three-level verification
cross-checked by the Rust `allod` CLI.

Known limitations, tracked in
[docs/notes/F10-deferred.md](docs/notes/F10-deferred.md): the compiled
single binary ships with the deterministic hash embedder only (run from
source for semantic recall); the Verify page's per-level rows are
heuristic pending a richer API; per-rule policy applications are not yet
surfaced. Multi-user, remote instances, and federation between Freehold
instances are out of scope for v0.

## Development

```bash
pnpm -r test        # all packages (core, api, web)
pnpm -r typecheck
pnpm lint
pnpm --filter @freehold/web build     # console bundle
FREEHOLD_E2E_REAL_EMBEDDER=1 pnpm --filter @freehold/core test   # real-model smoke
```

Tests run against temporary homes and never touch `~/.freehold`.

## License

MIT OR Apache-2.0, matching Allod.
