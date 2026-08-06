## h4-apply: §6c apply suggestion as a commit

**Status: done**

### Commit

`12c9a8a` on branch `h4-apply`

### What shipped

- `packages/core/src/gitapply.ts` (new) — `applySuggestion` using pure git plumbing: `hash-object -w --stdin` → scratch-index `read-tree` / `update-index --index-info` / `write-tree` → `commit-tree` → `update-ref` with old-value guard. Exports `BranchMovedError`, `BinaryFileError`, `OldSideSpanError`, `InvalidSpanError`.
- `packages/core/tests/gitapply.test.ts` (new) — 12 fixture-repo tests.
- `packages/core/src/index.ts` — re-exports the new module.
- `packages/api/src/routes/gitreview.ts` — POST `/git/proposals/:sha/suggestions/apply` added at end of file.
- `packages/api/src/routes/gitreview.apply.test.ts` (new) — 11 route tests (mocked core).
- `packages/api/src/openapi.ts` — `ApplySuggestionBody` / `ApplySuggestionResult` schemas + route; also back-fills `CodeComment` / `PostCodeCommentBody` / `PostCodeCommentResult` (were missing, causing types drift).
- `packages/api/openapi.json` — regenerated.
- `packages/client/src/types.ts` — regenerated.
- `packages/client/src/client.ts` — `applyGitSuggestion()` method + type re-exports.
- `packages/web/src/routes/review.$sha.tsx` — "Apply as commit" button on saved suggestion cards; shows "Committed <sha7>." on success, error text on failure; invalidates git-proposals / git-proposal / git-reviews queries.
- `packages/web/src/routes/review.$sha.test.tsx` — 4 new web tests.

### Test summary

457 tests total: **456 passed, 1 skipped**, 0 failed — 39 test files.

Gates per AGENTS.md:
- `pnpm -r build` ✓
- `pnpm test` ✓ (all 457)
- `pnpm --filter @freehold/web exec tsc -b --force` ✓
- `pnpm lint` ✓

### Live verification

Called `applySuggestion` directly from the worktree dist against `/Users/conner/code/allod`, branch `review-demo-3`, tip `460b29198b321274799e0db4629439e6ada089d6`, file `crates/allod-core/src/hash.rs`, span `L14`.

**newSha = `9ef790e64bf75ea50595d0e3bb0625461740958a`**

Branch tip confirmed at that SHA; `git log` shows the apply commit atop `460b291`.

(The running daemon has the old code and cannot be restarted from auto-mode. Core plumbing verified directly; HTTP path covered by the 11 route tests.)

### Concerns / notes

- The `execFile`/`execFileAsync` family does not support stdin input; any use of `git hash-object -w --stdin` with promisified execFile hangs. The `git()` helper uses `spawn` with explicit `child.stdin.write` + `child.stdin.end()`.
- `git rev-parse --end-of-options <ref>` echoes the flag in stdout. Removed `--end-of-options` from rev-parse calls; refs are safe (validated by `assertSafeRef`).
- `PostCodeCommentResult.status` must be `z.enum(["saved","pending"])`, not `z.string()`, to satisfy the web typecheck in `code.file.tsx`.
