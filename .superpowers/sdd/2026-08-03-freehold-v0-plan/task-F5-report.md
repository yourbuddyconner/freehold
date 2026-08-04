# Task F5 Report — Generate the client and add the CLI

**Final Commit:** `7cd7b20` (review fixes)
**Initial Commit:** `2ff918b`
**Branch:** `v0`
**Date:** 2026-08-04

---

## What was built

### 1. `packages/client/` — Generated TypeScript client

| File | Description |
|------|-------------|
| `generate.ts` | Runs `openapi-typescript` against `packages/api/openapi.json`, writes `src/types.ts`. Supports `--check` mode for drift detection. |
| `src/types.ts` | 1271-line generated output from `openapi-typescript`. Never hand-edited. Excluded from biome formatting. |
| `src/client.ts` | `FreeholdClient` class: constructor `{ baseUrl, token }`, one method per API route (22 total), typed returns, throws `ApiError { code, message, status }` on error responses, returns held admission as-is (exit 2 handled at CLI layer). |
| `package.json` | `@freehold/client`, `type: "module"`, exports `./src/client.ts` (tsx-compatible). `check:drift` script wired into `build`. |
| `tsconfig.json` | Extends root `tsconfig.base.json`. |

**Drift check:** `pnpm build` runs `check:drift` which re-runs generate and diffs — fails on any mismatch.

### 2. CLI — `packages/api/src/cli/`

| File | Description |
|------|-------------|
| `index.ts` | Main entry, registered as `bin.freehold` in `packages/api/package.json`. Parses `--json`, `--help`, dispatches to command functions. |
| `config.ts` | Reads `$FREEHOLD_HOME/config.json` (or `~/.freehold/config.json`) for `{ port, token }`. Plain `fs` only, no `@freehold/core` import. |
| `run.ts` | Shared helpers: `makeClient`, `handleError` (maps `ApiError`/network errors to exit codes), `output` (json/human switch), `checkHeld` (exits 2). |
| `commands/serve.ts` | Boots daemon inline (exempt from import-boundary rule — only file that imports `@freehold/core`). |
| `commands/{status,remember,recall,pending,approve,reject,verify,reindex,mcp}.ts` | One file per command. All use `FreeholdClient` via `run.ts` helpers. |

**Exit codes:**
- 0 = ok
- 1 = other error
- 2 = held
- 3 = policy-rejected  
- 4 = auth failure (401/403)
- 5 = unreachable (ECONNREFUSED / network error)

**`mcp setup`:** Stub printing "MCP endpoint arrives in F6" (as specified).

### 3. Tests — `packages/api/tests/cli.test.ts`

13 tests across 4 suites:

1. **Founding loop** (8 tests): Spawns daemon on random port, drives CLI commands (`status`, `remember`, `recall`, `pending`, `verify`, `reindex`) in both human and `--json` modes. All pass.

2. **Exit-code matrix** (3 tests):
   - Bad token → exit 4 ✓
   - Daemon down (dead port) → exit 5 ✓
   - Held response → exit 2: drives CLI `remember --type memory/Preference@1` (no classification), asserts exit 2/0 ✓

3. **Import boundary** (1 test): Grep-scans all `src/cli/**/*.ts` for actual import statements from `@freehold/core`; `commands/serve.ts` explicitly exempt. ✓

4. **Client drift** (1 test): Runs `generate.ts --check`; fails if `src/types.ts` diverges from `openapi.json`. ✓

---

## Test results

```
Tests: 71 passed | 1 skipped (72 total)
Test files: 10 passed
pnpm typecheck: clean
pnpm lint: clean (67 files checked)
pnpm build: clean (check:drift passes)
```

---

## Review Fixes (Commit 7cd7b20)

1. **Held → exit 2 test**: F5 review identified that the test never actually ran the CLI. Fixed by:
   - Adding `--type <type>` and `--classify <term>` flags to CLI `remember` command (passthrough to `createEntity`)
   - Updated test to drive genuine held write: `freehold remember "prefers tea" --type memory/Preference@1`
   - Asserts exit code 2 (held) or 0 (admitted) depending on policy, no tautological HTTP checks

2. **generate.ts diff fragility**: Replaced shell `diff <(echo JSON)` with temp-file writes + `diff`, eliminating bash process substitution issues and avoiding JSON quoting edge cases.

3. **Minor cleanups**:
   - Removed unused `stderr` capture in bad-token test
   - Added workspace-only assumption comment to `client.ts` exports (pre-F10 bundle caveat)

## Original Deviations

1. **`serve` command imports `@freehold/core`**: The brief says "CLI files must NOT import `@freehold/core` directly", but `serve` must boot the server. Resolution: `commands/serve.ts` re-implements the serve logic inline (identical to `serve.ts`) and is explicitly exempt from the import-boundary test with a comment. This matches the intent (CLI network commands don't touch core) while keeping `serve` functional.

2. **`types.ts` excluded from biome**: `openapi-typescript` uses 4-space indentation; biome uses 2-space. Added `packages/client/src/types.ts` to biome's ignore list to prevent the formatter from modifying the generated file and breaking drift checks.

---

## Post-review assertion tightening (Commit c9f5c6e)

Following the initial review, three vacuous CLI test assertions were tightened per the memory policy:

1. **"remember stores a note"** (line 145-155): Plain `remember` writes to scratch path with CLI default agent → deterministically admitted. Changed `expect([0, 2]).toContain(code)` to `expect(code).toBe(0)`.

2. **"remember --json"** (line 157-167): Same scratch-path behavior with JSON output. Changed `expect([0, 2]).toContain(code)` to `expect(code).toBe(0)` and `parsed.status` to `expect(parsed.status).toBe("admitted")`.

3. **"held response → exit code 2"** (line 227-251): AGENT-authored writes with `memory/Preference@1` type (non-scratch) are deterministically held under governance rules. Changed `expect([0, 2]).toContain(code)` to `expect(code).toBe(2)` and removed vacuous both-paths-valid comments (lines 241-243, 249).

**Test results post-tightening:**
- `pnpm --filter @freehold/api test`: 13 tests ✓
- `pnpm -r test`: 72 tests ✓ (41 core + 30 api, 1 skipped)
- `pnpm typecheck`: clean
- `pnpm lint`: 67 files, no issues

All three assertions pass, confirming behavior matches policy.

## Key files

- `/Users/conner/code/freehold/packages/client/src/client.ts`
- `/Users/conner/code/freehold/packages/client/generate.ts`
- `/Users/conner/code/freehold/packages/api/src/cli/index.ts`
- `/Users/conner/code/freehold/packages/api/src/cli/run.ts`
- `/Users/conner/code/freehold/packages/api/tests/cli.test.ts`
