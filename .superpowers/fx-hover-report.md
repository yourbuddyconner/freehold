# fx-hover investigation report

## Root cause

**No hard gate exists for hover events in the `File` component** — the precedent
from `enableLineSelection` (which has an explicit `if (!enableLineSelection) return`
in `startLineSelectionFromPointerDown`) does NOT apply to hover.

`InteractionManager.handlePointerMove` (dist/managers/InteractionManager.js line 142)
guards with:

```js
if (lineHoverHighlight === "disabled" && !enableGutterUtility
    && onLineEnter == null && onLineLeave == null
    && onTokenEnter == null && onTokenLeave == null) return;
```

Providing `onLineEnter` or `onLineLeave` in options is **sufficient** to bypass
this check — no extra enable flag is required.  Pointer listeners are also
attached in `syncPointerListeners` (line 239) whenever any callback is non-null.

`onLineNumberClick` is gated identically in `handlePointerClick` (line 130):
providing the callback in options is sufficient; no separate flag is required.

## What was wrong

1. **`lineHoverHighlight` was not set** — defaulting to `"disabled"`.  With this
   default the library never writes `data-hovered` onto the hovered line element,
   so there is no visual CSS highlight on the line even when callbacks fire.
   Setting `lineHoverHighlight: "line"` turns the highlight on, making hover
   behaviour visually verifiable and confirming the event pipeline is active.

2. **No tests verified the real event pipeline** — the `PierreFile` mock captured
   only `onLineNumberClick` from `options`; `onLineEnter`, `onLineLeave`, and
   `lineHoverHighlight` were never inspected.  Hover could have silently
   broken under any refactor.

## File:line references in dist

| Finding | Location |
|---------|----------|
| `handlePointerMove` hover gate | `dist/managers/InteractionManager.js:141-143` |
| `syncPointerListeners` attach condition | `dist/managers/InteractionManager.js:237-244` |
| `handlePointerClick` click gate | `dist/managers/InteractionManager.js:129-132` |
| `startLineSelectionFromPointerDown` hard gate | `dist/managers/InteractionManager.js:303-305` |
| `lineHoverHighlight` default ("disabled") | `dist/managers/InteractionManager.js:141` |
| `pluckInteractionOptions` extracts all callbacks | `dist/managers/InteractionManager.js:1067-1096` |

## Was `onLineNumberClick` (line-number click) also affected?

Yes, in the same way — no additional gate flag is needed (providing the callback
is sufficient), but there were no tests verifying it was wired through
`options`.  The new `onLineNumberClick is wired in PierreFile options` test
confirms it.

## Changes made

- `packages/web/src/routes/code.file.tsx`: added `lineHoverHighlight: "line"` to
  `PierreFile` options so the library emits `data-hovered` on the current line
  and the event pipeline is visually verifiable.

- `packages/web/src/routes/code.file.test.tsx`:
  - `CapturedFileProps` now exposes the full `options` object (replacing the
    previous flat `onLineNumberClick` field).
  - All three existing click tests updated to use
    `capturedFileProps.current.options?.onLineNumberClick?.(...)`.
  - Added `describe("CodeFilePage — hover card")` with 5 tests:
    - `onLineEnter` / `onLineLeave` / `lineHoverHighlight` are wired in options
    - hover card appears after 100 ms debounce when line is indexed
    - no card when line is not covered by any item span
    - `onLineLeave` clears the card after debounce
    - `onLineNumberClick` is wired in options
