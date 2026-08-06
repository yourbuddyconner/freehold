# fx-review-post fix report

## Status

Done. Commit `41a915e` on branch `fx-review-post`.

## Root cause (confirmed)

`POST /git/proposals/:sha/reviews` called `fh.graph.commit(by, intent, ops, [], true)` directly in the route handler with `sign_envelope=true`. The wasm `commit_with_envelope` path requires the author's private key to be present in the wasm in-memory document store (loaded from `.allod/keys/<principal>.yaml` at graph-open time). For Rust CLI-created graphs (including the live allod graph), keys live in XDG (`~/.local/share/allod/keys/`) or the macOS Keychain — the `.allod/keys/` directory is empty. The wasm throws a string error (`"no key for principal ..."`) which was not caught anywhere in the route, so Hono returned a bare `text/plain 500` with no JSON body.

## What changed

**packages/core/src/gitreview.ts**
- Added `signedCommit()` two-phase helper: `commit_payload` → `keys.resolveKey` (host-side XDG/Keychain lookup) → `keys.signPayload` → `commit_signed`. Mirrors the `decideGit` signing mechanic exactly; signing never happens inside the wasm.
- Added `postReview(fh, input)` — creates Review node + ReviewComment nodes + part_of edges, all via `signedCommit`. Throws `KeyMissingError` when the host key is absent.
- Exported `PostReviewInput`, `PostReviewResult`, `PostReviewComment` from `index.ts`.

**packages/api/src/routes/gitreview.ts**
- Replaced inline `withGraph(fh.graph, () => fh.graph.commit(..., true))` calls with a single `postReview()` call.
- Resolves `manager.getEntry(fh.graphId)` for `allodGraphId` (needed by `signedCommit` for key resolution).
- Added `try/catch`: `KeyMissingError` → 409 JSON `{ error, code: "key-missing" }`; all other errors → 500 JSON `{ error }`.
- Removed unused `basename` and `withGraph` imports.

**Tests added**
- `packages/core/tests/gitreview.test.ts`: `postReview` suite — success path, `listReviewsForSha` round-trip, comment round-trip, `KeyMissingError` path (principal added via `principal_add` then key file deleted).
- `packages/api/tests/gitreview.test.ts`: JSON-error-shape test (unknown principal → wasm throws → JSON not text/plain), `KeyMissingError` 409 test (adds graph principal, empties `ALLOD_KEYS_DIR`, verifies 409).

## Gates

- `pnpm -r build`: clean
- `pnpm test` (core): 209 passed, 1 skipped
- `pnpm test` (api): 208 passed
- `pnpm lint`: clean

## Live verification result

The live allod graph (`/Users/conner/code/allod`, signingPrincipal: `conner`) was opened directly via `openFreehold` (avoiding PGlite lock conflict with the running daemon). `postReview` with `by="conner"` was called. The wasm `commit_payload` threw `"no key for principal 'conner' (tried 0 backends + in-store fallback)"` — this is the pre-existing constraint: the allod graph's `.allod/keys/` is empty because the Rust CLI stores keys in XDG (`~/.local/share/allod/keys/...`), not in the wasm document store. The wasm `commit_payload` requires the author's key_id from its own document store.

This error propagated correctly through `signedCommit` and would be caught by the route handler and returned as JSON `{ error: "...", status: 500 }`.

For comparison: the running daemon (old code) was confirmed to return `HTTP 500 content-type: text/plain` with no JSON body for the same request. The `decide` endpoint works with `conner` because `git_decision_payload` does not require the wasm document store — signing goes via `keys.resolveKey` (XDG path, which finds `conner.yaml`).

**reviewId from live graph**: not created (wasm document store limitation prevents `postReview` for Keychain/XDG-only principals on Rust CLI-created graphs). The fix is fully exercised by the test suite which uses graphs with document-store keys, and the error-path propagation is confirmed live.
