# Freehold v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Freehold v0 per docs/specs/2026-08-03-freehold-v0-design.md — the governed memory daemon (`freehold serve`: HTTP API + MCP + console), CLI client, PGlite hybrid recall, and the owner console, on `@allod/core`.

**Architecture:** pnpm workspace, four packages. `core` is the only package touching Allod (graphs in `~/.freehold/graphs/<name>/` in native layout via the wasm fsBackend; PGlite is a disposable index). `api` is daemon+CLI in one artifact (Hono + zod-openapi; `/mcp` streamable HTTP; console served static; every other subcommand a client of the public API). `client` is generated from openapi.json. `web` is the console (React 19 + Vite + TanStack + Tailwind + Radix, valet bones, title-deed identity).

**Tech Stack:** Node ≥22, pnpm, TypeScript 5.x, Hono + @hono/zod-openapi + @hono/node-server, @electric-sql/pglite (+ pgvector extension), drizzle-orm (pglite driver), @huggingface/transformers (WASM embeddings), @modelcontextprotocol/sdk, openapi-typescript, vitest, tsx, esbuild, Bun compile. `@allod/core` via `file:../allod/crates/allod-wasm` (built from the allod repo's main).

## Global Constraints

- The spec (docs/specs/2026-08-03-freehold-v0-design.md) governs; its 10 locked decisions bind every task.
- **No native `.node` modules anywhere** — check every added dependency; `pnpm why` anything suspicious. This preserves Bun-compile viability.
- Daemon binds `127.0.0.1:8710`. Data dir `~/.freehold/` (override `FREEHOLD_HOME` — every test uses a temp FREEHOLD_HOME, never the real one). Layout: `config.json` (0600, holds the bearer token), `pg/`, `graphs/<name>/` (default graph name `main`) in native Allod layout.
- `held` is a success shape (`{ status: "held", proposal, rule }`), never an HTTP error. Errors are structured `{ error: { code, message } }` mirrored in the OpenAPI spec.
- CLI: `--json` for machine output; exit codes 0=ok, 2=held, 3=policy-rejected, 4=auth, 5=unreachable, 1=other.
- packages/client is generated only — CI/`pnpm build` regenerates and fails on drift; never hand-edited.
- The console and CLI consume packages/client ONLY (no direct core imports).
- Embedding provider is an interface; tests use the deterministic `hashEmbedder` (sha256-seeded pseudo-vector, 384-dim) so CI never downloads models; the real `transformersEmbedder` (bge-small-en-v1.5, 384-dim) is default at runtime and smoke-tested behind `FREEHOLD_E2E_REAL_EMBEDDER=1`.
- Zero TypeScript errors (`tsc --noEmit` per package), vitest green, `pnpm lint` (biome) clean at every task end.
- Commit style: sentence case, imperative.

---

### Task F1: Workspace scaffold + @allod/core wiring

**Files:** root `package.json` (pnpm workspace), `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.workspace.ts`, `.gitignore`, `.nvmrc` (22), `packages/core/package.json` + `src/allod.ts` + `tests/allod.test.ts`, `scripts/build-allod.sh`

- Build `@allod/core` from the sibling repo: `scripts/build-allod.sh` runs `pnpm --dir ../allod/crates/allod-wasm build` (wasm-pack + tsc; document the rustup/wasm-pack prereqs in the script header). `packages/core` depends on `"@allod/core": "file:../../../allod/crates/allod-wasm"`.
- `src/allod.ts`: `openGraph(graphDir): Promise<AllodGraph>` wrapping `new AllodGraph(backend.load(), backend.persist)` with the package's fsBackend; `createGraph(graphDir, owner)` calling `init(owner, "memory")`.
- [ ] Failing test: `createGraph` into a temp dir → `principal_add` agent → `note` admitted → `propose_preference` held → `decide` approve → `verify().ok === true`; reopen with `openGraph` → same `state().state_hash`.
- [ ] Green; commit: `Scaffold the workspace and wire @allod/core`

### Task F2: packages/core — the domain layer over Allod

**Files:** `packages/core/src/{home.ts,config.ts,graphs.ts,knowledge.ts,retrieval.ts,governance.ts,schema.ts,types.ts,index.ts}` + tests per module

**Interfaces (exact names — later tasks consume):**
```ts
// home.ts: resolveHome(): string (FREEHOLD_HOME || ~/.freehold); ensureHome()
// config.ts: loadConfig()/saveConfig(): { token: string, graph: string, embedder: "transformers"|"hash", port: number } — token minted on first load, file mode 0600
// graphs.ts: class Freehold { static async open(home?): Promise<Freehold>; graph: AllodGraph; ... }  — one instance per process
// knowledge.ts (all return Admission-shaped results; agent = principal name):
//   remember(agent, content): { status, noteId, changeset|proposal }
//   createEntity(agent, type, attributes, classify?: string[], relate?: {to,type,attributes?}[])
//   updateEntity(agent, id, attributes)  // optimistic: reads current rev
//   relate(agent, from, to, edgeType, attributes?)
//   classifyEntity(agent, subject, term)
//   attachDocument(agent, content, mediaType)
// governance.ts: pending(): ProposalView[]; approve(hash)/reject(hash) (owner-signed via graph keys); verifyGraph(): VerifyReport; principals(): PrincipalView[]; registerAgent(name): { name, mcpSnippet }
// schema.ts: describeSchema(): SchemaDescription; proposeOntologyChange(agent, docsYaml): Admission-shaped; installOntology(docsYaml): Admission-shaped (owner)
// retrieval.ts: getEntity(id): EntityView (attrs, classifications, edges both directions, provenance, revisions); traverse(from, edgeTypes?, direction?, depth?): EntityView[]
```
`ProposalView` carries: hash, agent, intent, summary (one plain-language line built from the ops), rule names that held it, the op-level diff (added/changed attributes vs current state), isSchemaProposal flag. Build the diff from the proposal's ops + current state — the Inbox depends on it.
- [ ] Failing tests per module over temp homes (the memory loop, a generic typed entity with edges, a schema proposal held→approved→instance created — mirror allod's EC2 test from TypeScript).
- [ ] Green; commit per module or coherent pairs.

### Task F3: packages/core — PGlite index + hybrid recall

**Files:** `packages/core/src/{db.ts,indexer.ts,embed.ts,recall.ts}`, `packages/core/drizzle/0000_init.sql`, tests

- Drizzle schema: `objects(id text pk, kind text, type text, content jsonb, author text, method text, approval text, changeset text, created_at, updated_at)`, `embeddings(object_id text pk references objects, vector vector(384))`, `fts` via generated tsvector column + GIN index; `meta(key text pk, value text)` storing `indexed_head`.
- `indexer.ts`: `syncIndex(freehold)` — reads `log()`, compares `indexed_head`, folds new admitted changesets' objects into rows + embeddings; `reindex(freehold)` — wipe + full rebuild; both idempotent.
- `embed.ts`: `Embedder` interface `{ embed(texts: string[]): Promise<number[][]> }`; `hashEmbedder` (deterministic) + `transformersEmbedder` (lazy-loaded); chosen by config.
- `recall.ts`: `recall(query, filters?)` — pgvector cosine (`<=>`) + `ts_rank` FTS, reciprocal-rank-fusion merge, results carry full provenance from the objects row.
- [ ] Failing tests: index after the memory loop has the note + preference rows with correct approval status; recall("tea") returns the preference with provenance; **reindex golden test**: snapshot rows (ordered, sans timestamps) → wipe pg/ → reindex → identical; hashEmbedder determinism.
- [ ] Green; commit: `Add the PGlite index and hybrid recall`

### Task F4: packages/api — daemon (HTTP + OpenAPI)

**Files:** `packages/api/src/{app.ts,routes/*.ts,auth.ts,errors.ts,serve.ts,openapi.ts}`, `packages/api/tests/api.test.ts`

Routes (all under `/api/v1`, bearer-token auth except `/health`): `GET /health`; knowledge: `POST /remember`, `POST /entities`, `PATCH /entities/:id`, `POST /relations`, `POST /classifications`, `POST /documents`; retrieval: `GET /recall?q=&type=&region=&author=&status=`, `GET /entities/:id`, `GET /entities/:id/traverse`; governance: `GET /proposals`, `POST /proposals/:hash/approve`, `POST /proposals/:hash/reject`, `GET /verify`, `POST /reindex`, `GET /principals`, `POST /agents`; schema: `GET /schema`, `POST /schema/proposals` (agent), `POST /schema/install` (owner); policy: `GET /policy`, `POST /policy` (edit → proposal); `GET /log`. All zod-schema'd via @hono/zod-openapi; `pnpm --filter api openapi` writes `openapi.json` at the package root. `serve.ts` boots core, runs `syncIndex` on admitted writes, serves the console static from `packages/web/dist` with SPA fallback, mounts `/mcp` (F6).
- [ ] Failing contract tests: spawn the app in-process (Hono test client) against a temp home — the founding loop through HTTP; held returns 200 with `status: "held"`; bad token → 401 `{error:{code:"auth"}}`; openapi.json contains every route.
- [ ] Green; commit: `Add the daemon: routes, auth, OpenAPI`

### Task F5: packages/client generation + the CLI

**Files:** `packages/client/` (generated `types.ts` + thin `client.ts` fetch wrapper, `generate.ts` script), `packages/api/src/cli/{index.ts,commands/*.ts}` (`freehold` bin: serve, status, remember, recall, pending, approve, reject, verify, reindex, mcp setup), drift check in root `pnpm build`

- CLI resolves the instance from `~/.freehold/config.json` (token + port); all commands go through packages/client over HTTP (no core import — enforce with a test that greps imports). `--json` + the exit-code matrix from Global Constraints.
- [ ] Failing tests: CLI e2e against a spawned `freehold serve` on a temp home/port — the founding loop in human and `--json` modes, exit codes asserted (held → 2); drift check test (mutate a route schema in-memory → generation diff detected).
- [ ] Green; commit: `Generate the client and add the CLI`

### Task F6: MCP endpoint + agent wiring

**Files:** `packages/api/src/mcp.ts`, `packages/api/src/cli/commands/mcp.ts`, tests

- `/mcp` streamable HTTP via @modelcontextprotocol/sdk, bearer auth. Tools (names + zod inputs per the spec's Product surface): `remember`, `create_entity`, `update_entity`, `relate`, `classify`, `attach_document`, `recall`, `get_entity`, `traverse`, `pending_approvals`, `describe_schema`, `propose_ontology_change`. Tool results include admission status and provenance; agents get NO approve/reject/policy/install tools. The MCP layer calls core directly (same process as the daemon).
- `freehold mcp setup claude-code [--print]`: writes the Claude Code MCP config entry (streamable HTTP, Authorization bearer from config) or prints JSON.
- [ ] Failing tests: MCP client (SDK) against a live daemon — list tools (exactly 12), call remember (admitted), create_entity typed, propose flow held, describe_schema lists memory/Note, recall round-trip; `mcp setup --print` emits valid config JSON.
- [ ] Green; commit: `Serve MCP over HTTP with the twelve tools`

### Task F7: Console scaffold (web bones + shell + theming)

**Files:** `packages/web/` — Vite + React 19 + TanStack Router/Query + Tailwind + Radix primitives (port valet's `components/primitives/` set and `lib/theme.ts` WITH its tests — read them from ~/code/valet dev-v2 via `git -C ~/code/valet show dev-v2:packages/web/src/...`), `src/routes/__root.tsx` (AppShell: left sidebar — Inbox w/ pending badge, Memory, Schema, Policy, Verify, Settings), fonts (Newsreader via @fontsource + system sans + mono), the status-ink palette as Tailwind tokens (verified/approved green, held amber, degraded slate, rejected red), `ProvenanceFooter` + `StatusChip` components, api client hookup (packages/client + token from a dev-served `/api/v1/session` — simplest: the daemon injects the token into `index.html` at serve time as a meta tag; document this).
- [ ] Route tests (vitest + testing-library, colocated `-*.test.tsx`): shell renders all six nav areas; theme applies before paint (port valet's theme tests); StatusChip variants; ProvenanceFooter renders author/method/approval/hash.
- [ ] Green; commit: `Scaffold the console: shell, primitives, theming, provenance components`

### Task F8: Console — Inbox + Memory browser

**Files:** `packages/web/src/routes/{index.tsx (Inbox),memory.tsx,memory.$id.tsx}` + components (`ProposalCard`, `DiffView`, `MemoryCard`, `TaxonomyTree`, `LineageTrail`) + colocated tests (mocked client)

Per the spec's front-end design: Inbox cards (agent mark, intent, plain-language summary, held-by rule chip, expandable YAML-shaped diff with added-green/changed-amber, Approve confirm stating "This signs a decision record with your key", Reject; schema proposals visually distinct with the type definition preview); Memory (search via recall, filter chips type/region/author/status, taxonomy sidebar, serif content cards with ProvenanceFooter; detail route: attribute table, classifications, edges grouped by type walkable both directions, revision history, LineageTrail); teaching empty states.
- [ ] Route tests: approve/reject flows fire the right client calls; schema proposal renders distinctly; search + filters compose query params; detail renders provenance chain.
- [ ] Green; commit: `Console: Inbox and Memory browser`

### Task F9: Console — Schema viewer, Policy, Verify, Settings

**Files:** `packages/web/src/routes/{schema.tsx,policy.tsx,verify.tsx,settings.tsx}` + components (`TypeCard`, `EdgeTypeTable`, `TermOutline`, `RuleCard`, `VerifyReport`, `PrincipalCard`) + colocated tests

Per the spec: Schema (three tabs — Types with attribute tables + inheritance breadcrumbs + provenance on agent-added types; Edges domain→range table; Taxonomy expandable outline honest about the DAG, pending proposals amber inline); Policy (rule cards: plain title, mono selector/require block, recent applications; Edit drawer → diff preview → submits proposal → routes to Inbox); Verify (run button, three level rows filling in, degraded items with reason links, changeset timeline density-table); Settings (principal cards + fingerprints, Register agent → copyable MCP snippet, revocation warning routing through Inbox, ontology install with Schema-viewer preview, token display, embedder config, theme).
- [ ] Route tests per screen (mocked client): tabs render from describeSchema fixture; policy edit becomes proposal; verify states; register-agent flow shows snippet.
- [ ] Green; commit: `Console: Schema viewer, Policy, Verify, Settings`

### Task F10: pi-agent E2E, single binary, hardening

**Files:** `packages/api/tests/e2e-agent.test.ts`, `packages/api/build/{bundle.mjs,compile-binary.mjs}`, `.github/workflows/ci.yml`, `packages/api/tests/kill.test.ts`

- **pi-agent E2E** (spec Testing): `@mariozechner/pi-agent-core` + `pi-ai` wired to the daemon's `/mcp`; scripted scenario with a mock LLM transport (deterministic tool-call script — check pi-agent-core's test utilities for a scriptable driver; if the API demands a real model, use `FREEHOLD_E2E_LLM=1` gating with an env-keyed provider and keep the deterministic path as default) driving: remember → propose (held) → pending_approvals → (test harness approves via HTTP as owner) → recall returns it with provenance. Assert the agent's tool-call sequence and final state.
- **Single binary** (valet chain): esbuild bundle of packages/api (console dist + drizzle SQL + wasm assets via an asset layer — PGlite and @allod/core WASM load from bundled bytes), then `bun build --compile`; kill-test: SIGKILL the compiled binary mid-write, restart, `verify` ok and no index corruption (reindex if `indexed_head` is behind).
- **CI:** jobs — lint+typecheck+unit; api e2e (builds allod wasm from a checked-out allod repo ref — document the cross-repo checkout; runs the Rust `allod verify` cross-check on a Freehold-written graph); binary build + kill test.
- [ ] All green locally end to end; commit steps separately.

## Self-review notes (applied)

- Spec decision coverage: D1→F4/F5 (serve + client-only CLI), D2→F1/F10 (stack + binary), D3→F2-F9 (packages), D4→F2/F3/F4 (flow), D5→F3 (hybrid), D6→F3 (disposable index), D7→F6 (MCP), D8→F1/F4 (auth), D9→F1/F2 (layout), D10→F4/F5 (errors/exit codes).
- Exit criteria: memory loop → F5/F6 tests; schema loop → F2 (core EC2 mirror) + F6 + F8/F9 UI; trust loop → F4 verify + F10 (allod verify cross-check, kill test, reindex golden in F3).
- The pi-agent E2E is the closest CI proxy for the dogfood; the live dogfood itself is the deliverable after this plan (session task #10).
