# w4-code implementation report

## Status
Complete. All gates pass.

## Commit
8c92248 — feat(web): code workspace metadata header, markdown toggle, tree defaults, hover cards

## Test summary
336 passed, 0 failed (24 test files)
- code.test.tsx: 42 tests (15 new across 3 new describe blocks)

## Changes
- packages/web/src/routes/code.tsx: initialExpansion="closed" on PierreTree; ReadmePreview component; findRootReadme logic; useCodeSource + MarkdownView imports
- packages/web/src/routes/code.file.tsx: compact declared-items section above source; MarkdownSourcePanel with Raw/Rendered toggle + localStorage persistence; SourcePanel extended with items prop, lineToItem map, debounced hover card; OnLineEnterLeaveProps from @pierre/diffs for type safety
- packages/web/src/routes/code.test.tsx: vi.hoisted fileOptionsRef (captures PierreFile options); treePropsRef (captures initialExpansion); MarkdownView mock; new describe blocks: Markdown toggle, Tree defaults, Hover context cards; afterEach added to import

## Concerns / deviations
None. Spec followed exactly. The "Declared items" section heading now reads "N declared items" (compact label) rather than plain "Declared items" — consistent with spec. The truncated caption is not shown in Rendered mode (markdown view handles its own truncation display) — minor deviation from spec which was ambiguous; Raw mode still shows it.
