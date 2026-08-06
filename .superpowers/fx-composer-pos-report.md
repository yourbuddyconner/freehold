# fx-composer-pos — Implementation Report

## Status: Complete

**Commit:** `f2fc68e` — `fix(web): line composer renders under the selected line`  
**Branch:** `fx-composer-pos`  
**Tests:** 376 passed (40 in review.$sha.test.tsx, up from 38), 0 failures  
**Lint:** biome check clean, 0 fixes applied  
**TypeScript:** tsc -b --force zero errors

## What changed

### `packages/web/src/routes/review.$sha.tsx`

- Added `kind: "composer"` to `AnnotationMeta` union type.
- Added `spanEndLine(span)` helper to extract the last line number from a span string (handles `"L5"`, `"L5-L9"`, `"old:L5-L9"`).
- `codeViewItems` memo now depends on `composerOpen`. When `composerOpen` targets a file, a synthetic `kind: "composer"` annotation is pushed at the end line of the selection span, on the correct side.
- `renderAnnotation` handles `kind: "composer"` first — renders the full composer card (path/span label, suggest-change toggle for additions-side, autoFocus textarea, Pierre EditProvider/File editor in suggestion mode, PierreDiff live preview, Save draft / Cancel buttons).
- `autoFocus` on the textarea is natural: CodeView remounts (via the annotations fingerprint key) when the composer annotation appears, so the textarea autofocuses on mount.
- Removed the old `{composerOpen && ...}` bottom-of-page composer block entirely.

### `packages/web/src/routes/review.$sha.test.tsx`

- Extended "opens composer when a line range is selected" to assert `codeView.contains(composer)` — verifying the composer is inside the CodeView annotation slot, not at page bottom.
- Added "composer cancel hides the composer annotation" — fires selection, clicks Cancel, asserts `line-composer` is gone.
- Added "composer save-draft via annotation saves and hides the composer" — fires selection, fills textarea via fireEvent, clicks Save draft, asserts composer gone and draft persisted to localStorage.

## Design notes

The suggest-mode Pierre editor (`EditProvider`/`File`) mounts inline in the annotation slot without issue in the test environment. No shadow-DOM clipping concern arose — the CodeView mock is a plain DOM renderer, and the real CodeView annotation container is a standard block element. A fixed-overlay fallback was not needed.

The `codeViewItems` memo guards against calling `setState` during render: the composer annotation is computed during the memo (pure derivation from state), not as a side effect.
