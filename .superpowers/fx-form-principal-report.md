# fx-form-principal — Implementation Report

## Status

Complete.

## Commits

- `bdfcd93`: feat(core): add signingPrincipal to GraphEntry with back-compat NULL→owner default
- `67d28f9`: feat(api): surface signingPrincipal in GraphInfo + RegisterGraphBody
- `1f36ef5`: feat(web): add useActiveGraphPrincipal; surface 409 error in ReviewComposer
- `27f846a`: fix(api): format openapi.json to match biome inline-array style
- `500f922`: fix(core): biome format manager.ts and manager.test.ts
- `b480c9e`: feat(web): restyle GitProposalCard review composer
- `a2a5aeb`: fix(web): add role=group to segmented verdict control
- `21cf24d`: fix(web): use fieldset for verdict segmented control (biome a11y)
- `dae28f5`: fix(client): parse both flat and nested error body shapes

The commits group into two logical units as requested:
- **Principal plumbing:** bdfcd93 + 67d28f9 + 1f36ef5 + 27f846a + 500f922 + dae28f5
- **Form restyle:** b480c9e + a2a5aeb + 21cf24d

## Test Summary

405 passed | 1 skipped | 2 pre-existing failures (api.test.ts requires a running Freehold server — "Freehold is not running" — unrelated to this branch). New tests: 3 core manager tests (signingPrincipal persistence, default, legacy-NULL fallback), 2 hooks tests (useActiveGraphPrincipal), 9 composer tests (visibility, segmented control, layout), 3 client error-parsing tests (flat shape with code, nested shape, flat without code). 265 web tests pass total.

## Registry Patch for Live allod Entry

The live allod graph registry row has `signing_principal = NULL` (the column did not exist before this branch). With NULL, `rowToEntry` defaults to `"owner"` — so `GET /api/v1/graphs` returns `signingPrincipal: "owner"` for the allod entry, and `useActiveGraphPrincipal()` sends `by: "owner"` instead of `by: "conner"`.

**Required fix — run this SQL against the live Freehold PGlite database:**

```sql
UPDATE graphs SET signing_principal = 'conner' WHERE id = 'allod';
```

The PGlite DB lives at `~/.freehold/pg/` (or wherever `FREEHOLD_HOME` points). To apply: stop freehold, open the DB with a PGlite-compatible tool or a one-shot node script, run the UPDATE, restart.

Alternatively, re-register the allod graph via the web console Settings → Graphs → Remove + Add, specifying the path and principal "conner" in the registration form (the POST /api/v1/graphs body now accepts `signingPrincipal`).

## review.$sha.tsx (not in the principal-fix commit)

`packages/web/src/routes/review.$sha.tsx` was minimally edited in the form-restyle commit (b480c9e) because `ReviewComposer`'s interface gained required props (`open`, `onOpen`, `onClose`). The edit adds a `reviewComposerOpen` boolean state and wires the three new props — it does not touch the `by` principal line (108) per the plan constraint.

**One-liner still needed in review.$sha.tsx (line 108):**
```typescript
// Before:
const by = sessionData?.owner ?? "owner";
// After:
const by = useActiveGraphPrincipal();
```
Add `useActiveGraphPrincipal` to the `~/lib/hooks` import. Remove `useSession` if no longer used elsewhere in that file.

## Concerns

None blocking. The `signing_principal` column is added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — safe on existing DBs. The `rowToEntry` NULL→"owner" default ensures back-compat. Two pre-existing api.test.ts failures require a running server and are not introduced by this branch.

A critical bug discovered during final review was fixed: `packages/client/src/client.ts` previously only parsed the nested error shape `{ error: { code, message } }`, but `gitreview.ts` 409 responses use the flat shape `{ error: string, code: string }`. Without the fix, `ApiError.code` was always `"http_error"` and `.message` was always `"HTTP 409"` — the amber key-missing notice and specific error text never appeared. The client now handles both shapes.
