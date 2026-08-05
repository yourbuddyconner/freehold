
---

## Code Review Fixes — Commit 93847df

### What was implemented

**Fix 1 — events.ts dedup: object_get for current attributes**
`_findCommentByExternalIdSync` now calls `object_get("node", nodeId)` after finding the nodeId in the admitted log, to get current fold-state attributes. Investigation revealed that in the test environment (governance-locked graph), commits are Held (never admitted), so `object_get` always returns null. The scan-level fix is still correct for production (admitted graphs); see Fix 2 for the pending-node case.

**Fix 2 — Soft tombstone for pending nodes**
When a node is pending (not in fold state, `node_rev` returns null), the WASM update is skipped but tombstone intent is now recorded in a new `connector_soft_tombstone` PGlite table. On resurrection, the dedup check queries this table and bypasses the "unchanged" short-circuit, returning "updated" instead. The soft tombstone is cleared on successful resurrection update.

**Fix 3 — 401 test negative assertion**
Restructured the test to catch the error manually and assert `caught.message.not.toContain("bad-token")`.

**Fix 4 — Edit test nodeId assertion**
`editResult.nodeId === createResult.nodeId` now asserted.

**Fix 5 — check_status PGlite read-back**
Both check_status tests now query PGlite after `handleConnectorEvent` and assert stored `status` and `conclusion` values.

**Fix 6 — Remove unused TAG_LEN from config.ts**

**Fix 7 — Remove inline CREATE TABLE from upsertCheckStatus**
Table is managed by `db.ts`'s `openDb` and `config.ts`'s `ensureTables`.

**Fix 8 — parseOriginRemote non-GitHub test**
Added test asserting `https://example.com/owner/repo` and `https://gitlab.com/owner/repo` return null.

**Fix 9 — Remove unused imports**
`writeFileSync` and `mkdirSync` removed from connector-core.test.ts imports.

**New: connector_soft_tombstone table**
Added to both `db.ts` (openDb) and `config.ts` (ensureTables) so it's available in all code paths.

### Test result
329 passed, 1 skipped (pre-existing), 0 failed.
