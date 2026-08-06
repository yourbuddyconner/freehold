# feat-tray-preview report

**Status:** done

**Commit:** 4688c04 — feat(web): diff preview on staged changeset entries

## Test summary

383 tests across 26 files, all passing.

New tests added:
- `changeset.test.ts`: +2 (preview persists under cap, strips when over 100KB cap)
- `ChangesetTray.test.tsx`: +3 (View diff toggle present, clicking renders PierreDiff with correct content, no-preview shows fallback text)
- `policy.test.tsx`: +4 (edit attaches before/after, delete attaches before/after, add attaches before/after, preview.after equals the staged payload)

## Changes

- `changeset.tsx`: added `preview?` field to `ChangesetEntry`; `saveToStorage` strips preview when `before` or `after` exceeds 100KB
- `policy.tsx`: all three stage paths (`handleStage` in `PolicyRuleEditor`, `handleDeleteConfirm`, `handleStage` in `AddRuleCard`) now attach `preview: { name: "policy.json", before, after }` using pretty-printed JSON
- `ChangesetTray.tsx`: each entry row has a "View diff" / "Hide diff" toggle; when expanded shows `PierreDiff` or "No preview for this change."; tray widens to `w-[520px]` when any preview is open

## Concerns

None. The `pnpm --filter web lint` command in the spec references a script that does not exist in `package.json`; typecheck and tsc -b both pass clean.
