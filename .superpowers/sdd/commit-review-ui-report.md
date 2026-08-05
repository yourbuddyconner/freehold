# commit-review-ui Implementation Report

## Status: Success

## Commits

```
513ffa5 feat(web): /review/$sha — full-page commit review with per-file diffs, checklist, review composer
a791039 feat(web): export card subcomponents; extract useDecideProposal hook; add Review link on card
1df1476 feat(api): GET /git/proposals/:sha/diff endpoint; regen client types + add gitProposalDiff method
fdff1ed feat(core): add commitDiff — per-file unified diff entries with 1 MB cap
```

## Test Summary

- Core: 194 passed (all commitDiff tests pass)
- API: 206 passed (all gitreview.diff tests pass)
- Web: 188 passed (all review page, card, and inbox tests pass)
- Build: `pnpm --filter @freehold/web build` succeeds (tsc + vite)
- Lint: `pnpm lint` passes (biome check)

## Tasks Completed

### Task 1: `commitDiff` in core
- Added `commitDiff(repoDir, sha)` to `packages/core/src/git.ts`
- Parses `git diff-tree -p` output into `FileDiffEntry[]`
- Handles root commits (--root), first-parent diffs, binary files, 1 MB size cap
- Exported `commitDiff` and `FileDiffEntry` from `packages/core/src/index.ts`
- 6 tests in `packages/core/tests/commitdiff.test.ts` — all pass

### Task 2: API diff endpoint + openapi + client
- Added `GET /git/proposals/:sha/diff` to `packages/api/src/routes/gitreview.ts`
- Returns `{ files: FileDiffEntry[], truncated: boolean }` with 1 MB cap check
- Added `FileDiffEntry` and `DiffResponse` schemas to `packages/api/openapi.json`
- Regenerated `packages/client/src/types.ts`
- Added `FileDiffEntry`, `DiffResponse` type exports and `gitProposalDiff()` method to `packages/client/src/client.ts`
- 5 tests in `packages/api/src/routes/gitreview.diff.test.ts` — all pass

### Task 3: Extract subcomponents + Review link + hooks
- Exported `ChecklistRow`, `PathRow`, `DecidedChip`, `ReviewComposer` from `GitProposalCard.tsx`
- Added `<Link to="/review/$sha">Review</Link>` button to card actions
- Extracted decide logic to `useDecideProposal(sha, by)` hook in `packages/web/src/lib/hooks.ts`
- Added `useGitProposalDiff(sha, enabled)` hook
- Updated `GitProposalCard.tsx` to use `useDecideProposal` hook
- Updated existing tests (`GitProposalCard.checks.test.tsx`, `inbox.test.tsx`) to work with new hook-based architecture
- All 178 web tests pass

### Task 4: Review page route
- Created `packages/web/src/routes/review.$sha.tsx` with full commit review UI
- Shows: commit header, decided chip, key-missing notice, checklist, incomplete outcome, saved-locally notice, touched paths, governance buttons (Approve dialog + Reject), review composer, per-file diffs with binary captions, truncated notice
- Runs inside AppShell (uses routeTree via TanStack Router plugin)
- `packages/web/src/routeTree.gen.ts` regenerated to include `/review/$sha`
- 10 tests in `packages/web/src/routes/review.$sha.test.tsx` — all pass

## Notes

- The plan's test file for commitDiff had a bug: `writeFileSync` was imported from `node:child_process` instead of `node:fs`. Fixed before implementing.
- Inbox tests that tested decide behavior end-to-end (key-missing, saved-locally, retry) were adapted to use the new `useDecideProposal` mock pattern since that logic was extracted to a hook.
- The GitProposalCard.checks.test needed a `Link` stub (mocking `@tanstack/react-router`) since the card now renders a Link that requires RouterProvider context.
- Web build uses TanStack Router Vite plugin to regenerate routeTree — `vite build` must be run before `tsc -b` succeeds when new routes are added.
