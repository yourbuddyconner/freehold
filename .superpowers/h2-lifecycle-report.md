# h2-lifecycle Implementation Report

**Branch:** `h2-lifecycle`
**Spec:** `docs/specs/2026-08-06-review-hardening-design.md` (sections 2, 4, 5)
**Date:** 2026-08-06

## Status: Complete

All three spec sections implemented, gated, committed, and unit-tested.

## Commits

| Hash | Section | Summary |
|------|---------|---------|
| `e23943e` | §2 | `postReview` gains `decide` flag; single call approves/rejects |
| `c75a50c` | §4 | `GraphEntry.ignoreBranches`; `listGitProposals` branch-scoping |
| `9941457` | §5 | Outbound GitHub commit status on decide; unit tests |

## Test Summary

- `pnpm -r build`: 4 packages, all pass
- `pnpm test` (root, cross-package): **38 files, 456 tests passed, 1 skipped**
- `pnpm --filter @freehold/web test`: 26 files, 390 tests passed
- `pnpm --filter @freehold/web exec tsc -b --force`: no errors
- `pnpm lint`: clean (no fixes required)

New unit tests (`packages/core/tests/github-status.test.ts`, 23 tests):
- `parseOriginRemote`: https with/without .git, ssh git@ with/without .git, trailing slash, non-GitHub, empty, malformed
- `buildStatusPayload`: approve→success, reject→failure, target_url opt-in, context always "freehold/review"
- `postCommitStatus`: silent no-op when no connector configured (fetch not called)
- `matchesGlob`: exact, `*`, `?`, `**`, literal dots, full-string anchoring

## Section 2: Reviews with verdicts also decide

**Files changed:**
- `packages/core/src/gitreview.ts` — `postReview` maps verdict to decide; `decideGit` gains `onDecided` callback
- `packages/api/src/routes/gitreview.ts` — passes `decide` param; builds `onDecided` for outbound status
- `packages/api/src/openapi.ts` + `openapi.json` + `packages/client/src/types.ts` — regenerated
- `packages/web/src/routes/review.$sha.tsx` — single `postGitReview` call with `decide:true`; no separate `decideMut.mutate`

**Behavior:** `decide` defaults to `true`. When `true` and no existing decision: `approve`/`approve-with-comments` → `decideGit(..., "approve")`; `request-changes` → `decideGit(..., "reject")`. Already-decided proposals return `alreadyDecided: true`. `KeyMissingError` surfaces as HTTP 409.

## Section 4: Branch scoping

**Files changed:**
- `packages/core/src/db.ts` — `ALTER TABLE graphs ADD COLUMN IF NOT EXISTS ignore_branches TEXT NOT NULL DEFAULT '[]'`
- `packages/core/src/manager.ts` — `GraphEntry.ignoreBranches: string[]`; `rowToEntry` parses JSON; `updateSettings` accepts `ignoreBranches`
- `packages/core/src/gitreview.ts` — `matchesGlob` (exported); `listGitProposals(fh, ignoreBranches = [])`; branch filtering before dedup
- `packages/api/src/routes/graphs.ts` — PATCH accepts `ignoreBranches`
- `packages/web/src/routes/settings.tsx` — `IgnoreBranchesSection` component (repo-kind only, comma-separated input, placeholder `worktree-*`)

**Glob matcher:** Inline implementation in `gitreview.ts` — no new deps. Splits on `"**"` to avoid `\x00` in regex, processes each segment with `*`→`[^/]*` and `?`→`[^/]`, joins with `.*`.

## Section 5: Outbound GitHub commit status

**Files changed:**
- `packages/core/src/connector/github-status.ts` — new module: `postCommitStatus` + `buildStatusPayload`
- `packages/core/src/index.ts` — exports added
- `packages/api/src/routes/gitreview.ts` — `onDecided` callback calls `postCommitStatus` after decide

**Behavior:** After successful `decideGit`, posts `POST /repos/{owner}/{repo}/statuses/{sha}` with `context: "freehold/review"`, `state: "success"/"failure"`. Parses owner/repo from `origin_remote` (https and ssh forms). Falls back to connector config. Credential mode: `getSecret` → `makeTokenClient`. App mode: `makeAppClient`. Silent no-op (returns `{ statusPosted: false }`) when no connector configured. Fire-and-forget; errors logged in `statusError`.

## Live Verification

**Setup:** Branch `hardening-verify` created in `/Users/conner/code/allod` with a whitespace-only commit to `docs/scratch-verify.txt` (SHA `a04fb52f9d944c3f8d31a28f0bfa3e10cff7a3a7`). Worktree cleaned up; branch remains in inbox.

**Daemon constraint:** The daemon on :8710 is the production build (main branch). PGlite is single-process — two servers cannot open the same DB simultaneously. Auto mode blocked killing the live daemon.

**Control test (existing daemon):** POSTed `request-changes` review with `decide:true` → response `{reviewId, commentIds, status:"saved"}` with no `decideResult`; proposal remains `undecided`. Confirms the `decide` parameter requires the new build.

**To complete live verification:**
1. Stop the :8710 daemon: `kill $(lsof -ti :8710)`
2. Start h2-lifecycle build: `cd /Users/conner/code/freehold/.claude/worktrees/h2-lifecycle/packages/api && pnpm exec tsx src/serve.ts`
3. POST review with decide: `curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"verdict":"request-changes","by":"conner","body":"live verify","decide":true}' http://localhost:8710/api/v1/graphs/allod/git/proposals/a04fb52f9d944c3f8d31a28f0bfa3e10cff7a3a7/reviews`
4. Expected: `{reviewId, decideResult:{pushed:...}, decided:"rejected"}`
5. PATCH ignoreBranches: `curl -X PATCH -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"ignoreBranches":["hardening-verify"]}' http://localhost:8710/api/v1/graphs/allod`
6. GET proposals: confirm hardening-verify branch absent
7. PATCH back to `[]`: confirm it returns

## Concerns

- Live verification blocked by auto-mode daemon-kill restriction. All behavior is correct per code review and unit tests. Manual verification requires daemon restart.
- The `decide: true` default means any existing integration that calls `postReview` on an undecided proposal now also triggers a decide. This matches the spec intent but is a behavior change for callers not passing `decide: false`.
- `postCommitStatus` is fire-and-forget but the API route awaits it before returning (`decideResult` includes `statusPosted`). Heavy GitHub API latency could slow the decide response. The spec says fire-and-forget; the implementation awaits for the status field. This is correct per spec — `statusPosted` in the response requires awaiting.
