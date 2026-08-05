# Pierre Diffs + Trees Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the Pierre component family across freehold — full-content diff API + tree-sidebar review page, `@pierre/trees` for the code and memory trees, a live saved-vs-draft diff in DocEditor, and batched line-anchored review comments.

**Architecture:** The diff endpoint ships full old/new file contents; all diff parsing happens client-side with `parseDiffFromFile`. A shared `PierreTree` wrapper (new `@pierre/trees` dependency) replaces two hand-rolled trees and provides the review page's changed-files sidebar next to a virtualized `CodeView`. Review comments draft locally per sha and submit through the existing M4 endpoints (`POST /git/proposals/:sha/reviews` then `.../decide`).

**Tech Stack:** TypeScript monorepo (pnpm), Hono API, TanStack Router + React 19 web, vitest + happy-dom, `@pierre/diffs` 1.3.2, `@pierre/trees` 1.0.0-beta.6, `@pierre/theming` 1.0.0.

**Spec:** `docs/specs/2026-08-05-pierre-integration-design.md` (read it for rationale; this plan is self-contained for execution).

## Global Constraints

- Work in a git worktree branched from freehold `main`; never commit to main directly.
- Diff parsing is client-side via `parseDiffFromFile(old, new)`. No patch-text parsing anywhere in web.
- Content caps, enforced in core: 512 KB per file side (`SIDE_LIMIT = 512 * 1024`); 10 MB total per response (`ENVELOPE_LIMIT = 10 * 1024 * 1024`). Over-cap files ship `oldContent: ""`, `newContent: ""`, `truncated: true`. Envelope `truncated` is true iff any file is truncated.
- UI vocabulary: saved/pending, approved/rejected/incomplete. Never admitted/held. Captions are plain declarative prose: "Binary file.", "File too large to display.", "No changes." No reassurance register.
- All Pierre components resolve theme from the existing `activeTheme()` pattern (reads `data-theme` attribute); `PierreTree` additionally applies `themeToTreeStyles()`.
- Test fixtures that run `git init` MUST use `git init -b main` (CI runners default to master).
- localStorage keys: `freehold-diff-view` (split/unified), `freehold-editor-pane` (preview/diff), `freehold:memory-tree-open` (existing, keeps its name), `freehold:review-drafts:<sha>`.
- Gates per task: `pnpm lint` clean, affected package tests green. Gates before merge: `pnpm -r build` then root `pnpm test` green, `pnpm --filter @freehold/web exec tsc -b --force` zero errors.
- After changing packages/core or packages/api, run `pnpm -r build` before running dependent tests — stale dists cause spurious failures.
- OpenAPI regen after API schema changes: `pnpm --filter <api package name> openapi` then `pnpm --filter <client package name> generate` (confirm exact package names from packages/api/package.json and packages/client/package.json `name` fields).
- Verify `@pierre/trees` and `@pierre/diffs` API details against the installed `.d.ts` files in node_modules before use — this plan's prop names come from docs research and the library is beta; where they disagree, the `.d.ts` wins and the wrapper's external props stay as specified here.

---

## SP1 — Diff foundation + review page

### Task 1: Core commitDiff returns full file contents

**Files:**
- Modify: `packages/core/src/git.ts` (replace `FileDiffEntry`, `commitDiff`, `parsePatchOutput`, `PATCH_SIZE_LIMIT`)
- Modify: `packages/core/src/index.ts` (export renames if needed)
- Test: `packages/core/src/git.test.ts` (or the existing test file covering commitDiff — find with `grep -rn "commitDiff" packages/core/src/*.test.ts`)

**Interfaces:**
- Consumes: existing `git(repoDir, args)`, `commitMeta(repoDir, sha)`, `assertSafeRef` in git.ts.
- Produces: `export interface DiffFile { path: string; oldPath?: string; verb: "A" | "M" | "D" | "R"; binary: boolean; oldContent: string; newContent: string; truncated: boolean }` and `export async function commitDiff(repoDir: string, sha: string): Promise<{ files: DiffFile[]; truncated: boolean }>`. `FileDiffEntry` and the `patch` field are deleted.

- [ ] **Step 1: Write failing tests** (adapt to the existing test file's fixture helpers; every fixture uses `git init -b main`):

```ts
describe("commitDiff (content form)", () => {
  it("returns old and new content for a modified file", async () => {
    // fixture: commit file.txt "one\n", then commit "two\n"
    const { files, truncated } = await commitDiff(repo, sha2);
    expect(truncated).toBe(false);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "file.txt", verb: "M", binary: false,
      oldContent: "one\n", newContent: "two\n", truncated: false,
    });
  });

  it("add has empty oldContent; delete has empty newContent", async () => { /* verb A / D fixtures */ });

  it("root commit diffs against the empty tree (all adds)", async () => {
    const { files } = await commitDiff(repo, rootSha);
    expect(files.every((f) => f.verb === "A" && f.oldContent === "")).toBe(true);
  });

  it("merge commit diffs against first parent only", async () => { /* existing merge fixture */ });

  it("rename carries oldPath and both contents", async () => {
    // fixture: git mv a.txt b.txt && commit
    expect(files[0]).toMatchObject({ path: "b.txt", oldPath: "a.txt", verb: "R" });
  });

  it("binary file ships empty contents, binary true", async () => {
    // fixture: write Buffer with a NUL byte
    expect(files[0]).toMatchObject({ binary: true, oldContent: "", newContent: "", truncated: false });
  });

  it("a side over 512 KB truncates the file", async () => {
    // fixture: commit a 600 KB text file
    expect(files[0]).toMatchObject({ truncated: true, oldContent: "", newContent: "" });
    expect(truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter <core pkg> test -- git` — FAIL (shape mismatch / patch field gone).

- [ ] **Step 3: Implement.** Replace the patch pipeline in `packages/core/src/git.ts`:

```ts
export interface DiffFile {
  path: string;
  oldPath?: string;
  verb: "A" | "M" | "D" | "R";
  binary: boolean;
  oldContent: string;
  newContent: string;
  truncated: boolean;
}

const SIDE_LIMIT = 512 * 1024;
const ENVELOPE_LIMIT = 10 * 1024 * 1024;

/** Read one blob side. Absent path (add/delete side) → empty content. */
async function blobAt(
  repoDir: string,
  rev: string,
  path: string
): Promise<{ content: string; truncated: boolean; binary: boolean }> {
  let sizeOut: string;
  try {
    sizeOut = await git(repoDir, ["cat-file", "-s", `${rev}:${path}`]);
  } catch {
    return { content: "", truncated: false, binary: false };
  }
  const size = Number.parseInt(sizeOut.trim(), 10);
  if (Number.isNaN(size)) return { content: "", truncated: false, binary: false };
  if (size > SIDE_LIMIT) return { content: "", truncated: true, binary: false };
  const content = await git(repoDir, ["show", "--end-of-options", `${rev}:${path}`]);
  if (content.includes("\0")) return { content: "", truncated: false, binary: true };
  return { content, truncated: false, binary: false };
}

export async function commitDiff(
  repoDir: string,
  sha: string
): Promise<{ files: DiffFile[]; truncated: boolean }> {
  assertSafeRef(sha, "sha");
  const meta = await commitMeta(repoDir, sha);
  const parent = meta.parents.length > 0 ? meta.parents[0] : null;

  const args = parent
    ? ["diff-tree", "-M", "-r", "-z", "--name-status", "--end-of-options", parent, sha]
    : ["diff-tree", "--root", "-M", "-r", "-z", "--name-status", "--end-of-options", sha];
  const out = await git(repoDir, args);

  // -z output: STATUS \0 path \0 [newpath \0]  (R/C carry two paths).
  // With --root the first record is prefixed by the commit sha — skip non-status tokens.
  const tokens = out.split("\0").filter((t) => t.length > 0);
  const specs: Array<{ verb: DiffFile["verb"]; oldPath: string; path: string }> = [];
  let i = 0;
  if (tokens[0] && /^[0-9a-f]{40}/.test(tokens[0])) i = 1;
  while (i < tokens.length) {
    const status = tokens[i][0] as string;
    if (status === "R" || status === "C") {
      specs.push({ verb: "R", oldPath: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else if (status === "A" || status === "M" || status === "D") {
      specs.push({ verb: status, oldPath: tokens[i + 1], path: tokens[i + 1] });
      i += 2;
    } else {
      i += 2; // T (typechange) etc: treat as modify of the same path
      specs.push({ verb: "M", oldPath: tokens[i - 1], path: tokens[i - 1] });
    }
  }

  const files: DiffFile[] = [];
  let totalBytes = 0;
  let envelopeFull = false;

  for (const spec of specs) {
    if (envelopeFull) {
      files.push({ path: spec.path, ...(spec.verb === "R" ? { oldPath: spec.oldPath } : {}),
        verb: spec.verb, binary: false, oldContent: "", newContent: "", truncated: true });
      continue;
    }
    const old = spec.verb === "A" || !parent
      ? { content: "", truncated: false, binary: false }
      : await blobAt(repoDir, parent, spec.oldPath);
    const neu = spec.verb === "D"
      ? { content: "", truncated: false, binary: false }
      : await blobAt(repoDir, sha, spec.path);

    const binary = old.binary || neu.binary;
    const truncated = old.truncated || neu.truncated;
    const oldContent = binary || truncated ? "" : old.content;
    const newContent = binary || truncated ? "" : neu.content;
    totalBytes += oldContent.length + newContent.length;
    if (totalBytes > ENVELOPE_LIMIT) envelopeFull = true;

    files.push({
      path: spec.path,
      ...(spec.verb === "R" && spec.oldPath !== spec.path ? { oldPath: spec.oldPath } : {}),
      verb: spec.verb,
      binary,
      // The file that crosses the envelope cap still ships its contents;
      // only files after it are emptied (envelopeFull check at loop top).
      oldContent,
      newContent,
      truncated,
    });
  }

  return { files, truncated: files.some((f) => f.truncated) };
}
```

Notes for the implementer: check whether `git()` trims output (`.trim()` on stdout) — if it does, add a non-trimming variant for `git show` so file contents keep trailing newlines, and use it in `blobAt`. Delete `parsePatchOutput`, `FileDiffEntry`, `PATCH_SIZE_LIMIT`. Fix any `index.ts` re-exports. Grep the repo for `FileDiffEntry` and `.patch` consumers (`grep -rn "FileDiffEntry\|\.patch" packages --include="*.ts" --include="*.tsx"`) and update them (the API route is Task 2's job; if the build breaks cross-package, coordinate by making the minimal API-side type fix here and note it in your report).

- [ ] **Step 4: Run tests** — core suite green.
- [ ] **Step 5: Commit** — `feat(core): commitDiff ships full old/new contents with size caps`

### Task 2: API diff route + OpenAPI + client regen

**Files:**
- Modify: `packages/api/src/routes/gitreview.ts:278-306` (the diff route)
- Modify: the OpenAPI schema source used by `packages/api/scripts/gen-openapi.ts` (find the existing DiffResponse/diff schema by grepping `diff` in packages/api/src)
- Modify: regenerated client in packages/client (via its `generate` script)
- Test: `packages/api/src/routes/gitreview.diff.test.ts`

**Interfaces:**
- Consumes: Task 1's `commitDiff(repoDir, sha) → { files: DiffFile[]; truncated: boolean }`.
- Produces: `GET /git/proposals/:sha/diff` → `{ files: [{ path, oldPath?, verb, binary, oldContent, newContent, truncated }], truncated: boolean }`.

- [ ] **Step 1: Update the existing tests in gitreview.diff.test.ts** to the new shape (the fake core module mock returns `{ files: [...], truncated: false }`; assertions check `oldContent`/`newContent` pass through and no `patch` key). Keep the typed-Hono pattern already in that file (`new Hono<AppEnv>()`).
- [ ] **Step 2: Run to verify failure** — `pnpm --filter <api pkg> test -- gitreview.diff`.
- [ ] **Step 3: Implement.** The route body becomes:

```ts
const diff = await commitDiff(fh.graphDir, sha);
return c.json(diff);
```

Delete `DIFF_SIZE_LIMIT` and the totalBytes computation. Update the OpenAPI schema for the diff response to the new file shape, then regenerate: run the api `openapi` script and the client `generate` script; commit the regenerated output.
- [ ] **Step 4: `pnpm -r build` then api + client tests green.** Also run the client drift check (`check:drift`).
- [ ] **Step 5: Commit** — `feat(api): diff endpoint ships full file contents`

### Task 3: PierreTree wrapper component

**Files:**
- Modify: `packages/web/package.json` (add `"@pierre/trees": "1.0.0-beta.6"`, `pnpm install`)
- Create: `packages/web/src/components/PierreTree.tsx`
- Test: `packages/web/src/components/PierreTree.test.tsx`

**Interfaces:**
- Consumes: `@pierre/trees/react` (`useFileTree`, `FileTree`), `themeToTreeStyles` (import from `@pierre/trees` or `@pierre/theming` — check the installed `.d.ts` for which package exports it), `activeTheme()` pattern from `PierreDiff.tsx`.
- Produces:

```ts
export interface PierreTreeProps {
  paths: string[];
  gitStatus?: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed" }>;
  selectedPath?: string;
  onSelect: (path: string, kind: "file" | "directory") => void;
  initialExpandedPaths?: string[];
  onExpansionChange?: (expandedPaths: string[]) => void;
  initialExpansion?: "open" | "closed";
  search?: boolean;
  header?: React.ReactNode;
  scrollToRef?: React.Ref<{ scrollToPath: (path: string) => void }>;
}
export function PierreTree(props: PierreTreeProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test.** Because `@pierre/trees` renders into a shadow root (happy-dom support is uncertain), the unit test exercises the wrapper's contract through a module mock of `@pierre/trees/react` itself: mock `useFileTree` to return a model stub and `FileTree` to render `<div data-testid="pierre-tree" />`, and assert the wrapper forwards `paths`, wires `onSelectionChange` → `onSelect`, maps `gitStatus` entries into the tree options, and applies theme styles. Keep assertions on the wrapper's translation logic, not the library.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Shape:

```tsx
import { FileTree, useFileTree } from "@pierre/trees/react";
// theme import per installed .d.ts

export function PierreTree({ paths, gitStatus, onSelect, initialExpandedPaths,
  onExpansionChange, initialExpansion = "open", search = false, header, selectedPath, scrollToRef }: PierreTreeProps) {
  const { model } = useFileTree({
    paths,
    initialExpansion,
    ...(initialExpandedPaths ? { initialExpandedPaths } : {}),
    search,
    onSelectionChange: (selected) => {
      const path = selected[0];
      if (path) onSelect(path, /* kind from model handle */ model.getItem?.(path)?.isDirectory?.() ? "directory" : "file");
    },
  });
  // gitStatus → the library's gitStatus option (verify exact option name/shape in .d.ts; it may live on useFileTree options or render options)
  // expansion persistence: subscribe via useFileTreeSelector to expanded paths, debounce 250ms, call onExpansionChange
  // scrollToRef: useImperativeHandle exposing model.scrollToPath(path, { focus: true })
  // theme: wrap in a div whose style = themeToTreeStyles(resolved shiki theme for activeTheme()); re-resolve on data-theme MutationObserver (copy the pattern PierreDiff uses if it has one, else a small useSyncExternalStore on the attribute)
  return (
    <div data-testid="pierre-tree-root" className="text-sm">
      <FileTree model={model} header={header} />
    </div>
  );
}
```

The exact `useFileTree` option names MUST be verified against `node_modules/@pierre/trees/dist/**/*.d.ts` after install; keep the exported `PierreTreeProps` stable regardless.
- [ ] **Step 4: Tests green; `pnpm lint` clean.**
- [ ] **Step 5: Commit** — `feat(web): PierreTree wrapper over @pierre/trees`

### Task 4: Review page — tree sidebar + CodeView diffs

**Files:**
- Modify: `packages/web/src/routes/review.$sha.tsx` (replace the per-file `<pre>` section, lines ~259-300)
- Modify: `packages/web/src/components/PierreDiff.tsx` (add `lineDiffType: "word-alt"` to options)
- Test: `packages/web/src/routes/review.$sha.test.tsx`

**Interfaces:**
- Consumes: Task 2's diff response shape via the existing `useGitProposalDiff(sha, isRepoGraph)` hook in `packages/web/src/lib/hooks.ts` (update its response type); Task 3's `PierreTree`; `@pierre/diffs` `parseDiffFromFile` + `@pierre/diffs/react` `CodeView` (check `CodeViewHandle` ref type and item shape `{ type: "diff", fileDiff, id }` in the installed `.d.ts`).
- Produces: the review page layout consumed by Task 8 (line comments) — keep each file's diff item `id` equal to the file `path`.

- [ ] **Step 1: Update route tests.** Mock `~/components/PierreTree` as a list of `<button data-testid="tree-row" data-path={p}>` and mock `@pierre/diffs/react`'s `CodeView` as `<div data-testid="code-view">{items.map(i => <pre key={i.id} data-testid="diff-file">{i.id}</pre>)}</div>`. Assert: one diff item per file; split/unified toggle persists to `localStorage["freehold-diff-view"]` and flips the option passed to CodeView items; tree row click calls scroll (spy via the CodeView ref mock); binary file renders "Binary file."; truncated file renders "File too large to display."; envelope truncated notice text updated to plain prose ("Some files were too large to display.").
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** In `review.$sha.tsx`: build `fileDiffs = useMemo(() => files.map(f => ({ id: f.path, fileDiff: parseDiffFromFile({ name: f.oldPath ?? f.path, contents: f.oldContent }, { name: f.path, contents: f.newContent }) })), [files])`. Layout: `<div className="flex gap-4"><aside className="w-[280px] shrink-0"><PierreTree paths={files.map(f=>f.path)} gitStatus={files.map(f=>({path: f.path, status: verbToStatus(f.verb)}))} onSelect={scrollToFile} initialExpansion="open"/></aside><div className="min-w-0 flex-1"><CodeView ref={codeViewRef} items={...} options={{ diffStyle, lineDiffType: "word-alt", stickyHeader: true, overflow: "wrap", themeType: activeTheme() }}/></div></div>`. Toggle button pair "Split | Unified" in the section header; `verbToStatus`: A→added, M→modified, D→deleted, R→renamed. Binary/truncated files render a bordered row with path + caption instead of a diff item. If `CodeView`'s option pass-through differs (options may be per-item), follow the `.d.ts`; per-item options are fine.
- [ ] **Step 4: Web tests green; `tsc -b --force` zero errors; `pnpm lint` clean.**
- [ ] **Step 5: Commit** — `feat(web): review page renders Pierre split diffs with changed-files tree`

## SP2 — Trees adoption

### Task 5: /code file tree via PierreTree

**Files:**
- Modify: `packages/web/src/routes/code.tsx` (delete the `FileNode` component, lines ~29-89, and its usage)
- Test: the existing code route test file (find via `ls packages/web/src/routes/*.test.tsx | grep code`)

**Interfaces:**
- Consumes: existing `codeTree()` client call returning nested `{ name, path, kind, children }[]`; Task 3's `PierreTree`.
- Produces: nothing downstream.

- [ ] **Step 1: Update tests** to the PierreTree mock (same mock as Task 4); assert file paths flattened from the nested tree are passed as `paths`, and clicking a file row navigates to the file route with that path.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** `function flattenTree(nodes): string[]` — depth-first, collect `kind === "file"` paths (directories are implied). `onSelect={(path, kind) => kind === "file" && navigate to code.file with path}`. `search` enabled. Delete `FileNode`.
- [ ] **Step 4: Tests green, lint clean.**
- [ ] **Step 5: Commit** — `feat(web): code file tree uses PierreTree`

### Task 6: /memory tree via PierreTree

**Files:**
- Modify: `packages/web/src/routes/memory.tsx` (swap `MemoryTree` usage)
- Modify: `packages/web/src/lib/memoryTree.ts` (add path-mapping helper)
- Delete: `packages/web/src/components/MemoryTree.tsx`
- Test: `packages/web/src/lib/memoryTree.test.ts` and the memory route test

**Interfaces:**
- Consumes: `buildMemoryTree(entries): TreeFolder[]` (existing), Task 3's `PierreTree`.
- Produces: `export function treeToPaths(folders: TreeFolder[]): { paths: string[]; idByPath: Map<string, string> }` in memoryTree.ts.

- [ ] **Step 1: Write failing tests** for `treeToPaths`: folder/leaf mapping to `<TypeFolder>/<TermFolder>/<Title>` synthetic paths; duplicate titles within one folder get ` (2)`, ` (3)` suffixes in the path only; `idByPath` maps every leaf path to its memory id. Route test: PierreTree mock receives the paths; clicking a leaf navigates to `/memory/$id` using `idByPath`; expanded-folder persistence: localStorage `freehold:memory-tree-open` seeds `initialExpandedPaths` and `onExpansionChange` writes back.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** `treeToPaths` walks `TreeFolder[]` (see `TreeFolder`/`TreeLeaf` in memoryTree.ts:14-29); sanitize `/` in titles to `∕` (U+2215) so synthetic paths stay well-formed. In `memory.tsx`: default expansion — keep the existing rule (≤15 leaves → `initialExpansion: "open"`, else `"closed"`); persistence via `initialExpandedPaths` + `onExpansionChange` writing the JSON array to the existing key. Directory selections do not navigate.
- [ ] **Step 4: Tests green, lint clean.**
- [ ] **Step 5: Commit** — `feat(web): memory tree uses PierreTree`

## SP3 — Live diff in the editor

### Task 7: DocEditor Preview | Diff pane toggle

**Files:**
- Modify: `packages/web/src/components/DocEditor.tsx`
- Test: `packages/web/src/components/DocEditor.test.tsx` (create if absent; follow the PierreDiff mock pattern)

**Interfaces:**
- Consumes: `PierreDiff` (existing props `oldText/newText/name/split`), DocEditor's existing `draft` state (set from the Pierre editor `onChange` at line ~40) and the saved/original content prop (read the component to find its name — it holds the pre-edit content used for the preview baseline).
- Produces: nothing downstream.

- [ ] **Step 1: Write failing tests.** Mock PierreDiff with the standard mock. Assert: default pane honors `localStorage["freehold-editor-pane"]` (default "preview"); clicking "Diff" swaps `data-testid="doc-editor-preview"` for the diff mock; after simulating a draft change (fire the editor onChange mock), the diff mock's `newText` updates (debounce: use `vi.useFakeTimers()` and advance 150ms); when draft equals saved, the pane shows "No changes."; toggle choice persists to localStorage.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Two-button segmented control ("Preview" / "Diff") in the editor header. Diff pane: `<PierreDiff oldText={savedContent} newText={debouncedDraft} name={`${title || "memory"}.md`} />` (unified). `const debouncedDraft = useDebouncedValue(draft, 150)` — add a small local `useDebouncedValue` hook inline in the file (useEffect + setTimeout). Equality → `<p className="text-sm text-(--fg-muted)">No changes.</p>`.
- [ ] **Step 4: Tests green, lint clean.**
- [ ] **Step 5: Commit** — `feat(web): DocEditor live saved-vs-draft diff pane`

## SP4 — Batched line comments

### Task 8: Comment annotations, drafts, and submit-with-review

**Files:**
- Create: `packages/web/src/lib/reviewDrafts.ts` (draft store)
- Modify: `packages/web/src/routes/review.$sha.tsx` (annotations, composer, submit flow)
- Modify: `packages/web/src/lib/hooks.ts` (add `useReviewsForSha(sha)` querying `GET /git/proposals/:sha/reviews` if no such hook exists — grep first; a reviews hook may exist from M4)
- Test: `packages/web/src/lib/reviewDrafts.test.ts`, `packages/web/src/routes/review.$sha.test.tsx`

**Interfaces:**
- Consumes: existing endpoints — `GET /git/proposals/:sha/reviews` → `ReviewEntry[]` (verdict, author, status saved|pending, comments[{commentId, body, anchor, span, status}]), `POST /git/proposals/:sha/reviews` body `{ verdict: "approve"|"approve-with-comments"|"request-changes", body?, by, comments: [{ body, anchor, span }] }`, existing decide mutation (`useDecideProposal`). Task 4's page layout (diff item id = file path). `@pierre/diffs` `lineAnnotations` + `renderAnnotation` + `onLineSelected` / gutter utility (verify against `.d.ts`; if the gutter utility API is awkward under CodeView, line-number click via `onLineNumberClick` is an acceptable composer trigger — note the choice in the report).
- Produces:

```ts
// reviewDrafts.ts
export interface CommentDraft { path: string; span: string; body: string } // span "L5" | "L5-L9" | "old:L5"
export function loadDrafts(sha: string): CommentDraft[];
export function saveDrafts(sha: string, drafts: CommentDraft[]): void;
export function clearDrafts(sha: string): void; // key: `freehold:review-drafts:${sha}`
```

- [ ] **Step 1: Write failing tests.** reviewDrafts: round-trip, clear, corrupt-JSON → `[]`. Route tests (mocks as in Task 4, plus mock CodeView forwarding a `lineAnnotations`/`renderAnnotation`-equivalent: have the CodeView mock render each item's annotations as `<div data-testid="annotation" data-path data-span>`): saved comments from the reviews hook render on the right file with author/body/status and "via github" when `external_source` is present; adding a draft via the composer persists to localStorage and shows a "pending" marker; the decision panel shows "N comments pending" and submit posts `{ verdict: "approve-with-comments", comments: [...] }` to the reviews endpoint, then the decide mutation, then drafts cleared; reject maps to `request-changes`; with zero drafts the flow calls only decide (unchanged card behavior).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.**
  - Parse comment anchors `git:<repo>#<sha>:<path>` → path; span `old:`-prefix → deletions side, else additions; span `L<n>` or `L<n>-L<m>` → lineNumber = n (annotation attaches at the range start).
  - Per file, `lineAnnotations = [...savedComments, ...drafts]` mapped to `{ side, lineNumber, metadata }`; `renderAnnotation` renders a bordered card: author + status chip for saved; editable textarea + Remove for drafts; composer opens from line selection (or line-number click) with Save-draft/Cancel.
  - Anchor for new drafts: `git:${repoName}#${sha}:${path}` — repoName from the existing page data (the proposal payload carries the repo/graph identity; grep how GitProposalCard builds refs).
  - Submit: if drafts exist, `POST .../reviews` with `by` = the acting principal already used by the decide flow, verdict mapped (approve+drafts → approve-with-comments), comments with anchor+span+body; on success call decide as today, then `clearDrafts(sha)` and invalidate the reviews query. Surface reviews-post failure in the existing error area; do not call decide if the review post failed.
- [ ] **Step 4: Tests green, lint clean, `tsc -b --force` clean.**
- [ ] **Step 5: Commit** — `feat(web): batched line comments on review page`

## Integration

### Task 9: Full-gate verification and local deployment

**Files:** none new; this is the merge-and-deploy gate.

- [ ] **Step 1:** In the worktree: `pnpm install`, `pnpm -r build`, root `pnpm test`, `pnpm lint`, `pnpm --filter <web pkg> exec tsc -b --force`. All green.
- [ ] **Step 2:** Merge the worktree branch to local `main` (no push without explicit authorization).
- [ ] **Step 3:** Rebuild on main (`pnpm -r build`) and restart the daemon on :8710 the same way it was last started (check the running process's invocation with `ps aux | grep freehold` before killing it; restart with the same command/env).
- [ ] **Step 4:** Live verification against the allod repo graph: `GET /api/v1/graphs/allod/git/proposals/ee8d475.../diff` returns `oldContent`/`newContent`; open `http://127.0.0.1:8710/review/<sha>` — split diffs render with syntax highlighting, tree sidebar lists changed files with a status badge, toggle flips to unified; `/code` and `/memory` trees render and navigate; memory editor Diff pane updates while typing; adding a line comment survives refresh and submitting a review creates the artifacts (verify via `GET .../reviews`).
- [ ] **Step 5:** Report results; offer to push.
