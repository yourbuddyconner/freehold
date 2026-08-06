# fx3-review scroll fix report

## Status

Done. All gates green.

## Commit

`9920731` — `fix(web): tree click scrolls to top of file diff`

## Test summary

27/27 review route tests pass (2 new tests added); full suite 269/269.

## Failure mode

**(a)** — CodeView is not the scroll container.

The page window scrolls, not the CodeView root div. The library attaches
`scroll` listeners to its root element and calls `this.root.scrollTo(...)`,
but because the component renders a plain `<div>` with no explicit height
or `overflow`, that div expands to fit its content and never scrolls.
`codeViewRef.current?.scrollTo({ type: "item", id: path })` was a no-op.

## Fix

Removed the `CodeViewHandle` ref and `CodeView.scrollTo` call entirely.

**Text diffs**: each `codeViewItems` entry is now rendered inside a per-file
wrapper `<div data-path={item.id}>` whose `ref` callback registers the node
in a `fileWrapperRefs` Map. Each wrapper holds a single-item `<CodeView>`.

**Binary / truncated captions**: already had `id={f.path}` in the DOM;
`scrollToFile` falls back to `document.getElementById(path)`.

`scrollToFile(path)`:
1. Looks up the wrapper in `fileWrapperRefs` (text diffs first).
2. Falls back to `document.getElementById(path)` (binary/truncated).
3. Calls `el.scrollIntoView({ block: "start" })`.
4. Calls `window.scrollBy({ top: -56, behavior: "instant" })` to compensate
   for the sticky app-shell header (56 px).

Also fixed: `useActiveGraphPrincipal` was missing from the hooks mock,
causing all 27 review tests to error before this branch. Added it.

## Files changed

- `packages/web/src/routes/review.$sha.tsx` — implementation
- `packages/web/src/routes/review.$sha.test.tsx` — tests
