# Pierre diffs and trees integration

Freehold already ships `@pierre/diffs` 1.3.2 and `@pierre/theming` 1.0.0. It uses a
fraction of them: `parseDiffFromFile` + `FileDiff` for read-only diffs
(`PierreDiff.tsx`) and the edit module in `DocEditor.tsx`. Three tree views are
hand-rolled. The commit review page renders raw patch text in `<pre>` blocks.

This design adopts the Pierre component family deliberately across four
sub-projects:

- **SP1 — Diff foundation + review page.** The diff API ships full old/new file
  contents; `/review/$sha` becomes a tree-sidebar + multi-file diff view.
- **SP2 — Trees adoption.** A shared `PierreTree` wrapper replaces the custom
  code file tree and memory tree.
- **SP3 — Live diff in the editor.** `DocEditor` gains a saved-vs-draft diff pane
  that updates as you type.
- **SP4 — Batched line comments.** Line-anchored review comments, drafted
  locally and saved as `Review` + `ReviewComment` artifacts with the decision.

Dependency order: SP1 first; SP2 and SP4 build on it; SP3 is independent.

## Libraries

- `@pierre/diffs` 1.3.2 (installed). Used beyond today's surface: `CodeView`
  (virtualized multi-file container), split view, word-level inline
  highlighting (`lineDiffType`), sticky file headers, line selection callbacks,
  `lineAnnotations` + `renderAnnotation`, the gutter utility, and the edit
  module's per-keystroke `onChange`.
- `@pierre/trees` 1.0.0-beta.6 (new dependency). Path-first file tree: feed it
  path strings, get a virtualized, keyboard-navigable tree with search, VS Code
  file icons, per-row git-status badges, and `scrollToPath`. Themes via
  `themeToTreeStyles()` from `@pierre/theming`, which is already installed.
  React 19 peer dependency is satisfied.

## Global constraints

- Diff parsing happens client-side with `parseDiffFromFile(old, new)` on full
  file contents. No patch-text parsing, no lazy content loader. (Approach A;
  patch-based `parsePatchFiles` + `loadDiffFiles` was considered and rejected —
  extra endpoint and round-trips with no benefit for a local daemon.)
- Content caps: 512 KB per file side, enforced in core. A file over the cap
  ships empty contents with `truncated: true`. Envelope cap: 10 MB total
  content per diff response; past it, remaining files ship empty contents with
  `truncated: true`. The envelope-level `truncated` flag is set whenever any
  file was truncated.
- UI vocabulary: saved/pending, approved/rejected/incomplete. Never
  admitted/held. Captions are plain declarative prose ("File too large to
  display.", "Binary file."), no reassurance register.
- Theming: all Pierre components resolve dark/light from the existing
  `activeTheme()` (reads `data-theme` on the document element). `PierreTree`
  applies `themeToTreeStyles()`.
- Tests mock Pierre components with the established pattern
  (`<pre data-testid="pierre-diff">{oldText}\n---\n{newText}</pre>`); the tree
  wrapper gets an equivalent list-based mock with a `data-testid="pierre-tree"`
  root and one element per path. Test git fixtures always use
  `git init -b main`.
- Lint (biome) and full root test suite green are gates for every sub-project.

---

## SP1 — Diff foundation + review page

### Core

`commitDiff(repoDir, sha)` (packages/core) changes its per-file shape:

```ts
type DiffFile = {
  path: string;        // new path (or old path for deletes)
  oldPath?: string;    // present for renames
  verb: "A" | "M" | "D" | "R";
  binary: boolean;
  oldContent: string;  // "" for adds, binary, or truncated
  newContent: string;  // "" for deletes, binary, or truncated
  truncated: boolean;  // either side exceeded 512 KB, or envelope cap hit
};
```

Contents come from `git show <parent>:<path>` and `git show <sha>:<path>`
(first-parent resolution as today, `--end-of-options` and the existing sha/ref
validation preserved). The raw `patch` field is removed; grep confirms the
review page is its only consumer. The envelope stays
`{ files: DiffFile[], truncated: boolean }`.

### API and client

`GET /git/proposals/:sha/diff` returns the new shape. OpenAPI schema and
generated client types updated in the same change.

### Web: `/review/$sha`

Layout, top to bottom:

1. Header and the existing checklist/decision panel, unchanged.
2. A two-pane region: left, a 280 px `PierreTree` of changed file paths with
   git-status badges derived from `verb` (A→added, M→modified, D→deleted,
   R→renamed); right, a `CodeView` containing one diff item per file, in the
   API's file order.

Behavior:

- Each file's `FileDiff` metadata comes from
  `parseDiffFromFile({name: pathForSide, contents})` per side; the filename
  drives syntax highlighting.
- Options: `diffStyle` from a split/unified toggle in the pane header
  (default `"split"`, persisted at `localStorage["freehold-diff-view"]`),
  `lineDiffType: "word-alt"`, sticky file headers, `overflow: "wrap"`,
  `themeType` from `activeTheme()`.
- Tree selection calls the `CodeView` ref's `scrollTo` for that file; scrolling
  does not need to update tree selection (one-way, keeps state simple).
- Binary files render a header row with the caption "Binary file." Truncated
  files render "File too large to display."
- The `PierreDiff` component stays for single-diff surfaces (inbox proposal
  cards, commit step, SP3); it gains `lineDiffType: "word-alt"` so word-level
  highlighting is consistent everywhere.

### Errors

Diff fetch failure renders the existing error panel; the checklist panel is
independent and still renders. A sha that exists but has no parent (root
commit) diffs against the empty tree — `oldContent` is `""` for every file,
verb A.

### Tests

- Core: modify/add/delete/rename content pairs; merge commit uses first
  parent; binary detection; per-side cap; envelope cap; root commit.
- API: response shape, sha validation unchanged.
- Web: per-file diff mock presence, toggle flips the option and persists,
  tree renders one row per file, selection triggers scroll (spy on ref).

---

## SP2 — Trees adoption

### Shared wrapper

`packages/web/src/components/PierreTree.tsx`:

```ts
type PierreTreeProps = {
  paths: string[];
  gitStatus?: { path: string; status: "added" | "modified" | "deleted" | "renamed" }[];
  selectedPath?: string;
  onSelect: (path: string, kind: "file" | "directory") => void;
  initialExpandedPaths?: string[];
  onExpansionChange?: (expandedPaths: string[]) => void;
  search?: boolean;
  header?: ReactNode;
};
```

Internally `useFileTree` + `<FileTree>`, icons `"standard"`, theme from
`themeToTreeStyles` re-resolved when `data-theme` changes. Expansion changes
are observed via `useFileTreeSelector` on the model's expansion state and
reported through `onExpansionChange` (debounced) for persistence.

### `/code` file tree

The custom recursive `FileNode` component is deleted. The existing
`codeTree()` response is flattened to file paths (directories are implied by
the paths). File selection navigates to the file route as today; search is
enabled. The regions panel is untouched.

### `/memory` tree

`MemoryTree.tsx` is replaced. `buildMemoryTree` output maps to synthetic paths
`<TypeFolder>/<TermFolder>/<Title>` with a path→memory-id map held alongside;
leaf selection navigates to `/memory/$id`. The existing expansion persistence
keeps its localStorage key (`freehold:memory-tree-open`), now storing expanded
folder paths: read into `initialExpandedPaths`, written from
`onExpansionChange`. The existing default (small trees open, large closed)
maps to `initialExpansion`. Duplicate titles within a folder are
disambiguated with a ` (2)` suffix in the synthetic path only — the rendered
name and navigation target come from the map, so display is unaffected.

The schema type index and code item call graph stay as they are; both are
recorded as future candidates, not part of this design.

### Tests

Wrapper mock renders a flat list with row testids. Code and memory route tests
update to the mock; memory tests cover persistence round-trip and the
duplicate-title mapping.

---

## SP3 — Live diff in the editor

`DocEditor` (which already uses the Pierre edit module) gains a right-pane
mode toggle: **Preview | Diff**. Preview is today's markdown rendering. Diff
renders `PierreDiff` with `oldText` = last saved content, `newText` = current
draft, unified style, name from the memory's title (`.md`). The pane re-renders
from the editor's `onChange`, debounced 150 ms. When draft equals saved, the
pane shows "No changes." The selected mode persists at
`localStorage["freehold-editor-pane"]`.

No API changes. Tests: toggle switches panes, diff mock receives updated
`newText` after a simulated edit, "No changes." on equality, persistence.

---

## SP4 — Batched line comments

### Model

Comments accumulate locally while reading; nothing is saved until the decision
is submitted. One submit produces, in order: the `Review` entity (verdict,
body, commit ref), each `ReviewComment` with a `part_of` edge to the Review,
then the allod git decision and note push exactly as today. All writes go
through the existing signed two-phase flow.

Verdict mapping from the existing decision buttons: approve with no comments →
`approve`; approve with comments → `approve-with-comments`; reject →
`request-changes`. The git decision remains approve/reject as today.

### Anchoring

`ReviewComment.anchor` = `git:<repo>#<sha>:<path>`; `span` uses the existing
free-string convention: `"L<start>"` or `"L<start>-L<end>"` for new-side
lines, prefixed `"old:"` for deletion-side lines (e.g. `"old:L12"`). No
ontology change.

### Core and API

- `listReviewComments(fh, repo, sha)` (core): ReviewComment entities whose
  anchor matches the commit, joined with their Review's verdict and author
  (signing principal, or `claimed_author` + `external_source` for connector-
  ingested comments). Exposed as
  `GET /git/proposals/:sha/comments` →
  `{ comments: [{ id, body, path, span, status, author, source }] }`.
- `submitReview(fh, {repo, sha, verdict, body?, comments: [{path, span, body}]})`
  (core): creates the artifacts and edges, then delegates to the existing
  decide path. Exposed as `POST /git/proposals/:sha/review`. The existing
  bare-decision endpoint remains for comment-less decisions from the card.

### Web

On `/review/$sha` (building on SP1):

- Saved comments load with the page and render as `lineAnnotations` on the
  matching file's diff (side from the `old:` prefix); `renderAnnotation` shows
  author, body, status, and source ("via github" for ingested ones).
- Line selection (or the gutter utility on hover) opens a composer beneath the
  selected range; posting it adds a **draft** annotation, visually marked
  "pending", editable and deletable.
- Drafts persist at `localStorage["freehold-review-drafts:<sha>"]` so a
  refresh keeps them. Submitting the review clears the key; a banner above the
  decision buttons shows the pending-comment count.
- The decision panel's buttons become "Approve" / "Request changes"; with
  drafts present, submit sends them with the verdict via the new endpoint.

### Errors

Submit is not atomic across the artifact writes and the git decision; if the
decision step fails after artifacts commit, the page surfaces the decide error
as today and drafts stay cleared (the comments are saved; the decision can be
retried from the same page). Comment fetch failure degrades to diffs without
annotations plus the standard error panel.

### Tests

Core: artifact creation with edges and spans, verdict mapping, list join.
API: both endpoints, validation (span format, paths must be in the diff — path
membership validated against `commitDiff` output). Web: annotations render on
the right file/side, composer creates a draft, drafts survive remount
(localStorage), submit posts verdict + comments and clears drafts.

## Rollout

Ship per sub-project behind nothing — each lands whole. Order SP1, SP2, SP3,
SP4 (SP3 may land any time after SP1 starts; it shares only `PierreDiff`
option changes). Daemon restart after each merge so the live instance tracks.
