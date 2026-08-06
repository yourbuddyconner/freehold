# w4-item: function detail page enhancement

## Status

Complete. All gates green.

## What was implemented

### 1. Inline source (done)

The item page now fetches the file's working-tree source via `useCodeSource(item.filePath)`, parses the `span` field (`"line:col-line:col"` format), slices the content to the item's exact line range, and renders it with `PierreFile`. A "Lines N–M" label and "View full file →" link appear above the snippet. When the item has no parseable span, the full file is rendered. The Pierre `File` component has no `startingLine` display offset option; the sliced content renders with its own line numbers starting at 1.

### 2. Navigable relations (done)

Callers and callees are now rich rows: each shows the function name (linked to `/code/item?nodeId=…`), a type badge, signature, and the declaring file path (linked to `/code/file?path=…`). Rows are grouped by file; each group has a file group header with a file link and per-group count. Section headers include total counts.

`filePath` was added to `CodeItem` in `codeview.ts` (additive, optional). The `loadItems` helper in `codeItem()` now resolves the declaring file for each caller/callee using the already-loaded edges (one extra DB query per batch, not per item). The OpenAPI schema and client types were regenerated; client drift check passes.

### 3. Governance context (done)

`useCodeRegions` is fetched on the item page. The item's `filePath` is matched client-side against each `RegionRule.paths` array. Matching rules appear as small chips ("Governed by: policy/auth-review (auth)"). The section is hidden when no rules match.

### 4. Breadcrumb + file link (done)

The header now shows a path breadcrumb for `item.filePath`: each directory segment is rendered as plain text; the final filename segment links to `/code/file?path=…`. The old flat `<Link>` to the file page is replaced by this breadcrumb.

## Additive changes outside packages/web

- `packages/core/src/codeview.ts`: `CodeItem.filePath?: string` added; `loadItems()` now resolves file paths for each caller/callee.
- `packages/api/src/openapi.ts`: `CodeItem` schema gains `filePath?: string`.
- `packages/api/openapi.json`: regenerated via `pnpm --filter @freehold/api openapi`.
- `packages/client/src/types.ts`: regenerated via `pnpm --filter @freehold/client generate`. Drift check passes.

All changes are backward-compatible: `filePath` is optional in every schema, and existing callers that don't use it are unaffected.

## Skipped

- **Line-number offset in the source view**: Pierre `File` component has no `startingLine` display offset. Sliced content shows its own 1-based line numbers, not the true file line numbers. The label "Lines N–M" and "View full file →" link make the offset clear.
- **Caller/callee terms display**: `CodeItem.terms` is present in the data but not shown in relation rows to keep them scannable. Could be added with a filter chip pattern later.
