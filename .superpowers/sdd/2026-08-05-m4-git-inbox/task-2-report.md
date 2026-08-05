# Task 2 Report — Git Proposal API Routes + Client

## Status: Complete

## Files Changed

**Created:**
- `packages/api/src/routes/gitreview.ts` — all 5 route handlers
- `packages/api/tests/gitreview.test.ts` — 24 tests

**Modified:**
- `packages/api/src/app.ts` — mount gitreviewRouter in buildApiRoutes()
- `packages/api/src/openapi.ts` — 9 new schemas + 5 route registrations; also added CodeNeighborhood + /api/v1/code/neighborhood (restoring a schema that existed in the committed openapi.json but was absent from openapi.ts)
- `packages/api/openapi.json` — regenerated
- `packages/client/src/client.ts` — 9 new type exports + 5 new client methods
- `packages/client/src/types.ts` — regenerated from openapi.json
- `packages/core/src/gitreview.ts` — added listReviewsForSha() + ReviewEntry/ReviewCommentEntry types
- `packages/core/src/index.ts` — exports listReviewsForSha, ReviewEntry, ReviewCommentEntry

## Routes Implemented

- `GET /git/proposals` → `{ proposals: GitProposal[] }` — scoped; 400 on memory graphs
- `GET /git/proposals/:sha` → GitProposal | 404
- `POST /git/proposals/:sha/decide` body `{ verdict, by }` → DecideResult; KeyMissingError → 409 `{ error, code: "key-missing" }`
- `POST /git/proposals/:sha/reviews` body `{ verdict, body?, by, comments? }` → creates Review@1 node then per-comment: ReviewComment@1 + part_of edge (endpoints before edges); returns `{ reviewId, commentIds, status }` in saved/pending vocabulary
- `GET /git/proposals/:sha/reviews` → `{ reviews: ReviewEntry[] }` — scans admitted changesets via wasm graph.log() + YAML parse (no PGlite dependency; available immediately after write without syncIndex)

## Key Design Decision

The GET reviews route reads directly from admitted changeset YAML files via `listReviewsForSha()` in core (which has js-yaml available), rather than querying PGlite. This avoids the need to call syncIndex before reviews are queryable and keeps the API honest about what's in the graph.

## Test Summary

28 test files, 288 tests passed, 1 skipped (pre-existing) — `pnpm test` green.
New file: 24/24 tests passing.
web tsc -b --force: zero errors.

---

## Review Findings Fixed (2026-08-05)

### Critical

1. **Held reviews invisible to GET** — `listReviewsForSha` only scanned admitted changesets; reviews in the pending/held governance queue were never surfaced and their status was hardcoded "saved". Fixed by also iterating `graph.proposals()` + `proposal_get(hash)` inside `withGraph`, extracting review ops from each pending changeset, and marking them `status: "pending"`. The op-parsing logic was extracted into `parseChangesetOps()` shared by both paths.

2. **commit attribute stored as bare sha** — The ontology's canonical external-ref format is `git:<repo>#<sha>`. The POST reviews route now constructs `git:${basename(fh.graphDir)}#${sha}` and stores that as the `commit` attribute. Matching in `listReviewsForSha` accepts both the canonical form and the bare sha (back-compat).

3. **POST reviews must 404 on unknown shas** — Added a `gitProposal(fh, sha)` guard before creating any nodes; returns 404 if the sha is not a known git proposal.

### Minor

4. **Decide test exact outcome** — Changed `expect(["approved","incomplete"]).toContain(b.outcome)` to `expect(b.outcome).toBe("approved")` in the approve test; likewise the re-list check now asserts `decided === "approved"` exactly.

5. **Note-persistence assertion** — Added a test after decide that runs `git notes --ref=allod-decisions show <featureSha>` against the scratch repo and asserts the note is non-empty.

6. **GET reviews round-trip** — Added a test asserting comment count (1), body ("Nice change"), and anchor value match what was POSTed. Also changed the commit field assertion from `toContain(mainSha)` to exact `toBe(\`git:${repoBasename}#${mainSha}\`)`.

7. **featureSha GET asserts empty** — Changed from "could be empty or have reviews; just verify shape" to `expect(b.reviews.length).toBe(0)`.

Also added: POST reviews 404 test for unknown sha.

### After-fix test summary

28 test files, 291 tests passed, 1 skipped — `pnpm test` green.
`pnpm --filter @freehold/web exec tsc --noEmit`: zero errors.
