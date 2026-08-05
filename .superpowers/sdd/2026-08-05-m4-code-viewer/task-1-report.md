# Task 1 Report — codeview.ts core module

## Status: complete

**Commit:** `f5efdb2`  
**Test summary:** 24 passed, 0 failed (codeview.test.ts)

## What was built

`packages/core/src/codeview.ts` — five exported async functions:

- `codeTree(fh)` — nested dir tree from `code/SourceFile` nodes; dir terms = union of descendant file terms
- `codeFile(fh, path)` — per-file view with items via `code/declares` edges; null for unindexed paths
- `codeItem(fh, nodeId)` — item view with callers (`code/calls` pointing in) and callees (`code/calls` from)
- `codeNeighborhood(fh, path)` — file + declared items + one hop of calls edges
- `codeRegions(fh, repoName)` — git_checklist per path, grouped by rule; cached by (graphId, log length)

All PGlite reads are lock-free; all wasm calls go through `withGraph`. No policy logic in TS.

## Key decisions

- `edgeBaseType()` strips `code/` prefix and `@1` version suffix to match on `"declares"` / `"calls"` regardless of fully-qualified name in PGlite.
- `codeRegions` cache key is `graphId:logLength`; log length obtained via a single `withGraph(log())` call — cheapest available head accessor already used by the indexer cursor.
- Region metadata (region name, reviewers) extracted from the `checklist` array returned alongside `matched` by `git_checklist`.

## Test fixture notes

- Security taxonomy installed via `install_package` with composite `taxonomy:` YAML (not `installOntology`), matching the format expected by the wasm engine.
- `syncIndex` requires an `Embedder` argument; test passes `hashEmbedder`.
- Both path rule (`src/**`) and region rule (`security/critical`) are verified to match/not-match correctly.

## Concerns

None. All 24 tests pass including the region/cache tests. The `regionsCache` is module-level and will accumulate entries across long-running processes, but with O(paths × rules) entries per graph state it poses no practical risk in the current usage pattern.

## Post-review fixes (2026-08-05)

Applied four fixes from the Task 1 review:

1. **Vacuous test assertion** (`codeview.test.ts` ~line 477): added `expect(regionRule, "region rule not found").toBeDefined()` before the non-matching-path exclusion check and made the `expect(...).not.toContain(...)` assertion unconditional — the prior `if (regionRule)` guard silently passed when `codeRegions` returned nothing.
2. **Cache poisoning on error** (`codeview.ts` ~lines 439-446): removed the `try/catch` around the `log()` wasm call that mapped errors to `logLength = 0`, which permanently fixed the cache key at `<graphId>:0` and prevented invalidation after recovery. Errors now propagate.
3. **`as unknown` cast comment** (`codeview.ts`): added a one-line comment at both `as unknown as { log()... }` and `as unknown as { git_checklist... }` casts explaining the method exists on the wasm instance but is absent from the re-exported TS type.
4. **`codeNeighborhood` dedup** (fix 4): skipped — deduplying `queryTermsById`/`queryEdges` from `codeFile` vs `codeNeighborhood` requires splitting the `codeFile` public API into a lower-level helper; assessed as invasive and deferred.

All 24 codeview tests pass; root `pnpm test` 231 passed, 1 skipped.
