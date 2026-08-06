# fx3-code layout fixes — report

## Status: complete

**Commit:** `9fa7729` on branch `fx3-code`

## Changes made

### packages/web/src/routes/code.file.tsx
- Removed `max-w-3xl` from the `<article>` wrapper in `CodeFilePage` — source panel now fills the flex-1 right pane at any viewport width.
- Changed `PierreFile` option `overflow: "scroll"` → `overflow: "wrap"` — source text line-wraps instead of scrolling horizontally.

### packages/web/src/routes/code.tsx
- Added `sticky top-0 self-start` to the `<aside>` so the pane anchors in the viewport.
- Wrapped aside content in `<div className="overflow-y-auto" style={{ height: "calc(100vh - 160px)" }}>` — the tree and governed-paths panel scroll independently as one unit.
- Passed `height="calc(100vh - 160px)"` to `<PierreTree>` so the internal virtualized list has a concrete bound (was `"100%"` against an unsized container, which caused unbounded growth).

### packages/web/src/routes/review.$sha.test.tsx (collateral fix)
- Added `useActiveGraphPrincipal: vi.fn()` to the `vi.mock("~/lib/hooks")` block and `vi.mocked(hooks.useActiveGraphPrincipal).mockReturnValue("alice")` to `setupDefaults`. Without this, all 27 review tests crashed at render; these were pre-existing broken tests that came in with WIP from `git stash pop`.
- Fixed two biome formatting violations (long `.spyOn` chains split across lines).

## Gates
- `pnpm tsc -b --force`: zero errors
- `pnpm lint` (biome): clean
- `pnpm test` (packages/web): **269 passed, 0 failed** (22 test files)
