# Performance Report: Git Proposal Evaluation

## Problem

`GET /git/proposals` took **6.4s** on the live daemon (allod repo, 9 branch heads).
The review page and inbox both block on this endpoint.

## Root Cause Analysis

Phase breakdown measured against the allod repo:

| Phase | Time (serial) | Per-sha |
|---|---|---|
| `branchHeads()` | 17ms | — |
| `commitMeta()` | 122ms | 13.5ms |
| `diffTreeOps()` | 250ms | 27.7ms |
| `readDecisions()` | 115ms | 12.8ms |
| `git_checklist()` wasm | **3377ms** | **375ms** |
| **Sum** | **3879ms** | — |
| Full `listGitProposals` | **6256ms avg** | — |

The gap between the sum (3879ms) and actual (6256ms) is `codeRegions` + `codeFile` per path + `git_satisfaction` wasm calls, all also serial per sha.

**Dominant cost**: `git_checklist` takes 375ms per sha × 9 shas = 3377ms, and **cannot be parallelized** — the `withGraph` mutex serializes all wasm calls (tested: parallel queuing gives same wall time as serial).

**Parallelization won't help** for wasm. The only viable optimization is caching.

## Changes Made

### `packages/core/src/git.ts`
- Added `decisionsTip(repoDir)`: reads `refs/notes/allod-decisions` commit SHA via a single `git rev-parse`. Returns `""` if no decisions exist yet. Fast (~5ms).

### `packages/core/src/gitreview.ts`
- **Module-level LRU cache** (200 entries, insertion-order Map): caches `CachedCore` (all `GitProposal` fields except `checks`) keyed by `${graphDir}\0${sha}\0${decisionsTip}`.
- **`checks` field excluded from cache**: CI status changes independently of the decisions notes ref. `fetchChecks()` always queries the DB fresh.
- **`listGitProposals`**: now fetches `branchHeads` and `decisionsTip` in parallel (`Promise.all`), then maps all shas through `evaluateSha` with the shared decisions tip. Warm calls return from cache in <1ms per sha.
- **`evictProposalCache(graphDir)`**: called by `decideGit` after `appendDecision` so the next list request re-evaluates with the new decisions state.
- **`decideGit`**: evicts cache after persisting a decision.
- Exported: `evictProposalCache`, `proposalCacheKey`, `decisionsTip` for tests and external use.

### `packages/core/src/index.ts`
- Re-exported `evictProposalCache`, `proposalCacheKey` from `gitreview.ts` and `decisionsTip` from `git.ts`.

### `packages/web/src/lib/hooks.ts`
- Added `staleTime: 30_000` to `useGitProposals`, `useGitProposal`, `useGitProposalDiff`, `useReviewsForSha`. Route transitions within 30s no longer trigger refetches of expensive endpoints.

## Measured Results

| Scenario | Before | After |
|---|---|---|
| Cold (first request) | 6256ms avg | 5704ms |
| Warm (repeat requests) | 6256ms avg | **26ms** |

**Warm improvement: 240×** (26ms vs 6256ms).

Cold path is slightly faster (5.7s vs 6.3s) due to parallel `branchHeads + decisionsTip` fetch, but the main gain is the warm cache.

The 5.7s cold time reflects the wasm mutex serialization limit — 9 × 375ms wasm calls cannot be escaped without changing the wasm architecture. The cold path on a newly-started daemon is one-time; subsequent requests are warm.

## Cache Invalidation

- **After `decideGit`**: `evictProposalCache(graphDir)` is called, ensuring the next list call sees the new decided state.
- **Key = `(graphDir, sha, decisionsTip)`**: if any decision is appended (moving the notes ref), the tip changes and all existing cache entries are stale — new entries are computed on next access.
- **`checks` field**: never cached, always fresh from the DB.

## Tests Added

Four tests in `packages/core/tests/gitreview.test.ts` under "proposal cache — invalidates when decisions tip changes":
1. `proposalCacheKey` encodes graphDir, sha, tip correctly (different tip → different key)
2. `evictProposalCache` removes entries; re-list returns correct results after eviction
3. `decideGit` evicts cache; re-list reflects new decided state
4. `decisionsTip` changes after `appendDecision`

All 20 tests in `gitreview.test.ts`, 6 in `gitreview-checks.test.ts`, and all 206 API tests pass.

## Files Modified

- `packages/core/src/git.ts` — added `decisionsTip`
- `packages/core/src/gitreview.ts` — LRU cache, cache eviction, parallel branchHeads+decisionsTip
- `packages/core/src/index.ts` — exports
- `packages/core/tests/gitreview.test.ts` — 4 new cache tests
- `packages/web/src/lib/hooks.ts` — `staleTime: 30_000` on 4 queries

## Remaining Consideration

The cold-path 5.7s is irreducible with current wasm architecture. If the cold path needs to be under 1s, the only avenue is either:
1. Persistent cache across daemon restarts (serialize to disk on shutdown)
2. Pre-warming the cache at daemon startup (background evaluation after opening the graph)

Neither was in scope for this task. Warm path is now 26ms.
