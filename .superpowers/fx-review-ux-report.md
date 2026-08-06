# fx-review-ux bug-fix report

## Changes made in `packages/web/src/routes/review.$sha.tsx`

### Bug 1 — SPLIT / UNIFIED toggle does nothing

**Root cause.** The React `CodeView` wrapper (in `@pierre/diffs/dist/react/CodeView.js`) calls
`instance.setOptions(managedOptions)` inside a `useIsomorphicLayoutEffect` that has no
dependency array, so it fires after every render. `areOptionsEqual` does shallow comparison:
`objA[key] !== objB[key]`. The `options` prop is an inline object literal, so its reference
changes on every render; `managedOptions` (a `useMemo` depending on `options`) therefore also
produces a new object each render. In the browser the `setOptions` path is exercised, but
empirically the component does not repaint split vs. unified layout after the initial mount.
Whether this is a shadow-DOM / imperative render queue issue or a stale canvas, the library
docs explicitly call out `key` remounting as the escape hatch ("Remount with a new key instead"
appears in a `console.error` inside the controlled/uncontrolled mode guard).

**Fix.** Added `key={diffStyle}` to `<CodeView>`. When `diffStyle` changes React destroys
and remounts the component, guaranteeing a fresh imperative instance initialised with the
correct options.

Also added `className="w-full"` to `<CodeView>` so the virtualized scroll surface fills the
flex-1 container.

### Bug 2 — Diff area at half page width / large empty region on the left

**Root cause (layout).** The outermost wrapper was `max-w-4xl mx-auto` (896 px). On a full-
width display the centered block leaves symmetric gutters, but with a 280 px sidebar that
appears empty (see sidebar bug below), the visible diff content sits inside a constrained
box that visually reads as half-page-width with dead space to the left.

**Fix.** Removed `max-w-4xl mx-auto` from the outermost `<div>`. The page now spans the
available route width. Headers and form controls are naturally narrower and stay readable;
the diff pane expands to fill the remaining width alongside the sidebar.

### Bug 2 — PierreTree sidebar renders nothing visible

**Root cause.** `@pierre/trees` renders inside a shadow root backed by a virtualised list.
The README example shows `style={{ height: '320px' }}` passed to `<FileTree>`. Without an
explicit height the host element has no intrinsic size, the virtual list measures 0 available
rows, and nothing renders — even though the `aside` CSS reserves `w-[280px]`.

The current `<PierreTree>` wrapper does not accept or forward a `style` (or `fileTreeStyle`)
prop to the inner `<FileTree>`. **This component was not changed** (it is outside the route
file boundary). The required change is described below.

## Required external change — `packages/web/src/components/PierreTree.tsx`

`FileTree` extends `Omit<HTMLAttributes<HTMLElement>, 'children'>` and spreads `...hostProps`,
so it accepts `style` natively. The wrapper needs:

1. Add `fileTreeStyle?: React.CSSProperties` to `PierreTreeProps`.
2. Destructure it in the function signature.
3. Pass it to `<FileTree>`:

```diff
 export interface PierreTreeProps {
   paths: string[];
   gitStatus?: Array<...>;
   selectedPath?: string;
   onSelect: (path: string, kind: "file" | "directory") => void;
   initialExpandedPaths?: string[];
   onExpansionChange?: (expandedPaths: string[]) => void;
   initialExpansion?: "open" | "closed";
   search?: boolean;
   header?: React.ReactNode;
   scrollToRef?: React.Ref<{ scrollToPath: (path: string) => void }>;
+  /** Forwarded as the `style` prop on the inner FileTree host element.
+   *  Required for the virtualised list to measure available height.
+   *  Example: style={{ height: 400 }} */
+  fileTreeStyle?: React.CSSProperties;
 }

 export function PierreTree({
   paths,
   gitStatus,
   onSelect,
   initialExpandedPaths,
   onExpansionChange,
   initialExpansion = "open",
   search = false,
   header,
   selectedPath,
   scrollToRef,
+  fileTreeStyle,
 }: PierreTreeProps): React.JSX.Element {
   ...
   return (
     <div data-testid="pierre-tree-root" className="text-sm" style={themeStyles as React.CSSProperties}>
-      <FileTree model={model} header={header} />
+      <FileTree model={model} header={header} style={fileTreeStyle} />
     </div>
   );
 }
```

Then in `review.$sha.tsx` the call site becomes:

```diff
 <PierreTree
   paths={files.map((f) => f.path)}
   gitStatus={files.map((f) => ({ path: f.path, status: verbToStatus(f.verb) }))}
   onSelect={(path) => scrollToFile(path)}
   initialExpansion="open"
+  fileTreeStyle={{ height: 400 }}
 />
```

The `height: 400` is a reasonable default for the sidebar; the exact value can be tuned once
the tree is visible. Alternatively the `aside` can be `flex flex-col h-full` and the tree
can be `flex-1` — but that requires a fixed-height parent, so an explicit pixel value is simpler
and matches the library's own documentation examples.

## Test summary

No tests were added or changed. The existing toggle test (line 455) already asserts
`data-diff-style` attribute changes; `key={diffStyle}` remounts the mock with the correct
options on each toggle cycle, so the assertion continues to pass. Layout changes (removing
`max-w-4xl`) are not observable through the vitest/happy-dom mocks.

251 tests pass, 0 failures. Lint clean. `tsc -b --force` zero errors.
