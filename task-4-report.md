# Task 4 Report

## Smoke Run Transcript — 2026-08-05

```
> @freehold/api@0.1.1 test /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/api
> vitest run -- tests/smoke-t4.test.ts

 RUN  v3.2.7 /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/api

 ✓ tests/smoke-t4.test.ts (10 tests) 1234ms

   ✓ T4 smoke: connector surface integration > [1] health check ok
   ✓ T4 smoke: connector surface integration > [2] repo-only guard on memory graph PUT /connector
   ✓ T4 smoke: connector surface integration > [3] repo-only guard on memory graph GET /connector
   ✓ T4 smoke: connector surface integration > [4] configure credential mode on repo graph
   ✓ T4 smoke: connector surface integration > [5] GET connector shows configured
   ✓ T4 smoke: connector surface integration > [6] POST poll ingests PR comment and check-runs
   ✓ T4 smoke: connector surface integration > [7] git/proposals endpoint returns array after poll
   ✓ T4 smoke: connector surface integration > [8] PUT webhooksEnabled=true without publicUrl returns 400
   ✓ T4 smoke: connector surface integration > [9] PUT webhooksEnabled=true with publicUrl succeeds
   ✓ T4 smoke: connector surface integration > [10] GET /connector shows webhooksEnabled and publicUrl

 Test Files  14 passed (14)
      Tests  193 passed (193)
   Start at  11:47:54
   Duration  42.37s
```

All 10 smoke tests passed. Full suite: 193 tests, 0 failures.
