# core-021 task report

## Status: PASS

## Commit

`2d50659` — `fix(core): pass host key_id to commit_payload — signed artifact writes work on repo graphs`

Branch: `core-021`

## What was done

**Step 1**: Vendored `allod-core-0.2.1.tgz` into `vendor/` and updated `packages/core/package.json` to use `file:../../vendor/allod-core-0.2.1.tgz`.

**Step 2**: Added `keyIdFor(key, allodGraphId, opts?)` to `keys.ts` — reads key_id from the resolved key location without signing.

**Step 3**: Updated `gitreview.ts`:
- `wasmCommitPayload` accepts optional `keyId?: string` parameter, passes `keyId ?? null` as 4th arg
- `signedCommit` reordered: resolve key → `keyIdFor` → `commit_payload(…, keyId)` → sign → commit_signed

**Step 4**: Updated `codecomments.ts`:
- Same `wasmCommitPayload` update
- `postCodeComment` reordered: resolve key → `keyIdFor` → `commit_payload(…, keyId)` → sign → commit_signed

**Step 5**: Added tests:
- `gitreview.test.ts`: new `postReview — host-managed key` describe block with its own fixture
- `codecomments.test.ts`: new `postCodeComment — host-managed key` describe block reusing existing fixture

## Test summary

```
Test Files: 21 passed (21)
Tests: 217 passed | 1 skipped (218)
Duration: ~26s
```

All 217 tests pass. The 1 skip is pre-existing.

## Live verify

Script: `scripts/verify-signing.ts`

Ran against the allod repo at `/Users/conner/code/allod`, sha `354aef977f20d896056478bb9498bfb8d0b2f873`, author `conner` (key resolved from XDG `~/.local/share/allod/keys/`).

```
reviewId: 836c2b64-a30e-493b-8e28-07ae2070b0ee
status:   saved
commentIds: ["0cc8c88c-3a2b-474d-a980-c102f0ebda37"]
listReviewsForSha: found review verdict=approve-with-comments comments=1
=== PASS ===
```

## Key files changed

- `/Users/conner/code/freehold/.claude/worktrees/core-021/vendor/allod-core-0.2.1.tgz`
- `/Users/conner/code/freehold/.claude/worktrees/core-021/packages/core/package.json`
- `/Users/conner/code/freehold/.claude/worktrees/core-021/packages/core/src/keys.ts`
- `/Users/conner/code/freehold/.claude/worktrees/core-021/packages/core/src/gitreview.ts`
- `/Users/conner/code/freehold/.claude/worktrees/core-021/packages/core/src/codecomments.ts`
- `/Users/conner/code/freehold/.claude/worktrees/core-021/packages/core/tests/gitreview.test.ts`
- `/Users/conner/code/freehold/.claude/worktrees/core-021/packages/core/tests/codecomments.test.ts`
- `/Users/conner/code/freehold/.claude/worktrees/core-021/scripts/verify-signing.ts`
