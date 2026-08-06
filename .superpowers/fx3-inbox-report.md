# fx3-inbox implementation report

**Commit:** 85a07d0 on branch `fx3-inbox`

## Status: complete

All four fixes implemented and tested. Web tests clean (54 passing on my files, 0 failures). `pnpm biome check` clean. `tsc -b --force` zero errors.

---

## What was done

### 1. Approve button flash (useDecideProposal — hooks.ts)

`onMutate` now cancels in-flight refetches for both the list and single-proposal cache keys, snapshots the previous data, and writes an optimistic `decided` value (`"approved"` or `"rejected"`) to both caches immediately. On success, `invalidateQueries` is called with `refetchType: "none"` so the existing `staleTime: 30_000` carries the UI through the server-side recompute without triggering an immediate refetch. On error the snapshot is restored. The button is disabled once decided and the cache holds that state, so it never returns to clickable.

### 2. Graph-switch staleness (hooks.ts)

Introduced `keyFor(graphId, ...parts)` factory function (exported). Every graph-scoped query in hooks.ts now uses `keyFor(activeGraphId, ...)` instead of bare string arrays. Covered: `usePending`, `useRecall`, `useRecentMemories`, `useMemoryIndex`, `useMemoryGraph`, `useEntity`, `useUpdateMemory` invalidations, `useVerify`, `useSchema`, `usePolicy`, `useLog`, `usePrincipals`, `useCodeTree`, `useCodeFile`, `useCodeItem`, `useCodeRegions`, `useCodeNeighborhood`, `useCodeSource`, `useGitProposals`, `useGitProposal`, `useGitProposalDiff`, `useReviewsForSha`. `useSession`, `useListGraphs`, `useGraphs` are graph-agnostic and left unchanged. All invalidation calls in `inbox.tsx`, `GitProposalCard.tsx` (ReviewComposer and onDone) updated to use `keyFor`.

### 3. Bundle indication (GitProposalCard.tsx + inbox.tsx)

`inbox.tsx` groups proposals by `ref` and passes `bundleSize` and `bundleIndex` to each `GitProposalCard`. When `bundleSize > 1`, the first card in the bundle shows a "N commits" chip next to the ref name. A narrow left-rail (`w-0.5 bg-(--border)`) renders on the article's left edge for all cards in the bundle, matching the existing border/muted styling. Solo commits get no chip or rail.

### 4. Decided proposals filter (inbox.tsx)

A bundle is fully decided when every commit in it has `decided !== "undecided"`. Fully-decided bundles are hidden by default. A count line "N decided branches hidden" (uses "branch"/"branches" singular/plural) appears below the list with a show/hide toggle. When toggled on, all proposals including decided ones are listed. `/review/$sha` remains reachable for all proposals regardless of filter state.

---

## Test summary

54 tests across 4 files — 54 passed, 0 failed.

- `hooks.test.tsx` — added `keyFor` unit tests and a graph-switch key-change test
- `inbox.test.tsx` — added 5 bundle-display and decided-filter tests
- `GitProposalCard.checks.test.tsx` — updated mock to include `useActiveGraph` and `keyFor`
- `GitProposalCard.composer.test.tsx` — updated mock to include `useActiveGraph` and `keyFor`

The pre-existing `review.$sha.test.tsx` failures (26) are owned by another agent and were failing before this branch.

---

## Concerns

None blocking. One design note: `isBundleDecided` uses the full unfiltered `gitProposals` list (not `visibleGitProposals`) to compute bundle membership, which is correct — a bundle's decided-ness must be computed against all its commits, not just visible ones.
