
---

## Code Review Fixes (Task 3) — Review Finding Resolutions

### Fix 1 — Manifest state nonce replay protection (Important)

Added an in-process `_usedNonces: Map<string, number>` to `connector.ts`. `_consumeNonce(nonce, expMs, nowMs)` prunes expired entries, rejects already-seen nonces, and records new ones. Called in `GET /connector/app/callback` after HMAC verification passes but before the GitHub exchange. A replayed valid state within its 15-min TTL now returns 400 `{ error: "state already used" }`.

Test added: `nonce replay: same state token twice → second call returns 400` — first call succeeds state validation (fails at GitHub exchange with 502/409, not 400); second call with the same state token returns 400.

### Fix 2 — Webhook 401 → 204 for invalid signatures (Minor)

`webhook-github.ts`: invalid HMAC (or missing header) now returns 204 instead of 401, matching the unknown-repo response. Response codes no longer reveal whether a repository is configured.

Tests updated: `invalid signature → 204 (same as unknown repo — avoids graph-existence oracle)` and `missing X-Hub-Signature-256 header → 204 (no oracle)`. Both now assert 204 and verify no event was ingested.

### Fix 3 — Injectable fetch for callback conversion exchange (Minor)

`types.ts`: added `fetchFn?: typeof fetch` to `AppVariables`.

`app.ts`: `createApp` accepts an optional `opts?: { fetchFn?: typeof fetch }` fourth argument. When present, `fetchFn` is set on the Hono context variable for every request via the global middleware.

`connector.ts` callback route: reads `c.get("fetchFn") ?? fetch` so the conversions POST uses the injected fetch in tests and falls back to global fetch in production.

Test added: `GET /connector/app/callback with valid state and mocked conversions fetch stores encrypted credentials` — creates an isolated app instance with `mockFetch` injected, registers a repo graph, calls the manifest endpoint, then calls callback with `code=injected-code`. Asserts:
- response 200 with `ok: true`, `appId: "77001"`, `appSlug: "injected-test-app"`
- raw DB rows (`connector_secrets`) do not contain plaintext PEM or webhook secret
- decrypt round-trip: PEM, webhookSecret, clientSecret all match originals
- `getConnector` returns config with `appId`/`appSlug` set

### Test result
355 passed, 1 skipped (pre-existing), 0 failed. Web `tsc --noEmit` clean.
