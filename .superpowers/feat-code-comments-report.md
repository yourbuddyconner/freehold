# feat-code-comments implementation report

## Status: complete

## Commit

`184d7e6` — feat: line comments on workspace files

## Test summary

- core: 21 test files, 211 passed (1 skipped) — 6 new codecomments tests
- api: 16 test files, 214 passed — 8 new code-comments tests
- web: 26 test files, 374 passed — 8 new code.file tests
- lint: clean (biome)
- build: all packages pass, client drift check passes

## What was built

### packages/core/src/codecomments.ts (NEW)

- `postCodeComment(fh, { path, span, body, by })`: two-phase signed commit
  (`commit_payload → resolveKey → signPayload → commit_signed`), same pattern
  as `decideGit`. Anchor format: `git:<repo>#<HEAD sha>:<path>`. Wraps both
  wasm principal errors and key-file lookup failures in `CodeCommentKeyMissingError`.
- `listCodeComments(fh, path)`: scans admitted log + pending proposals for
  `review/ReviewComment@1` nodes whose anchor ends with `:<path>` exactly.
  Returns `{ commentId, body, span, status, author, anchorSha, currentHead }`.

### packages/api/src/routes/code.ts (MODIFIED)

- `GET /code/comments?path=`: lists code comments for the path.
- `POST /code/comments { path, span, body, by }`: creates a comment; 409 on
  `CodeCommentKeyMissingError`, same guard pattern as other code routes.

### packages/api/openapi.json + packages/client (REGENERATED)

- Added schemas: `CodeComment`, `PostCodeCommentBody`, `PostCodeCommentResult`.
- Added client methods: `listCodeComments(path)`, `postCodeComment(body)`.
- Drift check passes.

### packages/web/src/lib/hooks.ts (MODIFIED)

- `useCodeComments(path)`: query hook.
- `usePostCodeComment(path)`: mutation hook with cache invalidation.
- `CodeComment` type re-exported.
- `useActiveGraphPrincipal` was already exported; used in CodeFilePage.

### packages/web/src/routes/code.file.tsx (MODIFIED)

- `SourcePanel` gains `comments`, `onLineNumberClick` props; builds
  `LineAnnotation<CommentAnnotationMeta>[]` from comments; passes
  `onLineNumberClick` and `renderAnnotation` to `PierreFile`.
- `renderAnnotation`: quiet card with body, author, "posted against an older
  revision" caption when `currentHead` is false.
- `CommentComposer`: small form (span prefilled, textarea, Save/Cancel).
- `CodeFilePage`: wires `useCodeComments`, `usePostCodeComment`,
  `useActiveGraphPrincipal`; composer opens on line number click; comment
  count chip in metadata header.

## Concerns

1. **Review ontology must be installed** in the graph for `review/ReviewComment@1`
   nodes to be admitted. `postCodeComment` will succeed in creating the changeset
   but it will be held pending governance if the ontology is not present.
   The existing gitreview flow has the same dependency; no special handling added.

2. **`commit_payload` error pattern**: the wasm layer throws "no key for principal"
   when the `by` principal is not registered in the graph. The API catches this via
   string matching on the error message and maps it to 409. This is brittle if the
   wasm error message wording changes — but mirrors the only available approach
   since `commit_payload` doesn't return a typed error.

3. **Markdown files**: `MarkdownSourcePanel` does not yet pass `comments` or
   `onLineNumberClick` to `SourcePanel` (only the raw view gets it). Adding
   comments to markdown files requires a separate follow-up since the rendered
   view doesn't have line numbers.

4. **No concurrent-agent conflict**: the spec said a concurrent agent owns
   `gitreview.ts`. This implementation does not touch that file. The broken
   `graph.commit(sign=true)` pattern in the reviews POST endpoint is not used
   here; `codecomments.ts` uses the correct two-phase `commit_payload →
   commit_signed` flow throughout.
