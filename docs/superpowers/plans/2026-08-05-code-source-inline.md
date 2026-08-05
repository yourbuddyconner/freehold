# Code Source Inline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /code/source?path=` that reads working-tree file content and renders it as a line-numbered `<pre>` block above declared items on the Code file page.

**Architecture:** Three layers: (1) `codeSource()` in core reads the file from disk with path-traversal guard, binary detection, and 512 KB truncation; (2) an API route + OpenAPI registration exposes it, client method added manually; (3) `useCodeSource` hook + inline renderer in `code.file.tsx` fetches both `codeFile` and `codeSource` in parallel and composes gracefully.

**Tech Stack:** Node.js `fs/promises` + `path` (core), Hono (API), Zod + `@asteasolutions/zod-to-openapi` (schema), TanStack Query (web), React (UI), Vitest + Testing Library (tests).

## Global Constraints

- Biome lint must pass: `pnpm lint` at repo root — no `any`, no non-null assertions (use `!` only where an existing `// biome-ignore` comment exists in the codebase; never add new ones without justification)
- `pnpm test` green (all packages)
- Web TypeScript force-check + build green (`pnpm typecheck` and/or `pnpm build` in `packages/web`)
- All work on branch `code-source-inline` in worktree `/Users/conner/code/freehold/.claude/worktrees/governed-review-m4`
- No syntax highlighting dependency — YAGNI
- Path traversal guard required: reject paths that contain `..`, start with `/`, or whose `realpath`-resolved absolute form does not start with `fh.graphDir + sep`
- Working tree reads only — no `git show`
- After openapi.ts changes: run `pnpm openapi` in `packages/api`, then `pnpm generate` in `packages/client`
- No `any` — type narrowly; no non-null assertions

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/codeview.ts` | Modify | Add `CodeSource` interface + `codeSource()` function |
| `packages/core/src/index.ts` | Modify | Export `codeSource` and `CodeSource` |
| `packages/core/tests/codeview.test.ts` | Modify | Add `codeSource` test cases |
| `packages/api/src/routes/code.ts` | Modify | Add `GET /code/source` handler |
| `packages/api/src/openapi.ts` | Modify | Add `CodeSource` schema + path registration |
| `packages/api/openapi.json` | Regenerated | `pnpm openapi` output (do not hand-edit) |
| `packages/client/src/client.ts` | Modify | Add `codeSource(path)` method + `CodeSource` type re-export |
| `packages/client/src/types.ts` | Regenerated | `pnpm generate` output (do not hand-edit) |
| `packages/web/src/lib/hooks.ts` | Modify | Add `useCodeSource(path)` hook |
| `packages/web/src/routes/code.file.tsx` | Modify | Fetch source + render line-numbered `<pre>`; binary/truncated captions |
| `packages/api/tests/code.test.ts` | Modify | Add source route tests |
| `packages/web/src/routes/code.test.tsx` | Modify | Add source render tests |

---

## Task 1: Core — `CodeSource` interface + `codeSource()` function

**Files:**
- Modify: `packages/core/src/codeview.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `export interface CodeSource { path: string; content: string; truncated: boolean; binary: boolean; size: number }`
- Produces: `export async function codeSource(fh: Freehold, path: string): Promise<CodeSource | null>`

- [ ] **Step 1: Add the `CodeSource` interface to codeview.ts**

Open `packages/core/src/codeview.ts`. After the `RegionRule` interface (around line 62), add:

```ts
export interface CodeSource {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}
```

- [ ] **Step 2: Add the necessary imports to codeview.ts**

At the top of `packages/core/src/codeview.ts`, after the existing imports (lines 13-14), add:

```ts
import { access, readFile, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
```

- [ ] **Step 3: Implement `codeSource()` at the end of codeview.ts**

Append this function after the closing brace of `codeRegions`:

```ts
// ── codeSource ────────────────────────────────────────────────────────────────

const MAX_BYTES = 512 * 1024; // 512 KB
const BINARY_PROBE = 8 * 1024; // 8 KB

/**
 * Read the working-tree content of a file relative to the checkout directory.
 *
 * Returns null when the file does not exist (caller → 404).
 * Rejects with an Error for path traversal attempts.
 */
export async function codeSource(fh: Freehold, path: string): Promise<CodeSource | null> {
  // Guard: reject absolute paths and paths containing ".."
  if (path.startsWith("/") || path.includes("..")) {
    throw new Error("path traversal rejected");
  }

  const resolved = normalize(join(fh.graphDir, path));

  // Guard: resolved path must be a strict descendant of graphDir
  const base = fh.graphDir.endsWith(sep) ? fh.graphDir : fh.graphDir + sep;
  if (!resolved.startsWith(base)) {
    throw new Error("path traversal rejected");
  }

  // Check existence without throwing
  try {
    await access(resolved);
  } catch {
    return null;
  }

  const info = await stat(resolved);
  const size = info.size;

  // Read up to MAX_BYTES + 1 to detect truncation
  const buf = await readFile(resolved);
  const truncated = buf.length > MAX_BYTES;
  const slice = truncated ? buf.subarray(0, MAX_BYTES) : buf;

  // Binary detection: NUL byte in first BINARY_PROBE bytes
  const probe = slice.subarray(0, BINARY_PROBE);
  const binary = probe.includes(0);

  if (binary) {
    return { path, content: "", truncated: false, binary: true, size };
  }

  return {
    path,
    content: slice.toString("utf-8"),
    truncated,
    binary: false,
    size,
  };
}
```

- [ ] **Step 4: Export `codeSource` and `CodeSource` from core's index.ts**

In `packages/core/src/index.ts`, find the code graph views section (around line 117):

```ts
// Code graph views
export {
  codeTree,
  codeFile,
  codeItem,
  codeNeighborhood,
  codeRegions,
} from "./codeview.js";
export type {
  CodeTreeNode,
  CodeItem,
  CodeFileView,
  CodeItemView,
  CodeNeighborhood,
  RegionRule,
} from "./codeview.js";
```

Change it to:

```ts
// Code graph views
export {
  codeTree,
  codeFile,
  codeItem,
  codeNeighborhood,
  codeRegions,
  codeSource,
} from "./codeview.js";
export type {
  CodeTreeNode,
  CodeItem,
  CodeFileView,
  CodeItemView,
  CodeNeighborhood,
  RegionRule,
  CodeSource,
} from "./codeview.js";
```

- [ ] **Step 5: Run lint to confirm no biome errors in the core package**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/core exec biome check . 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
git add packages/core/src/codeview.ts packages/core/src/index.ts
git commit -m "feat(core): add CodeSource interface and codeSource() working-tree reader"
```

---

## Task 2: Core tests — `codeSource()` unit tests

**Files:**
- Modify: `packages/core/tests/codeview.test.ts`

**Interfaces:**
- Consumes: `codeSource(fh: Freehold, path: string): Promise<CodeSource | null>` from Task 1

**Notes on fixture:** The existing `beforeAll` in `codeview.test.ts` creates a real git repo in a temp dir at `repoDir`. That's the `graphDir` — files written there are readable by `codeSource`. The `fh.graphDir` equals `repoDir`.

- [ ] **Step 1: Write the failing tests (append to codeview.test.ts)**

Add a new `describe("codeSource", ...)` block at the bottom of `packages/core/tests/codeview.test.ts`. The existing `fh` fixture already has `graphDir = repoDir` where files were created by git. We can write additional test files into `fh.graphDir` inside a nested `beforeAll` or inline (the outer `beforeAll` runs first).

Add these imports at the top of the file alongside the existing ones:

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { codeSource } from "../src/codeview.js";
```

Then at the bottom of the file, add:

```ts
describe("codeSource", () => {
  test("returns null for a file that does not exist", async () => {
    const result = await codeSource(fh, "src/nonexistent-xyz.rs");
    expect(result).toBeNull();
  });

  test("rejects path traversal with ..", async () => {
    await expect(codeSource(fh, "../escape.txt")).rejects.toThrow("path traversal rejected");
  });

  test("rejects absolute paths", async () => {
    await expect(codeSource(fh, "/etc/passwd")).rejects.toThrow("path traversal rejected");
  });

  test("happy path: reads a file and returns content round-trip", async () => {
    const text = "hello codeSource\nline two\n";
    writeFileSync(pathJoin(fh.graphDir, "cs-test.txt"), text, "utf-8");
    const result = await codeSource(fh, "cs-test.txt");
    expect(result).not.toBeNull();
    expect(result!.content).toBe(text);
    expect(result!.truncated).toBe(false);
    expect(result!.binary).toBe(false);
    expect(result!.size).toBeGreaterThan(0);
    expect(result!.path).toBe("cs-test.txt");
  });

  test("truncation: files over 512 KB set truncated:true and content is 512 KB", async () => {
    // Write a 600 KB file
    const big = Buffer.alloc(600 * 1024, 65); // ASCII 'A'
    writeFileSync(pathJoin(fh.graphDir, "cs-big.txt"), big);
    const result = await codeSource(fh, "cs-big.txt");
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    // content should be exactly 512 KB of text
    expect(Buffer.byteLength(result!.content, "utf-8")).toBe(512 * 1024);
    expect(result!.binary).toBe(false);
  });

  test("binary detection: file with NUL byte → binary:true, content empty", async () => {
    const buf = Buffer.from([72, 101, 0, 108, 108, 111]); // "He\0llo"
    writeFileSync(pathJoin(fh.graphDir, "cs-binary.bin"), buf);
    const result = await codeSource(fh, "cs-binary.bin");
    expect(result).not.toBeNull();
    expect(result!.binary).toBe(true);
    expect(result!.content).toBe("");
    expect(result!.truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail (function exists but traversal test may differ)**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/core test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|✗|codeSource)" | head -30
```

Expected: the `codeSource` describe block tests should pass since the implementation is already in from Task 1.

- [ ] **Step 3: Run full core tests to confirm all pass**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/core test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
git add packages/core/tests/codeview.test.ts
git commit -m "test(core): codeSource — traversal guard, missing→null, truncation, binary, happy path"
```

---

## Task 3: API route + OpenAPI schema + openapi.json regen

**Files:**
- Modify: `packages/api/src/routes/code.ts`
- Modify: `packages/api/src/openapi.ts`
- Regenerated: `packages/api/openapi.json` (via `pnpm openapi`)

**Interfaces:**
- Consumes: `codeSource(fh, path)` from `@freehold/core` (Task 1)
- Produces: `GET /code/source?path=` → `CodeSource` JSON or 400/404

- [ ] **Step 1: Add the route handler to `packages/api/src/routes/code.ts`**

First, update the import at line 1 to include `codeSource`:

```ts
import { codeFile, codeItem, codeNeighborhood, codeRegions, codeSource, codeTree } from "@freehold/core";
```

Then append the new handler after the existing `GET /code/regions` handler (after line 80):

```ts
// GET /code/source?path=
codeRouter.get("/code/source", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }
  const path = c.req.query("path");
  if (!path) {
    return c.json({ error: "path query parameter is required" }, 400);
  }
  let source: Awaited<ReturnType<typeof codeSource>>;
  try {
    source = await codeSource(fh, path);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("path traversal")) {
      return c.json({ error: "invalid path" }, 400);
    }
    throw err;
  }
  if (!source) {
    return c.json({ error: "file not found" }, 404);
  }
  return c.json(source);
});
```

- [ ] **Step 2: Add the `CodeSource` zod schema to `packages/api/src/openapi.ts`**

Find the existing code view schemas section (around line 153 where `CodeItem` is defined). After the `CodeNeighborhood` schema definition (around line 224), add:

```ts
const CodeSource = z
  .object({
    path: z.string(),
    content: z.string().openapi({ description: "UTF-8 source text (empty when binary)" }),
    truncated: z.boolean().openapi({ description: "True when file exceeded 512 KB read limit" }),
    binary: z.boolean().openapi({ description: "True when a NUL byte was detected in the first 8 KB" }),
    size: z.number().int().openapi({ description: "File size in bytes (full file, not truncated)" }),
  })
  .openapi("CodeSource");
```

- [ ] **Step 3: Register the `/api/v1/code/source` path in `openapi.ts`**

In the same file, find the code view — neighborhood `registry.registerPath(...)` block (ends around line 1068). After it, add:

```ts
  // Code view — source
  registry.registerPath({
    method: "get",
    path: "/api/v1/code/source",
    summary: "Working-tree file source",
    description: "Read raw file content from the checkout working tree. Binary files return content:\"\". Files over 512 KB are truncated.",
    security: auth,
    request: {
      query: z.object({
        path: z.string().openapi({ description: "Repo-relative file path" }),
      }),
    },
    responses: {
      "200": {
        description: "File source content",
        content: { "application/json": { schema: CodeSource } },
      },
      "400": { description: "Not a repo graph, missing path param, or path traversal attempt" },
      "401": { description: "Unauthorized" },
      "404": { description: "File not found on disk" },
    },
  });
```

- [ ] **Step 4: Regenerate `openapi.json`**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/api
pnpm openapi 2>&1
```

Expected: exits 0, `openapi.json` is updated.

- [ ] **Step 5: Verify the schema appears in openapi.json**

```bash
grep -c "CodeSource" /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/api/openapi.json
```

Expected: at least 2 (schema definition + path reference).

- [ ] **Step 6: Run lint on the api package**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/api exec biome check . 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
git add packages/api/src/routes/code.ts packages/api/src/openapi.ts packages/api/openapi.json
git commit -m "feat(api): GET /code/source?path= — working-tree file content with traversal guard"
```

---

## Task 4: API route tests

**Files:**
- Modify: `packages/api/tests/code.test.ts`

**Interfaces:**
- Consumes: `GET /api/v1/graphs/:id/code/source?path=` from Task 3

**Notes:** The existing `beforeAll` in `code.test.ts` creates a real `repoDir` temp directory with a git repo and writes `README.md` to it. We can write additional files there for source tests. The `repoDir` variable is in module scope and available throughout the file.

- [ ] **Step 1: Write the new test group at the bottom of `packages/api/tests/code.test.ts`**

Append after the last `describe` block (after line 439):

```ts
// ---------------------------------------------------------------------------
// Source route — GET /code/source
// ---------------------------------------------------------------------------

describe("GET /api/v1/code/source on memory graph returns 400", () => {
  test("returns 400 on default memory graph", async () => {
    const { status, body } = await req("GET", "/api/v1/code/source?path=README.md");
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("code view is only available for repo graphs");
  });

  test("returns 400 when path param is missing", async () => {
    const { status } = await req("GET", `/api/v1/graphs/${repoGraphId}/code/source`);
    expect(status).toBe(400);
  });
});

describe("GET /api/v1/graphs/:id/code/source on repo graph", () => {
  test("returns 200 with content for an existing file (README.md)", async () => {
    // README.md was written to repoDir in beforeAll: "# test"
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/code/source?path=README.md`
    );
    expect(status).toBe(200);
    const b = body as { path: string; content: string; truncated: boolean; binary: boolean; size: number };
    expect(b.path).toBe("README.md");
    expect(b.content).toContain("test");
    expect(b.truncated).toBe(false);
    expect(b.binary).toBe(false);
    expect(b.size).toBeGreaterThan(0);
  });

  test("returns 404 for a file not present on disk", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/code/source?path=src/does-not-exist.ts`
    );
    expect(status).toBe(404);
    const b = body as { error: string };
    expect(b.error).toBe("file not found");
  });

  test("returns 400 for a traversal path (../)", async () => {
    const { status } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/code/source?path=../etc/passwd`
    );
    expect(status).toBe(400);
  });
});
```

- [ ] **Step 2: Run only the source describe blocks to verify they pass**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/api test -- --reporter=verbose 2>&1 | grep -E "(source|PASS|FAIL|✓|✗)" | head -30
```

Expected: all source-related tests pass.

- [ ] **Step 3: Run full api tests**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/api test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
git add packages/api/tests/code.test.ts
git commit -m "test(api): GET /code/source — 400 memory graph, 400 missing path, 404 missing file, 200 content, 400 traversal"
```

---

## Task 5: Client method + type re-export + regen types

**Files:**
- Modify: `packages/client/src/client.ts`
- Regenerated: `packages/client/src/types.ts` (via `pnpm generate`)

**Interfaces:**
- Consumes: `CodeSource` schema in `openapi.json` (Task 3)
- Produces: `async codeSource(path: string): Promise<CodeSource>`; `export type CodeSource = Schemas["CodeSource"]`

- [ ] **Step 1: Regenerate types from the updated openapi.json**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/client
pnpm generate 2>&1
```

Expected: exits 0, `src/types.ts` now contains `CodeSource` in `components.schemas`.

- [ ] **Step 2: Verify the type exists**

```bash
grep "CodeSource" /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/client/src/types.ts | head -5
```

Expected: at least one hit with the CodeSource schema shape.

- [ ] **Step 3: Add the `CodeSource` type re-export to `client.ts`**

In `packages/client/src/client.ts`, find the existing code view type re-exports (around lines 46-50):

```ts
export type CodeItem = Schemas["CodeItem"];
export type CodeFileView = Schemas["CodeFileView"];
export type CodeItemView = Schemas["CodeItemView"];
export type RegionRule = Schemas["RegionRule"];
export type CodeNeighborhood = Schemas["CodeNeighborhood"];
```

Add `CodeSource` after:

```ts
export type CodeItem = Schemas["CodeItem"];
export type CodeFileView = Schemas["CodeFileView"];
export type CodeItemView = Schemas["CodeItemView"];
export type RegionRule = Schemas["RegionRule"];
export type CodeNeighborhood = Schemas["CodeNeighborhood"];
export type CodeSource = Schemas["CodeSource"];
```

- [ ] **Step 4: Add the `codeSource()` method to `FreeholdClient`**

Find the existing code view methods in `client.ts` (around lines 395-418):

```ts
  /** GET /api/v1/code/neighborhood?path= — nodes and edges one hop from the file */
  async codeNeighborhood(path: string): Promise<CodeNeighborhood> {
    return this.fetch<CodeNeighborhood>("GET", "/api/v1/code/neighborhood", { query: { path } });
  }
```

After that method, add:

```ts
  /** GET /api/v1/code/source?path= — working-tree file content */
  async codeSource(path: string): Promise<CodeSource> {
    return this.fetch<CodeSource>("GET", "/api/v1/code/source", { query: { path } });
  }
```

- [ ] **Step 5: Run client typecheck**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/client
pnpm typecheck 2>&1
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
git add packages/client/src/client.ts packages/client/src/types.ts
git commit -m "feat(client): codeSource() method + CodeSource type re-export; regen types from openapi"
```

---

## Task 6: Web hook `useCodeSource`

**Files:**
- Modify: `packages/web/src/lib/hooks.ts`

**Interfaces:**
- Consumes: `apiClient.codeSource(path: string): Promise<CodeSource>` from Task 5
- Produces: `export function useCodeSource(path: string | undefined)` — same shape as `useCodeFile`

- [ ] **Step 1: Add `CodeSource` to the type imports in hooks.ts**

In `packages/web/src/lib/hooks.ts`, find the import from `@freehold/client` (line 3):

```ts
import type { CodeFileView, CodeItemView, CodeNeighborhood, RegionRule, SessionGraphEntry } from "@freehold/client";
```

Add `CodeSource`:

```ts
import type { CodeFileView, CodeItemView, CodeNeighborhood, RegionRule, SessionGraphEntry, CodeSource } from "@freehold/client";
```

- [ ] **Step 2: Add the `useCodeSource` hook**

Find the `useCodeFile` hook (around line 207) as a reference. After `useCodeNeighborhood` (around line 243), add:

```ts
/** Working-tree source content for a file path. null → file not on disk (404). */
export function useCodeSource(path: string | undefined) {
  return useQuery({
    queryKey: ["code-source", path],
    queryFn: () => apiClient.codeSource(path!),
    enabled: !!path,
    retry: false,
  });
}
```

- [ ] **Step 3: Add `CodeSource` to the re-export at the bottom of hooks.ts**

Find the re-exports block at the bottom (around line 299):

```ts
// Re-export types for convenience in route components
export type { CodeFileView, CodeItemView, CodeNeighborhood, RegionRule };
```

Add `CodeSource`:

```ts
// Re-export types for convenience in route components
export type { CodeFileView, CodeItemView, CodeNeighborhood, RegionRule, CodeSource };
```

- [ ] **Step 4: Also add `apiClient.codeSource` to the `vi.mock("~/lib/api")` stub in web tests**

This step is preparation for Task 8. For now just verify the type checks work.

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/web
pnpm typecheck 2>&1 | head -20
```

Expected: no errors for hooks.ts. (Other errors may exist if code.file.tsx is not yet updated — that's fine.)

- [ ] **Step 5: Commit**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
git add packages/web/src/lib/hooks.ts
git commit -m "feat(web): useCodeSource hook — queries /code/source, retry:false, parallel with useCodeFile"
```

---

## Task 7: Render source in `code.file.tsx`

**Files:**
- Modify: `packages/web/src/routes/code.file.tsx`

**Interfaces:**
- Consumes: `useCodeSource(path: string | undefined)` from Task 6
- Consumes: `useCodeFile(path: string | undefined)` (existing)
- Produces: `SourcePanel` component rendered above declared items; handles binary, truncated, loading states

**Design decisions:**
- Fetch `useCodeSource` and `useCodeFile` in parallel inside `CodeFilePage`
- If `codeFile` 404s but `codeSource` succeeds: show source panel + existing not-indexed hint (do NOT block on codeFile)
- If `codeSource` 404s: silently omit the source panel
- Binary: show `<p>binary file — not rendered</p>` instead of `<pre>`
- Truncated: show `<p>truncated at 512 KB</p>` caption below the `<pre>`
- Line numbers: two-column layout inside the `<pre>` — left col is muted line numbers, right col is code. Use `<span>` elements.

- [ ] **Step 1: Add `useCodeSource` to the imports in code.file.tsx**

Find line 3 of `packages/web/src/routes/code.file.tsx`:

```ts
import { useClassify, useCodeFile, useGitHubBlobUrl } from "~/lib/hooks";
```

Change to:

```ts
import { useClassify, useCodeFile, useCodeSource, useGitHubBlobUrl } from "~/lib/hooks";
```

- [ ] **Step 2: Add the `SourcePanel` component**

Add this component before `CodeFilePage` (before line 80):

```tsx
interface SourcePanelProps {
  isLoading: boolean;
  binary: boolean;
  truncated: boolean;
  content: string;
}

/** Line-numbered source code panel. */
function SourcePanel({ isLoading, binary, truncated, content }: SourcePanelProps) {
  if (isLoading) {
    return <p className="text-xs text-(--fg-muted)">Loading source…</p>;
  }
  if (binary) {
    return (
      <p className="font-mono text-xs text-(--fg-muted) border border-(--border) bg-(--bg-subtle) px-3 py-2">
        binary file — not rendered
      </p>
    );
  }
  const lines = content.split("\n");
  // Remove trailing empty line created by a trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const lineCount = lines.length;
  const gutterWidth = String(lineCount).length;
  return (
    <div className="space-y-1">
      <pre className="overflow-x-auto border border-(--border) bg-(--bg-subtle) p-3 font-mono text-xs leading-5 text-(--fg)">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span
              className="select-none pr-4 text-right text-(--fg-muted)"
              style={{ minWidth: `${gutterWidth + 1}ch` }}
              aria-hidden
            >
              {i + 1}
            </span>
            <span>{line}</span>
          </div>
        ))}
      </pre>
      {truncated && (
        <p className="font-mono text-[11px] text-(--fg-muted)">truncated at 512 KB</p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Update `CodeFilePage` to fetch source and compose the two results**

Replace the existing `CodeFilePage` function body. The current function starts at line 80 and ends at line 216.

The updated function keeps the existing structure but adds `useCodeSource` and inserts `SourcePanel` above the declared items section:

```tsx
/** File page — shows path, language, source, declared items. */
export function CodeFilePage({ filePath }: { filePath?: string }) {
  const { data, isLoading, isError } = useCodeFile(filePath);
  const { data: sourceData, isLoading: sourceLoading } = useCodeSource(filePath);
  const blobUrl = useGitHubBlobUrl(filePath);

  if (!filePath) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl">
        <p className="text-sm text-(--fg-muted)">No file path specified.</p>
      </div>
    );
  }

  if (isLoading) {
    return <p className="text-xs text-(--fg-muted)">Loading…</p>;
  }

  // If codeFile 404d but source is available, still show source + hint
  const fileUnavailable = isError || !data;

  if (fileUnavailable && !sourceData && !sourceLoading) {
    return (
      <div className="border border-(--border) bg-(--bg-subtle) p-6 max-w-xl space-y-2">
        <p className="text-sm font-semibold text-(--fg)">{filePath}</p>
        <p className="text-sm text-(--fg-muted)">
          This file has not been indexed yet. Run{" "}
          <code className="border border-(--border) bg-(--bg-subtle) px-1 py-0.5 font-mono text-[11px]">
            allod git index
          </code>{" "}
          to index the repository.
        </p>
      </div>
    );
  }

  const items: CodeItem[] = data?.items ?? [];

  return (
    <article className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-1.5">
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 3,
              background: "var(--color-accent)",
            }}
            aria-hidden
          />
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-(--fg-muted)">
            SOURCE FILE
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold tracking-tight font-mono">
            {data?.path ?? filePath}
          </h2>
          <Link
            to="/code/graph"
            search={{ path: filePath }}
            data-testid="graph-tab-link"
            className="font-mono text-[11px] uppercase tracking-[0.06em] border border-(--border) px-2 py-0.5 text-(--fg-muted) hover:text-(--fg) hover:bg-(--bg-subtle)"
          >
            Graph
          </Link>
        </div>
        {blobUrl && (
          <a
            href={blobUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="github-blob-link"
            className="font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) underline"
          >
            View on GitHub →
          </a>
        )}
        <div className="flex flex-wrap gap-1.5">
          {data?.language && (
            <span className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)">
              {data.language}
            </span>
          )}
          {(data?.terms ?? []).map((t) => (
            <span
              key={t}
              className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)"
            >
              {t.split("@")[0]}
            </span>
          ))}
        </div>
      </header>

      {/* Not-indexed hint when file is on disk but not in the graph */}
      {fileUnavailable && sourceData && (
        <div className="border border-(--border) bg-(--bg-subtle) px-3 py-2 space-y-1">
          <p className="text-xs text-(--fg-muted)">
            File is not indexed yet. Run{" "}
            <code className="border border-(--border) bg-(--bg-subtle) px-1 py-0.5 font-mono text-[11px]">
              allod git index
            </code>{" "}
            to add it to the code graph.
          </p>
        </div>
      )}

      {/* Source panel */}
      {(sourceData ?? sourceLoading) && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-(--fg)">Source</h3>
          {sourceLoading ? (
            <SourcePanel isLoading content="" binary={false} truncated={false} />
          ) : sourceData ? (
            <SourcePanel
              isLoading={false}
              binary={sourceData.binary}
              truncated={sourceData.truncated}
              content={sourceData.content}
            />
          ) : null}
        </section>
      )}

      {items.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-(--fg)">Declared items</h3>
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.nodeId}
                className="border border-(--border) bg-(--bg-subtle) px-3 py-2 space-y-1"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-semibold text-(--fg)">{item.name}</span>
                  <span className="font-mono text-[10px] uppercase border border-(--border) px-1 py-0.5 text-(--fg-muted)">
                    {item.type}
                  </span>
                  {(item.terms ?? []).map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center border border-(--border) bg-(--bg-subtle) px-1.5 py-0.5 text-[11px] font-mono text-(--fg-muted)"
                    >
                      {t.split("@")[0]}
                    </span>
                  ))}
                </div>
                {item.signature && (
                  <p className="font-mono text-xs text-(--fg-muted) truncate">{item.signature}</p>
                )}
                {item.span && (
                  <p className="font-mono text-[10px] text-(--fg-muted)">{item.span}</p>
                )}
                <div className="pt-1">
                  <Link
                    to="/code/item"
                    search={{ nodeId: item.nodeId }}
                    className="font-mono text-[11px] text-(--fg-muted) hover:text-(--fg) underline"
                  >
                    View blast radius →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && <ClassifyPanel nodeId={data.nodeId} />}
    </article>
  );
}
```

- [ ] **Step 4: Run web typecheck**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/web
pnpm typecheck 2>&1 | head -40
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
git add packages/web/src/routes/code.file.tsx
git commit -m "feat(web): render inline source above declared items with line numbers; binary + truncated captions"
```

---

## Task 8: Web UI tests

**Files:**
- Modify: `packages/web/src/routes/code.test.tsx`

**Interfaces:**
- Consumes: `useCodeSource` hook from Task 6
- Consumes: updated `code.file.tsx` from Task 7

**Test approach:** The existing `code.test.tsx` mocks `~/lib/hooks` with `vi.mock`. We add `useCodeSource` to the mock factory and extend `setupHooks` to accept a `source` override.

- [ ] **Step 1: Add `useCodeSource` to the `vi.mock("~/lib/hooks", ...)` factory**

In `packages/web/src/routes/code.test.tsx`, find the `vi.mock("~/lib/hooks", ...)` block (starts at line 8). Add `useCodeSource: vi.fn(),` to the factory object alongside the other hooks:

```ts
vi.mock("~/lib/hooks", () => ({
  usePending: vi.fn(),
  useRecall: vi.fn(),
  useRecentMemories: vi.fn(),
  useMemoryIndex: vi.fn(),
  useMemoryGraph: vi.fn(),
  useUpdateMemory: vi.fn(),
  usePrincipals: vi.fn(),
  useVerify: vi.fn(),
  useSchema: vi.fn(),
  useEntity: vi.fn(),
  useSession: vi.fn(),
  useGraphs: vi.fn().mockReturnValue({ graphs: [], defaultGraph: "main" }),
  useActiveGraph: vi.fn().mockReturnValue({ activeGraphId: "main", setActiveGraphId: vi.fn() }),
  useCodeTree: vi.fn(),
  useCodeFile: vi.fn(),
  useCodeItem: vi.fn(),
  useCodeRegions: vi.fn(),
  useCodeSource: vi.fn(),            // ← add this
  useClassify: vi.fn(),
  useListGraphs: vi.fn(),
  useGitHubBlobUrl: vi.fn().mockReturnValue(null),
  useCodeNeighborhood: vi.fn(),
  useGitProposals: vi.fn().mockReturnValue({ data: { proposals: [] }, isLoading: false, isError: false, error: null }),
}));
```

Also add `codeSource: vi.fn(),` to the `vi.mock("~/lib/api", ...)` factory's `apiClient` object.

- [ ] **Step 2: Define a sample source fixture and extend `setupHooks`**

After the existing fixture constants (around line 113), add:

```ts
const sampleSource = {
  path: "src/main.ts",
  content: "function main() {\n  console.log('hello');\n}\n",
  truncated: false,
  binary: false,
  size: 44,
};

const binarySource = {
  path: "src/main.ts",
  content: "",
  truncated: false,
  binary: true,
  size: 100,
};

const truncatedSource = {
  path: "src/main.ts",
  content: "a".repeat(512 * 1024),
  truncated: true,
  binary: false,
  size: 700 * 1024,
};
```

In the `setupHooks` function signature, add a `source` parameter:

```ts
function setupHooks(
  overrides: {
    tree?: unknown[];
    fileView?: typeof sampleFileView | null;
    fileLoading?: boolean;
    regions?: typeof sampleRegions;
    activeGraphId?: string;
    graphs?: { id: string; name: string; kind: GraphKind }[];
    blobUrl?: string | null;
    neighborhood?: typeof sampleNeighborhood | null;
    source?: typeof sampleSource | null;          // ← add
    sourceLoading?: boolean;                        // ← add
  } = {}
) {
```

At the end of the `setupHooks` body, add the `useCodeSource` mock:

```ts
  vi.mocked(hooks.useCodeSource).mockReturnValue({
    data: overrides.source === null ? undefined : (overrides.source ?? sampleSource),
    isLoading: overrides.sourceLoading ?? false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCodeSource>);
```

- [ ] **Step 3: Add the new test cases**

In the `describe("File page", ...)` block (around line 296), add new test cases alongside the existing ones:

```ts
    it("renders source with line numbers when source data is present", async () => {
      await renderCode({}, "/code/file?path=src%2Fmain.ts");
      // Source section heading
      expect(screen.getByText("Source")).toBeInTheDocument();
      // Line number 1
      expect(screen.getByText("1")).toBeInTheDocument();
      // Some code content
      expect(screen.getByText(/function main/)).toBeInTheDocument();
    });

    it("shows binary caption when source is a binary file", async () => {
      await renderCode({ source: binarySource }, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByText(/binary file — not rendered/)).toBeInTheDocument();
    });

    it("shows truncated caption when source was truncated", async () => {
      await renderCode({ source: truncatedSource }, "/code/file?path=src%2Fmain.ts");
      expect(screen.getByText(/truncated at 512 KB/)).toBeInTheDocument();
    });

    it("shows source + not-indexed hint when file is on disk but not indexed", async () => {
      // fileView: null → codeFile 404; source succeeds
      await renderCode({ fileView: null, source: sampleSource }, "/code/file?path=src%2Funknown.ts");
      // The not-indexed inline hint (not the full-page fallback)
      expect(screen.getByText(/allod git index/)).toBeInTheDocument();
      // Still shows source
      expect(screen.getByText("Source")).toBeInTheDocument();
    });

    it("shows full not-indexed page when both codeFile and codeSource are unavailable", async () => {
      await renderCode({ fileView: null, source: null }, "/code/file?path=src%2Funknown.ts");
      expect(screen.getByText(/allod git index/)).toBeInTheDocument();
      // Source heading should NOT appear
      expect(screen.queryByText("Source")).not.toBeInTheDocument();
    });
```

- [ ] **Step 4: Run the web tests**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/web test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
git add packages/web/src/routes/code.test.tsx
git commit -m "test(web): source panel — line numbers render, binary caption, truncated caption, unindexed-but-on-disk composition"
```

---

## Task 9: Final lint + test + build verification

**Files:** None (verification only)

- [ ] **Step 1: Run root-level lint**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm lint 2>&1 | tail -20
```

Expected: no errors. Fix any that appear (usually import ordering or unused imports).

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm test 2>&1 | tail -30
```

Expected: all tests pass across all packages.

- [ ] **Step 3: Run web build to catch TSX compilation issues**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/packages/web
pnpm build 2>&1 | tail -20
```

Expected: exits 0 with no TypeScript errors.

- [ ] **Step 4: Create the report file**

```bash
mkdir -p /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/.superpowers/sdd
```

Create `/Users/conner/code/freehold/.claude/worktrees/governed-review-m4/.superpowers/sdd/code-source-inline-report.md` with:
- status (pass/fail)
- commit hash of HEAD
- one-line test summary
- any concerns

- [ ] **Step 5: Final commit if lint/test fixes were needed**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
git add -p   # stage only lint fixes
git commit -m "style: biome pass after code-source-inline feature"
```

Only create this commit if step 1 required fixes.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `CodeSource` interface with 5 fields | Task 1 |
| `codeSource(fh, path)` function | Task 1 |
| Path traversal guard (`..\` and absolute) | Task 1 |
| null → 404 | Task 1 + Task 3 |
| 512 KB truncation + `truncated:true` | Task 1 |
| Binary detection via NUL byte in 8 KB probe | Task 1 |
| Binary → `content:""` | Task 1 |
| Working-tree read (no git show) | Task 1 |
| `GET /code/source?path=` route | Task 3 |
| repo-only 400 guard | Task 3 |
| 400 missing path | Task 3 |
| 404 `{error:"file not found"}` | Task 3 |
| openapi.ts `CodeSource` schema | Task 3 |
| Regen openapi.json | Task 3 |
| Regen client types | Task 5 |
| `codeSource(path)` client method | Task 5 |
| `useCodeSource(path)` hook | Task 6 |
| Source rendered above declared items | Task 7 |
| Line-numbered `<pre>` | Task 7 |
| Binary → caption | Task 7 |
| Truncated → caption | Task 7 |
| Graceful compose: file on disk but unindexed | Task 7 |
| Core tests: traversal rejected `../x` + absolute | Task 2 |
| Core tests: missing → null | Task 2 |
| Core tests: truncation flag with >512KB fixture | Task 2 |
| Core tests: binary detection with NUL-byte file | Task 2 |
| Core tests: happy path content round-trip | Task 2 |
| API tests: 400 memory graph | Task 4 |
| API tests: 400 no path | Task 4 |
| API tests: 404 missing | Task 4 |
| API tests: 200 content | Task 4 |
| Web tests: source renders with line numbers | Task 8 |
| Web tests: binary caption | Task 8 |
| Web tests: unindexed-but-on-disk composition renders source + hint | Task 8 |

**Placeholder scan:** No TBDs, all code blocks are complete.

**Type consistency:** `CodeSource` defined in Task 1 is used identically in Tasks 3, 5, 6, 7, 8. `codeSource()` signature consistent across Tasks 1, 3, 4. `useCodeSource()` signature consistent in Tasks 6, 7, 8.
