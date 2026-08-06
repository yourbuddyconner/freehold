# fx-line-select fix report

## Root cause

`InteractionManager.startLineSelectionFromPointerDown` (dist/managers/InteractionManager.js:304-305) guards all pointer-drag activity behind `enableLineSelection`:

```js
const { enableLineSelection = false } = this.options;
if (!enableLineSelection) return;
```

The default is `false`. Without it set, every `pointerdown` on line numbers returns early — no selection session starts, no `onLineSelected` fires, `onSelectedLinesChange` is never called.

## What was wrong

`packages/web/src/routes/review.$sha.tsx` passed `options` to `<CodeView>` without `enableLineSelection: true`:

```tsx
options={{
  diffStyle,
  lineDiffType: "word-alt",
  stickyHeaders: true,
  overflow: "wrap",
  themeType: activeTheme(),
  // enableLineSelection missing — silently blocks all line-drag
}}
```

The React `CodeView` wrapper spreads `options` directly into `createManagedCodeViewOptions`, which then flows through `createDiffOptionsPrototype` to each item's `InteractionManager` via `CODE_VIEW_DIFF_OPTION_KEYS`. No per-item options are needed; the top-level `options` prop is sufficient.

Annotation prop names were correct: `annotations` in each item object and `renderAnnotation` as a top-level prop.

## What changed

Single line added to `packages/web/src/routes/review.$sha.tsx`:

```tsx
options={{
  diffStyle,
  lineDiffType: "word-alt",
  stickyHeaders: true,
  overflow: "wrap",
  themeType: activeTheme(),
  enableLineSelection: true,   // ← added
}}
```

No test mock changes required — the mock already captures `onSelectedLinesChange` from the top-level prop.

## Test / lint / tsc results

- Tests: 320 passed (24 files), 0 failures
- Typecheck: clean (no output)
- Lint script: not present in web package (no lint step to run)
