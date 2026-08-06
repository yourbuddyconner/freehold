# AGENTS.md

Operating guide for agents working in this repository.

## What this is

Freehold is a local-first memory and code-review console over allod graphs.
A Node daemon (Hono API) serves a React SPA and talks to allod graphs
through `@allod/core` (wasm). pnpm monorepo, four packages:

- `packages/core` — graph access, git review logic, code viewer, key/signing
  glue. Everything that touches an allod graph or a git repo lives here.
- `packages/api` — Hono routes, OpenAPI schema (`src/openapi.ts`), the
  `freehold` CLI (`src/cli/`), daemon entry (`serve`).
- `packages/client` — generated API client. Never edit by hand; regenerate.
- `packages/web` — TanStack Router + React 19 SPA, Tailwind, Pierre
  components (`@pierre/diffs`, `@pierre/trees`).

## Commands

```
pnpm install
pnpm -r build              # build all packages (order matters; do this after core/api edits)
pnpm test                  # root vitest — core + api ONLY, does NOT run web
pnpm --filter @freehold/web test    # the web suite; run it explicitly, always
pnpm --filter @freehold/web exec tsc -b --force   # web typecheck gate
pnpm lint                  # biome check . (format + lint); lint:fix to autofix
```

Gates before any merge: `pnpm -r build`, root `pnpm test`, the web suite,
web `tsc -b --force`, `pnpm lint`. The root test script silently excludes
the web package — a green root run proves nothing about web.

After changing `packages/core` or `packages/api`, run `pnpm -r build`
before running dependent tests. Tests import built dists; stale dists
produce failures that look like your change broke something it didn't.

## API / client codegen

Any change to routes or response shapes:

1. Update the Zod schemas in `packages/api/src/openapi.ts`.
2. `pnpm --filter @freehold/api openapi` (regenerates `openapi.json`).
3. `pnpm --filter @freehold/client generate`, then
   `pnpm --filter @freehold/client check:drift` must pass.
4. Commit the regenerated output. `openapi.json` is biome-formatted —
   run `pnpm lint:fix` if the generator's formatting drifts.

## Running the daemon locally

```
cd packages/api && pnpm exec tsx src/cli/index.ts serve
```

Config and registry live in `~/.freehold/` (`config.json` holds port and
bearer token; graphs registry is a PGlite database in `pg/` — single
process, never open it while the daemon runs). The daemon serves the BUILT
web bundle: after web changes, `pnpm --filter @freehold/web build` (or
`pnpm -r build`), then restart the daemon, or you will be looking at the
previous UI and wondering why nothing changed.

At startup the daemon pre-warms the git-proposal cache per repo graph
(takes ~1–2 minutes on a real repo; watch for `pre-warmed proposals` in
the log). Proposal evaluation is cached keyed on the decisions-notes tip;
each decide invalidates the whole cache and triggers a background re-warm.

## Signing: the one rule that causes 500s

The wasm graph cannot sign in-process. Every signed write goes through the
two-phase host seam: build the payload, sign on the host via the key
backend, commit the signed envelope. `decideGit` in
`packages/core/src/gitreview.ts` is the reference implementation. Never
call `fh.graph.commit(..., /* sign */ true)` directly from a route — it
throws inside wasm and surfaces as a bare 500. If an endpoint writes
signed artifacts, its logic belongs in core, using the same helper the
decide path uses. `KeyMissingError` maps to HTTP 409 with
`code: "key-missing"`.

Principals: each graph registry entry carries `signingPrincipal`
(memory graphs default `owner`; repo graphs are registered with a
graph-specific name). The web reads it via `useActiveGraphPrincipal()`.
Never hardcode `"owner"` as the acting principal.

## Pierre components — hard-won behavior

`@pierre/diffs` and `@pierre/trees` render imperatively into shadow DOM.
The React wrappers mount once and do not reliably repaint on prop changes,
and happy-dom cannot render them, so unit tests mock them and prove
nothing about real behavior. Rules:

- `CodeView`: pass a `key` that changes when anything it must repaint
  changes (diff style, annotations fingerprint). `enableLineSelection`
  defaults to FALSE — set it in `options` or selection callbacks never
  fire. `CodeView.scrollTo` is a no-op when the page is the scroll
  container; use per-file wrapper divs + `scrollIntoView`.
- `PierreTree` (our wrapper over `@pierre/trees`): the virtualized list
  needs an explicit `height` prop at EVERY call site; the `100%` default
  collapses to zero rows in an unconstrained parent and the tree renders
  nothing. `selectedPath` is initial-only (the library has no reactive
  selection API).
- When a change depends on real Pierre behavior, verify against the
  installed `.d.ts` and dist source in `node_modules/@pierre/*/dist` —
  not docs, not memory — and say in your report that browser verification
  is still needed.

## Web conventions

- Vocabulary in user-visible copy: saved / pending / staged and
  approved / rejected / incomplete. Never admitted / held. Captions are
  plain declarative prose ("Binary file."), no reassurance register.
- Theme: `data-theme` attribute on the document element; follow the
  `activeTheme()` pattern used by `PierreDiff.tsx`.
- Query keys: every graph-scoped query key includes the active graph id,
  or switching graphs serves stale data from the cache.
- Mutations that change what a button shows must update the query cache
  optimistically (see the decide flow in `lib/hooks.ts`); invalidation
  alone leaves a window where the UI flashes back to the pre-action state.
- localStorage keys are namespaced `freehold:*` or `freehold-*`; check for
  an existing key before inventing one.
- Test mocks for Pierre components follow the established patterns
  (`data-testid="pierre-diff"` pre blocks; PierreTree as a flat button
  list) — copy them from an existing test, do not invent new shapes.

## Test fixtures

Any fixture that creates a git repo MUST use `git init -b main` — CI
runners default to `master` and the suite breaks only in CI. Track every
temp directory a test creates and remove it in `afterEach`.

## Process

- All implementation work happens in git worktrees under
  `.claude/worktrees/`, one branch per task, merged back to `main` after
  gates pass. Never commit directly to `main` except docs.
- Git stashes are SHARED across all worktrees of this repo. Never
  `git stash pop` in a worktree unless you created that stash in the same
  session — popping someone else's stash silently mixes stale work into
  your branch.
- Nothing is pushed to origin without explicit authorization from the
  repo owner.
- Specs live in `docs/specs/`, implementation plans in
  `docs/superpowers/plans/`.

## Deploy checklist (local daemon)

1. Merge to `main`, gates green (including the web suite — see above).
2. `pnpm -r build`.
3. Restart the daemon: kill the listener on the configured port
   (`lsof -tnP -iTCP:8710 -sTCP:LISTEN`), then
   `cd packages/api && pnpm exec tsx src/cli/index.ts serve`.
4. Wait for `listening`, then verify with a request; the proposal
   pre-warm finishes in the background.
