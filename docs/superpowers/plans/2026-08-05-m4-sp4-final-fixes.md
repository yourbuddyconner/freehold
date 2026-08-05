# M4 SP4 Final Fix Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six targeted issues in the GitHub connector: callback auth (critical), app-mode polling (important), spec corrections (important), cache clearing (minor), DB cleanup (minor), and undeclared ontology attribute (minor).

**Architecture:** Six independent fix tasks; each is self-contained. Task 1 moves the callback route to the open app (alongside /webhooks/github) so GitHub's browser redirect lands without a Bearer header; the HMAC-signed state is the authenticator. Task 2 wires makeAppClient into the poll route, serve.ts catch-up, and startPoller's client provider for cfg.mode==="app". Tasks 3-6 are mechanical corrections.

**Tech Stack:** TypeScript, Hono, Vitest, Node.js crypto, PGlite, @freehold/core

## Global Constraints

- Working directory: `/Users/conner/code/freehold/.claude/worktrees/governed-review-m4`
- All `pnpm test` runs from that root — must stay green
- `pnpm --filter @freehold/web tsc --noEmit` and `pnpm --filter @freehold/api build` must pass
- Plain declarative prose in docs — no slogan fragments, no jargon status words
- Do NOT commit `.superpowers/` scratch files
- Commit each task separately with `git commit -m "..."`

---

## Task 1: Move callback route to open app (Critical — #1)

**The problem:** `buildConnectorManifest` sets `redirect_url` to `/api/v1/graphs/:graphId/connector/app/callback`, which is mounted behind `bearerAuth`. GitHub's browser redirect is a plain GET with no Authorization header — it gets 401, and the one-shot code is dead.

**The fix:** Mount `GET /connector/app/callback` on the open (pre-auth) app, alongside `/webhooks/github`. The HMAC-signed `state` parameter (graph-bound, 15-min TTL, nonce-consumed) is the authenticator. Update `redirect_url` in `buildConnectorManifest` to point to the open path. Remove or keep the scoped variant consistently.

**Files:**
- Modify: `packages/api/src/app.ts`
- Modify: `packages/core/src/connector/app.ts` (`buildConnectorManifest`)
- Modify: `packages/api/src/routes/connector.ts` (extract callback handler)
- Modify: `packages/api/tests/connector-app.test.ts` (update callback test: no Bearer header)

**Interfaces:**
- Produces: `GET /connector/app/callback?code=:code&state=:state` accessible without Bearer token; responds 400 on bad/expired/replayed state; responds 200+JSON on success

- [ ] **Step 1: Extract the callback handler into a standalone open router**

In `packages/api/src/routes/connector.ts`, the existing `GET /connector/app/callback` handler is registered on `connectorRouter` (which gets mounted behind bearerAuth). We need to move it to a separate exported router that can be mounted on the open app.

Add at the bottom of `packages/api/src/routes/connector.ts`, after the existing `connectorRouter.get("/connector/app/callback", ...)` handler:

```typescript
// ── Open callback router (no bearer auth — HMAC-signed state is the authenticator) ──

import { Hono as HonoOpen } from "hono";

export const connectorCallbackRouter = new Hono<AppEnv>();

connectorCallbackRouter.get("/connector/app/callback", async (c) => {
  // ... same handler body ...
});
```

Wait — actually the cleanest approach is to export the handler function and reuse it in both places, OR simply remove it from connectorRouter and put it only in the open router. Given YAGNI: remove from connectorRouter, create connectorCallbackRouter with the route, export it.

Actually, the Hono import is already at the top. The router is just `new Hono<AppEnv>()`. Here is the exact edit:

Remove the `connectorRouter.get("/connector/app/callback", async (c) => { ... })` block from `packages/api/src/routes/connector.ts` (lines 421-524) and replace it with a new exported open router:

```typescript
// ── GET /connector/app/callback (open — no bearer; HMAC state is the authenticator) ──
// Mounted on the pre-auth app alongside /webhooks/github.
// GitHub redirects the user's browser here with ?code=:code&state=:state after app creation.
// The HMAC-signed state (graph-bound, TTL, nonce-consumed) authenticates the request.

export const connectorCallbackRouter = new Hono<AppEnv>();

connectorCallbackRouter.get("/connector/app/callback", async (c) => {
  // NOTE: no fh guard here — we derive graphId from the verified state payload.
  // The manager context variable is set by the global middleware in app.ts.

  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "missing code or state" }, 400);
  }

  const config = c.get("config");
  const encKey = deriveEncKey(config.token);

  const nowMs = Date.now();
  const verified = verifyManifestState(state, encKey, nowMs);
  if (!verified) {
    return c.json({ error: "invalid or expired state" }, 400);
  }

  // Reject replayed nonces within the TTL window
  if (!_consumeNonce(verified.nonce, verified.exp, nowMs)) {
    return c.json({ error: "state already used" }, 400);
  }

  // Resolve the graph for the graphId embedded in state
  const manager = c.get("manager");
  let fh: Awaited<ReturnType<typeof manager.get>>;
  try {
    fh = await manager.get(verified.graphId);
  } catch {
    return c.json({ error: "unknown graph" }, 404);
  }

  // Exchange code for app credentials via GitHub API
  const githubApiBase = (process.env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/$/, "");
  const conversionUrl = `${githubApiBase}/app-manifests/${encodeURIComponent(code)}/conversions`;

  const fetchFn = c.get("fetchFn") ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(conversionUrl, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    return c.json({ error: "failed to reach GitHub" }, 502);
  }

  if (!res.ok) {
    if (res.status >= 500) return c.json({ error: `GitHub returned ${res.status}` }, 502);
    return c.json({ error: `GitHub rejected the manifest code (status ${res.status})` }, 409);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return c.json({ error: "malformed response from GitHub" }, 502);
  }

  const conversion = parseManifestConversion(payload);
  if (!conversion) {
    return c.json({ error: "malformed response from GitHub" }, 502);
  }

  // Persist config + encrypted secrets
  const entry = await manager.getEntry(verified.graphId);
  const parsedRemote = entry?.originRemote ? parseOriginRemote(entry.originRemote) : null;

  await setConnector(
    fh.db,
    {
      graphId: verified.graphId,
      mode: "app",
      owner: parsedRemote?.owner ?? "",
      repo: parsedRemote?.repo ?? "",
      pollIntervalSec: 300,
      webhooksEnabled: false,
      appId: conversion.appId,
      appSlug: conversion.appSlug,
    },
    {
      pem: conversion.pem,
      webhookSecret: conversion.webhookSecret,
      clientSecret: conversion.clientSecret,
    },
    encKey
  );

  const githubBase = process.env.GITHUB_URL ?? "https://github.com";
  const installUrl = `${githubBase}/apps/${conversion.appSlug}/installations/new`;

  return c.json({
    ok: true,
    appId: conversion.appId,
    appSlug: conversion.appSlug,
    installUrl,
    message: "App created. Visit installUrl to install it on your repository.",
  });
});
```

- [ ] **Step 2: Update redirect_url in buildConnectorManifest**

In `packages/core/src/connector/app.ts`, `buildConnectorManifest` currently builds:
```
redirect_url: `${origin}/api/v1/graphs/${graphId}/connector/app/callback`,
```

Change it to point at the open (unscoped) path:
```typescript
redirect_url: `${origin}/connector/app/callback`,
```

The `origin` is set from `new URL(c.req.url).origin` in the POST manifest route handler, so it resolves to the daemon's base URL (e.g. `http://localhost:8787`). The callback is now at `http://localhost:8787/connector/app/callback`.

- [ ] **Step 3: Mount connectorCallbackRouter on the open app**

In `packages/api/src/app.ts`, import `connectorCallbackRouter` and mount it on the pre-auth section:

```typescript
import { connectorRouter, connectorCallbackRouter } from "./routes/connector.js";
```

Then add alongside the webhook router:
```typescript
// Open routes (no auth)
app.route("/", healthRouter);
app.route("/", githubWebhookRouter);
app.route("/", connectorCallbackRouter);  // add this line
app.get("/api/v1/openapi.json", (c) => c.json(getOpenApiDoc()));
```

The global middleware already sets `manager`, `config`, and `fetchFn` on context before any route runs, so the callback handler has everything it needs.

- [ ] **Step 4: Remove the old callback route from connectorRouter**

In `packages/api/src/routes/connector.ts`, delete the `connectorRouter.get("/connector/app/callback", ...)` block (the original, scoped version) since it is now replaced by `connectorCallbackRouter`. This ensures the route is not served twice and is not reachable behind bearerAuth.

- [ ] **Step 5: Write a failing test for unauthenticated callback**

In `packages/api/tests/connector-app.test.ts`, find the existing callback test (search for "callback"). Update it to NOT send an Authorization header:

```typescript
test("callback succeeds without bearer token", async () => {
  // 1. POST /connector/app/manifest WITH auth to get a state
  const manifestRes = await app.request(
    `/api/v1/graphs/${graphId}/connector/app/manifest`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    env
  );
  expect(manifestRes.status).toBe(200);
  const { state, manifest } = await manifestRes.json() as { state: string; manifest: { redirect_url: string } };

  // Verify redirect_url is the open path
  expect(manifest.redirect_url).toMatch(/\/connector\/app\/callback$/);
  expect(manifest.redirect_url).not.toContain("/api/v1/");

  // 2. GET /connector/app/callback WITHOUT Authorization header
  const code = "test-code-abc";
  const callbackRes = await app.request(
    `/connector/app/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { method: "GET" }
    // NOTE: no Authorization header
  );
  expect(callbackRes.status).toBe(200);
  const body = await callbackRes.json() as Record<string, unknown>;
  expect(body.ok).toBe(true);
  expect(typeof body.installUrl).toBe("string");
});
```

Also add tests for tampered/expired/replayed state (no bearer header on those too):

```typescript
test("callback rejects tampered state without bearer", async () => {
  const callbackRes = await app.request(
    `/connector/app/callback?code=abc&state=tampered.sig`,
    { method: "GET" }
  );
  expect(callbackRes.status).toBe(400);
});

test("callback rejects replayed state", async () => {
  // Get a valid state
  const manifestRes = await app.request(
    `/api/v1/graphs/${graphId}/connector/app/manifest`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    env
  );
  const { state } = await manifestRes.json() as { state: string };
  const code = "replay-code";

  // First use succeeds
  const first = await app.request(
    `/connector/app/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { method: "GET" }
  );
  expect(first.status).toBe(200);

  // Second use with same state is rejected
  const second = await app.request(
    `/connector/app/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { method: "GET" }
  );
  expect(second.status).toBe(400);
});
```

- [ ] **Step 6: Run tests to confirm they fail with current code**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/api test --run 2>&1 | grep -E "FAIL|callback|PASS" | head -30
```

- [ ] **Step 7: Implement the changes (Steps 1-4 above)**

Apply all edits described in Steps 1-4. The handler body is copy-pasted from the old scoped route with only the graphId resolution changed (was from `c.get("freehold").graphId` → now from `verified.graphId` with a manager.get() call).

- [ ] **Step 8: Run tests to confirm they pass**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm test --run 2>&1 | tail -20
```

Expected: all tests pass including new callback tests.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/app.ts packages/api/src/routes/connector.ts packages/core/src/connector/app.ts packages/api/tests/connector-app.test.ts
git commit -m "fix(connector): move app callback to open app; redirect_url no longer behind bearerAuth"
```

---

## Task 2: Wire app-mode client into poll route, catch-up, and startPoller (#2)

**The problem:** `POST /connector/poll`, the `serve.ts` startup catch-up, and `startPoller`'s client provider all read `credentialToken` and skip `mode !== "credential"` — app-mode graphs get no polling.

**The fix:** For `cfg.mode === "app"`, use `makeAppClient(fh, encKey, fetchFn)` to obtain the client. The poll route already has `fetchFn` from context for testing. `serve.ts` and `startPoller` need the same pattern.

**Files:**
- Modify: `packages/api/src/routes/connector.ts` (POST /connector/poll)
- Modify: `packages/api/src/serve.ts` (startup catch-up + startPoller client provider)
- Modify: `packages/api/tests/connector.test.ts` (app-mode poll + catch-up tests)

**Interfaces:**
- Consumes: `makeAppClient(fh, encKey, fetchImpl?) → Promise<GithubClient | null>` from `@freehold/core`
- Produces: poll route works for app-mode; serve.ts catch-up runs for app-mode graphs with webhooksEnabled

- [ ] **Step 1: Write failing test for app-mode poll route**

In `packages/api/tests/connector.test.ts`, add a new describe block after the existing credential-mode tests:

```typescript
describe("app-mode poll", () => {
  let appDir: string;
  let appManager: GraphManager;
  let appConfig: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    appDir = makeTempDir("freehold-connector-appmode-");
    appManager = await GraphManager.open(appDir);
    appConfig = loadConfig(appDir);
  });

  afterAll(() => {
    rmSync(appDir, { recursive: true, force: true });
  });

  test("POST /connector/poll works for app-mode with injected fetch", async () => {
    const graphId = appManager.defaultId();
    const fh = await appManager.get(graphId);

    // Store an app-mode connector config with appId + installationId
    const encKey = deriveEncKey(appConfig.token);
    const { privateKeyPem } = makeSyntheticRsaKeys();
    await setConnector(
      fh.db,
      {
        graphId,
        mode: "app",
        owner: "testowner",
        repo: "testrepo",
        pollIntervalSec: 300,
        webhooksEnabled: false,
        appId: "123",
        installationId: "456",
      },
      { pem: privateKeyPem, webhookSecret: "", clientSecret: "" },
      encKey
    );

    // Mock fetch: returns installation token then empty poll data
    let fetchCallCount = 0;
    const mockFetch: typeof fetch = async (url, init) => {
      fetchCallCount++;
      const urlStr = typeof url === "string" ? url : url instanceof Request ? url.url : String(url);
      if (urlStr.includes("/access_tokens")) {
        // Installation token response
        const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        return new Response(JSON.stringify({ token: "ghs_app_token", expires_at: exp }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (urlStr.includes("/pulls?")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    };

    const appInstance = createApp(appManager, hashEmbedder, appConfig, { fetchFn: mockFetch });

    const res = await appInstance.request(
      `/api/v1/connector/poll`,
      { method: "POST", headers: { Authorization: `Bearer ${appConfig.token}` } }
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    // fetch was called at least once (for installation token)
    expect(fetchCallCount).toBeGreaterThan(0);
  });
});
```

Note: you need `makeSyntheticRsaKeys`, `setConnector`, `deriveEncKey` imported — check what's already imported in `connector.test.ts` and add what's missing.

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/api test --run 2>&1 | grep -E "app-mode poll|FAIL|Error" | head -20
```

Expected: the poll route returns 409 "no stored token" (because it reads credentialToken which is not set for app mode).

- [ ] **Step 3: Fix POST /connector/poll in connector.ts**

In `packages/api/src/routes/connector.ts`, the current poll handler (lines 328-352) reads `credentialToken` and returns 409 if absent. Replace with mode-aware client selection:

```typescript
connectorRouter.post("/connector/poll", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  const cfg = await getConnector(fh.db, fh.graphId);
  if (!cfg) {
    return c.json({ error: "connector not configured" }, 409);
  }

  const config = c.get("config");
  const encKey = deriveEncKey(config.token);
  const fetchFn = c.get("fetchFn") ?? fetch;

  let client: import("@freehold/core").GithubClient | null = null;

  if (cfg.mode === "credential") {
    const token = await getSecret(fh.db, fh.graphId, "credentialToken", encKey);
    if (!token) {
      return c.json({ error: "no stored token; configure the connector first" }, 409);
    }
    client = makeTokenClient(token, fetchFn);
  } else if (cfg.mode === "app") {
    client = await makeAppClient(fh, encKey, fetchFn);
    if (!client) {
      return c.json(
        { error: "app mode not fully configured; set installationId first" },
        409
      );
    }
  } else {
    return c.json({ error: "unsupported connector mode" }, 409);
  }

  const result = await pollOnce(fh, cfg, client);
  return c.json(result);
});
```

Add `makeAppClient` to the imports from `@freehold/core` at the top of connector.ts:
```typescript
import {
  getConnector,
  setConnector,
  discoverCredential,
  parseOriginRemote,
  makeTokenClient,
  makeAppClient,       // add this
  pollOnce,
  deriveEncKey,
  getSecret,
  buildConnectorManifest,
} from "@freehold/core";
```

Also add the `GithubClient` type import (needed for the `let client` declaration):
```typescript
import type { AppEnv } from "../types.js";
import type { GithubClient } from "@freehold/core";  // add this
```

- [ ] **Step 4: Fix serve.ts — catch-up poll for app mode**

In `packages/api/src/serve.ts`, the startup catch-up block (lines 62-70) reads `credentialToken` only. For app mode, use `makeAppClient`:

```typescript
// Catch-up poll at startup for webhook-enabled graphs
if (cfg.webhooksEnabled) {
  let catchUpClient: Awaited<ReturnType<typeof makeAppClient>> = null;
  if (cfg.mode === "credential") {
    const credToken = await getSecret(fh.db, entry.id, "credentialToken", encKey);
    if (credToken) {
      catchUpClient = makeTokenClient(credToken);
    }
  } else if (cfg.mode === "app") {
    catchUpClient = await makeAppClient({ db: fh.db, graphId: entry.id }, encKey).catch(() => null);
  }
  if (catchUpClient) {
    pollOnce(fh, cfg, catchUpClient).catch((e) =>
      console.error(`[connector] startup catch-up poll failed for ${entry.id}:`, e)
    );
  }
}
```

Add `makeAppClient` to the imports in `serve.ts`:
```typescript
import {
  GraphManager,
  hashEmbedder,
  loadConfig,
  makeEmbedder,
  syncIndex,
  getConnector,
  makeTokenClient,
  makeAppClient,       // add this
  deriveEncKey,
  getSecret,
  startPoller,
  pollOnce,
} from "@freehold/core";
```

- [ ] **Step 5: Fix serve.ts — startPoller client provider for app mode**

The `startPoller` call (lines 74-83) currently skips non-credential mode with `if (cfg.mode !== "credential") continue;`. Change to also start poller for app mode:

```typescript
// Skip graphs that can't have a client
if (cfg.mode !== "credential" && cfg.mode !== "app") continue;

const handle = startPoller(
  fh,
  async () => getConnector(fh.db, entry.id),
  async () => {
    const latestCfg = await getConnector(fh.db, entry.id);
    if (!latestCfg) throw new Error("no connector config for graph " + entry.id);
    if (latestCfg.mode === "credential") {
      const token = await getSecret(fh.db, entry.id, "credentialToken", encKey);
      if (!token) throw new Error("no stored token for graph " + entry.id);
      return makeTokenClient(token);
    } else if (latestCfg.mode === "app") {
      const client = await makeAppClient({ db: fh.db, graphId: entry.id }, encKey);
      if (!client) throw new Error("app client not available for graph " + entry.id);
      return client;
    }
    throw new Error("unsupported mode " + latestCfg.mode);
  }
);
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm test --run 2>&1 | tail -20
```

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/connector.ts packages/api/src/serve.ts packages/api/tests/connector.test.ts
git commit -m "fix(connector): wire app-mode client into poll route, catch-up, and startPoller"
```

---

## Task 3: Correct spec status bullets (#3)

**The problem:** Two bullets in the SP4 status section describe the wrong behavior:

1. Bullet "**Ingest principal**" says `github-connector` service principal. The code actually uses `CONNECTOR_PRINCIPAL = "owner"` (the graph root) and preserves attribution via `external_source`/`claimed_author` attributes. No service principal is created.

2. Bullet "**Webhook 204 oracle**" says "401 only on signature failure". The code returns 204 for everything including signature failures — 401 is never returned.

**Files:**
- Modify: `docs/specs/2026-08-04-governed-review-surface-design.md`

- [ ] **Step 1: Correct the ingest principal bullet**

Find the current text:
```
- **Ingest principal**: a `github-connector` service principal is created at first ingest on each graph. Its key lives in the graph's doc store (file-backed). Writes commit as this principal so provenance is auditable in the changeset log.
```

Replace with text that describes what shipped:
```
- **Ingest principal**: graph writes commit as the `owner` principal (the graph root) so they are admitted immediately under the default memory policy. Attribution is preserved via `external_source` (`"github"`) and `claimed_author` (the GitHub actor's login) attributes on each `ReviewComment` node.
```

- [ ] **Step 2: Correct the webhook 204 oracle bullet**

Find the current text:
```
- **Webhook 204 oracle**: the webhook route returns 204 for accepted or unknown-repo events; 401 only on signature failure with no body detail. This minimises information leakage and matches GitHub's recommended webhook handler contract.
```

Replace with:
```
- **Webhook 204 oracle**: the webhook route returns 204 for all outcomes — accepted delivery, unknown repo, and signature failure — with no body detail on any path. This prevents graph-existence enumeration and signature-failure enumeration.
```

- [ ] **Step 3: Verify no other incorrect references**

```bash
grep -n "github-connector\|401 only on signature" /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/docs/specs/2026-08-04-governed-review-surface-design.md
```

Expected: no matches (both strings should now be gone after the edits).

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-08-04-governed-review-surface-design.md
git commit -m "docs: correct SP4 status bullets — ingest principal and webhook 204 oracle"
```

---

## Task 4: Call clearAppClientCache from DELETE /connector and POST /connector/app/installation (#4)

**The problem:** The in-process installation token cache is keyed by graphId. When a connector is deleted or reconfigured, the stale token remains cached until daemon restart.

**Files:**
- Modify: `packages/api/src/routes/connector.ts`

- [ ] **Step 1: Add clearAppClientCache to imports**

In `packages/api/src/routes/connector.ts`, add `clearAppClientCache` to the import list from `@freehold/core`:

```typescript
import {
  getConnector,
  setConnector,
  discoverCredential,
  parseOriginRemote,
  makeTokenClient,
  makeAppClient,
  clearAppClientCache,   // add this
  pollOnce,
  deriveEncKey,
  getSecret,
  buildConnectorManifest,
} from "@freehold/core";
```

- [ ] **Step 2: Call clearAppClientCache in DELETE /connector**

In the DELETE handler (after the three DELETE queries), before `return c.json({ ok: true })`, add:

```typescript
clearAppClientCache(fh.graphId);
```

- [ ] **Step 3: Call clearAppClientCache in POST /connector/app/installation**

In the installation handler, after the `setConnector(...)` call and before `return c.body(null, 204)`, add:

```typescript
clearAppClientCache(fh.graphId);
```

The rationale: after storing a new installationId, any cached installation token is for the wrong installation; clearing forces a fresh mint.

- [ ] **Step 4: Run tests to confirm still passing**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm test --run 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/connector.ts
git commit -m "fix(connector): clear app client cache on DELETE and installation update"
```

---

## Task 5: DELETE /connector clears check_status and connector_soft_tombstone (#5)

**The problem:** DELETE /connector removes `connector_config`, `connector_secrets`, and `connector_cursor`, but leaves `check_status` and `connector_soft_tombstone` rows behind — orphaned data that would confuse any subsequent connector setup for the same graph.

**Files:**
- Modify: `packages/api/src/routes/connector.ts`

- [ ] **Step 1: Add the two missing DELETE statements to the handler**

In the DELETE handler (the try block, after the existing three DELETE queries), add:

```typescript
await fh.db.pg.query(
  `DELETE FROM check_status WHERE graph_id = $1`,
  [fh.graphId]
);
await fh.db.pg.query(
  `DELETE FROM connector_soft_tombstone WHERE graph_id = $1`,
  [fh.graphId]
);
```

The `check_status` table stores check-run rows keyed by (graphId, sha, name). The `connector_soft_tombstone` table stores pending-node deletion records. Both should be reset when the connector is removed.

- [ ] **Step 2: Run tests to confirm still passing**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm test --run 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/connector.ts
git commit -m "fix(connector): DELETE also clears check_status and connector_soft_tombstone"
```

---

## Task 6: Drop undeclared inReplyTo attribute from events.ts (#6)

**The problem:** `events.ts:286` writes `activeAttrs.inReplyTo = ev.inReplyTo` — an attribute not declared in the vendored `review-ontology.yaml` nor in the upstream `/Users/conner/code/allod/ontologies/review/ontology.yaml`. The replies model uses the `replies_to` edge type. Nothing reads the `inReplyTo` attribute.

**Decision (YAGNI):** Drop the attribute write. The `inReplyTo` field on the `ConnectorEvent` type and in the webhook/poll parsers can stay as source data — it feeds `replies_to` edge creation if that's ever built. But it must not be written as an undeclared node attribute.

**Files:**
- Modify: `packages/core/src/connector/events.ts` (remove the `activeAttrs.inReplyTo` write)

No ontology changes needed.

- [ ] **Step 1: Grep to confirm nothing reads inReplyTo from node attributes**

```bash
grep -rn "inReplyTo\|in_reply_to" /Users/conner/code/freehold/.claude/worktrees/governed-review-m4/ --include="*.ts" --include="*.yaml" | grep -v "node_modules"
```

Expected: matches in events.ts (write), poll.ts (reads from GitHub API response), webhook-github.ts (reads from payload), and no reads from node attributes anywhere.

- [ ] **Step 2: Remove the inReplyTo attribute write**

In `packages/core/src/connector/events.ts`, remove lines 285-287:
```typescript
  if (ev.inReplyTo) {
    activeAttrs.inReplyTo = ev.inReplyTo;
  }
```

The `inReplyTo` field on `ConnectorEvent` (line 28) stays — it carries source data. Only the attribute write is removed.

- [ ] **Step 3: Run tests to confirm still passing**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm test --run 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/connector/events.ts
git commit -m "fix(connector): drop undeclared inReplyTo node attribute; replies_to edge is the replies model"
```

---

## Task 7: Write final fix report and verify full test suite (#Final)

**Files:**
- Create: `.superpowers/sdd/2026-08-05-m4-connector/final-fix-report.md`

- [ ] **Step 1: Run full test suite from root**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm test --run 2>&1 | tail -30
```

All tests must pass.

- [ ] **Step 2: Run tsc and build checks**

```bash
cd /Users/conner/code/freehold/.claude/worktrees/governed-review-m4
pnpm --filter @freehold/web tsc --noEmit 2>&1 | tail -10
pnpm --filter @freehold/api build 2>&1 | tail -10
```

Both must exit 0.

- [ ] **Step 3: Write the report**

Write `.superpowers/sdd/2026-08-05-m4-connector/final-fix-report.md` (not committed — scratch only):

```markdown
# M4 SP4 Final Fix Wave — Report

Date: 2026-08-05

## Status

All 6 fixes applied, all tests green.

## Fix Summary

### #1 — Callback route moved to open app (Critical)
- `GET /connector/app/callback` extracted to `connectorCallbackRouter`, mounted pre-auth
- `redirect_url` in `buildConnectorManifest` updated to `/connector/app/callback`
- Tests: callback succeeds without Bearer header; tampered/expired/replayed state → 400

### #2 — App-mode polling wired (Important)
- `POST /connector/poll`: uses `makeAppClient` when `cfg.mode === "app"`
- `serve.ts` catch-up: uses `makeAppClient` for app-mode graphs with webhooksEnabled
- `startPoller` client provider: handles both credential and app mode
- Tests: app-mode poll route works with injected fetch

### #3 — Spec status bullets corrected (Important)
- "Ingest principal": corrected to describe owner principal + claimed_author attribute
- "Webhook 204 oracle": corrected to describe 204-for-all behavior

### #4 — clearAppClientCache called on DELETE and installation update (Minor)
- Prevents stale installation tokens from persisting after config changes

### #5 — DELETE /connector clears check_status and connector_soft_tombstone (Minor)
- Prevents orphaned rows confusing a subsequent connector setup

### #6 — Dropped undeclared inReplyTo node attribute (Minor)
- Removed `activeAttrs.inReplyTo = ev.inReplyTo` from events.ts:286
- inReplyTo field on ConnectorEvent stays for future replies_to edge use
- Nothing reads inReplyTo from node attributes; YAGNI decision

## Test Summary

[Paste pnpm test output here]
```

- [ ] **Step 4: No commit for .superpowers/ (scratch)**

The report is scratch; do NOT commit it.
