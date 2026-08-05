# M4 GitHub Connector Implementation Plan (sub-project 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repo graphs connect to GitHub: credential mode (gh CLI token, polling) and GitHub App mode (manifest-flow setup, webhooks when a public URL exists), one event-handler core ingesting PR comments/reviews one-way as ReviewComment nodes with external provenance, and check-run status on proposal cards. No posting back to GitHub.

**Architecture:** One event-handler core (`connector/events.ts`) behind two auth modes and two transports. `connector/github.ts` is a thin REST client with injectable fetch + token provider (credential mode: `gh auth token` → git credential helper; App mode: installation tokens minted from an app JWT, cached with expiry margin). Polling (`connector/poll.ts`) and webhooks (`POST /webhooks/github`, HMAC-validated) both normalize GitHub payloads into the same internal events. Connector config persists per graph in PGlite (App credentials encrypted AES-256-GCM under a key derived from the daemon token). Ingest is idempotent: GitHub comment id is the dedup key; edits update; deletions tombstone.

**Tech Stack:** TypeScript, node fetch, node:crypto (HMAC, AES-GCM, RS256 JWT via crypto.sign), Hono, PGlite, vitest with injected-fetch GitHub mocks.

Spec: `docs/specs/2026-08-04-governed-review-surface-design.md` (sub-project 4 section). Reference implementation for the App manifest flow: `~/code/valet` branch `dev-v2` (HMAC state, form-POST to GitHub's app-creation page, `/app-manifests/{code}/conversions` exchange, encrypted credentials, installation-token minting) — read it before designing Task 3's flow details.

## Global Constraints

- One-way ingest only: never POST review content to GitHub. Check-runs/statuses are read-only.
- Ingested comments become `review/ReviewComment@1` nodes with external provenance attributes: `external_source: "github"`, `external_id` (GitHub comment id — the dedup key), `claimed_author` (GitHub login), `status` (`active` | `tombstoned`). Edits update the node; deletions set `status: tombstoned`. Redelivery/re-poll of an unchanged comment writes nothing (idempotence).
- Ingest writes go through the existing commit path as a service principal — reuse how review artifacts commit (author principal: the graph's owner-equivalent or a dedicated `github-connector` principal created at connector setup; pick ONE approach in Task 1 and keep it consistent; the write must not require interactive signing — file-backed key or in-store key only).
- Webhook validation: `X-Hub-Signature-256` HMAC over the raw body with the stored webhook secret; constant-time compare; invalid → 401, no body detail. Webhook route is UNAUTHENTICATED by bearer (GitHub calls it) — mount outside bearerAuth but validate HMAC strictly; unknown repo/graph → 204 silent drop.
- Poll/webhook parity: identical graph writes through both transports (tested).
- App credentials (PEM, webhook secret, client secret) encrypted at rest in PGlite (AES-256-GCM, key = HKDF/scrypt of the daemon config token, random IV per value, auth tag stored); app id/slug plain metadata. Never log secrets or tokens.
- Credential mode discovery: `execFile("gh", ["auth","token"])` → fallback `git credential fill` (protocol=https, host=github.com) — both execFile, no shells; absence → connector status "no credential found" (typed, not a crash).
- Polling is the fallback everywhere; webhook toggle gated on a configured public URL; a startup catch-up poll covers missed deliveries when webhooks are on.
- All GitHub API access via the injectable client (tests use injected fetch — no live GitHub calls in the suite).
- Repo linkage from the graph entry's `originRemote` (owner/repo parsed from https or git@ forms), confirmed at connector setup.
- Vocabulary rules; suite green (root `pnpm test`, web tsc force-check, web build).

---

### Task 1: connector core — github client, config store, event handler, ingest

**Files:**
- Create: `packages/core/src/connector/github.ts`, `packages/core/src/connector/config.ts`, `packages/core/src/connector/events.ts`; exports from index.ts
- Modify: `packages/core/src/db.ts` (connector tables)
- Create: `packages/core/tests/connector-core.test.ts`

**Interfaces:**

```ts
// github.ts
export interface GithubClient {
  rest<T>(path: string, init?: RequestInit): Promise<T>;   // https://api.github.com base, auth header injected
}
export function makeTokenClient(token: string, fetchImpl?: typeof fetch): GithubClient;
export async function discoverCredential(): Promise<string | null>; // gh auth token → git credential fill → null
export function parseOriginRemote(remote: string): { owner: string; repo: string } | null; // https + git@ forms

// config.ts
export type ConnectorMode = "credential" | "app";
export interface ConnectorConfig {
  graphId: string; mode: ConnectorMode; owner: string; repo: string;
  pollIntervalSec: number;             // default 300
  webhooksEnabled: boolean;            // app mode + public URL only
  // app mode (secrets stored encrypted; this interface exposes decrypted at use time only):
  appId?: string; appSlug?: string; installationId?: string;
}
export async function getConnector(db: DbHandle, graphId: string): Promise<ConnectorConfig | null>;
export async function setConnector(db: DbHandle, cfg: ConnectorConfig, secrets?: { pem?: string; webhookSecret?: string; clientSecret?: string }, encKey?: Buffer): Promise<void>;
export async function getSecret(db: DbHandle, graphId: string, name: "pem" | "webhookSecret" | "clientSecret", encKey: Buffer): Promise<string | null>;
export function deriveEncKey(daemonToken: string): Buffer; // scrypt(daemonToken, fixed-app-salt, 32)

// events.ts — the ONE handler core
export type ConnectorEvent =
  | { kind: "push"; ref: string; headSha: string }
  | { kind: "pr"; action: string; number: number; headSha: string }
  | { kind: "comment"; action: "created" | "edited" | "deleted"; id: string; body: string;
      author: string; path?: string; commitSha?: string; prNumber?: number; inReplyTo?: string }
  | { kind: "check"; sha: string; name: string; status: string; conclusion?: string };
export interface IngestResult { written: "created" | "updated" | "tombstoned" | "unchanged"; nodeId?: string }
export async function handleConnectorEvent(fh: Freehold, ev: ConnectorEvent): Promise<IngestResult | null>;
// push/pr → null (proposal lists are computed on demand; nothing to persist).
// check → persisted to a small check_status table (graph_id, sha, name, status, conclusion) upserted — the
//   proposal card reads it (Task 4); returns null.
// comment → ReviewComment ingest per the Global Constraints (dedup by external_id via an index query;
//   unchanged body+status → "unchanged" with NO graph write).
```

DB: `connector_config` (graph_id PK, mode, owner, repo, poll_interval, webhooks_enabled, app_id, app_slug, installation_id, updated_at), `connector_secrets` (graph_id, name, ciphertext, iv, tag; PK (graph_id,name)), `check_status` (graph_id, sha, name, status, conclusion; PK (graph_id, sha, name)), `connector_cursor` (graph_id PK, last_poll_at, etag/state as jsonb).

Ingest principal: create-or-reuse a `github-connector` service principal on the graph at first ingest (via the existing principal-add flow; its key lives in the doc store like other freehold-created principals) — writes commit as that principal so provenance is honest.

Tests (no live GitHub): parseOriginRemote both forms + garbage; token client injects auth header + surfaces 401s; config round-trip with secret encryption (ciphertext differs from plaintext, decrypts with the right key, fails with a wrong key); deriveEncKey deterministic; comment ingest created→edited(update)→redelivered(unchanged, and assert NO new changeset appended by comparing log length)→deleted(tombstone status); dedup across two ingests of the same id; check upsert round-trip; discoverCredential covered by injecting a fake execFile? — if execFile isn't injectable, test parseOriginRemote/client only and leave discoverCredential to the route-level test with PATH stubbing (a fake `gh` script dir prepended to PATH — the pattern is fine in vitest).

- [ ] Steps: failing tests → implement → suite green → commit `feat(core): connector core — github client, encrypted config store, one-way comment ingest, check status`.

---

### Task 2: polling transport + credential mode + connector API

**Files:**
- Create: `packages/core/src/connector/poll.ts`
- Create: `packages/api/src/routes/connector.ts`; mount (scoped, repo-only)
- Modify: serve boot (start pollers for configured graphs), openapi + client regen
- Create: `packages/api/tests/connector.test.ts`

**Interfaces:**

```ts
// poll.ts
export async function pollOnce(fh: Freehold, cfg: ConnectorConfig, client: GithubClient): Promise<{ events: number; errors: string[] }>;
// list open PRs → per PR: review comments + issue comments + reviews (paginated), each normalized to
// ConnectorEvent{kind:"comment"} incl. deleted detection versus prior ingested ids (a comment id previously
// ingested but absent from the listing AND its PR still open → tombstone event);
// commits/check-runs for proposal shas (branch heads) → ConnectorEvent{kind:"check"};
// cursor updated in connector_cursor. All GitHub access through `client`.
export function startPoller(fh: Freehold, cfgProvider: () => Promise<ConnectorConfig | null>, clientProvider: ...): { stop(): void };
// setInterval respecting pollIntervalSec; skips overlapping runs; errors recorded to cursor state, never crash the daemon.
```

Routes (scoped mount, repo-only 400 like code/gitreview):
- `GET /connector` → `{ configured: boolean, config?: sans-secrets, status: { lastPollAt?, lastErrors? } }`
- `PUT /connector` body `{ mode: "credential", pollIntervalSec? }` → discoverCredential; null → 409 `{ error: "no credential found", code: "no-credential" }`; parses originRemote (missing → 409); persists config.
- `POST /connector/poll` → runs pollOnce now (the UI/tests trigger), returns its result.
- `DELETE /connector` → remove config+secrets.
- App-mode PUT arrives in Task 3.

Tests: injected-fetch GitHub mock (a tiny in-test router over the REST paths used) — configure credential mode with a PATH-stubbed `gh` printing a fake token; pollOnce ingests a PR comment (node visible via the reviews/comments read paths), redelivery poll → unchanged (log length stable), edited body → update, comment absent + PR open → tombstone; check-runs land in check_status; repo-only + no-credential 409 paths; poller start/stop no overlap (fake timers).

- [ ] Steps: failing tests → implement → openapi/client regen → suite + web checks green → commit `feat(connector): polling transport, credential mode, connector routes`.

---

### Task 3: GitHub App mode — manifest flow, webhooks, installation tokens

**Files:**
- Create: `packages/core/src/connector/app.ts` (JWT mint RS256 via node crypto, installation-token cache with expiry margin, manifest builder)
- Modify: `packages/api/src/routes/connector.ts` (app-mode setup routes), new unauthenticated webhook route in app.ts mounting (`POST /webhooks/github`)
- Modify: web settings (Task 4 carries the full wizard UI; this task ships the API surface)
- Create: `packages/api/tests/connector-app.test.ts`

**Flow (per valet dev-v2 — read ~/code/valet on branch dev-v2 first; adapt, do not invent):**
- `POST /connector/app/manifest` → server builds the app manifest JSON (name, redirect/conversion URL from the request's own origin or a provided publicUrl, requested permissions: contents read, pull_requests read, checks read, metadata read; events: push, pull_request, pull_request_review, issue_comment), plus an HMAC-signed `state` (key = deriveEncKey); response gives the GitHub app-creation URL + the manifest for a browser form-POST.
- `GET /connector/app/callback?code&state` → verify state HMAC → exchange `POST https://api.github.com/app-manifests/{code}/conversions` (injected fetch) → store credentials encrypted (PEM, webhook secret, client secret; app id/slug metadata) → status "app created, awaiting installation" with the install URL.
- `POST /connector/app/installation` body `{ installationId }` (or discovered via the installations list API) → persist; installation tokens minted lazily: RS256 JWT (iss=appId, 10min) via `crypto.createSign("RSA-SHA256")`/`crypto.sign` with the decrypted PEM → `POST /app/installations/{id}/access_tokens` → cache token with 5-min expiry margin; `GithubClient` for app mode wraps this provider.
- Webhooks: `POST /webhooks/github` (no bearer): raw-body HMAC check against the graph-matched webhook secret (match graph by repository.full_name against configured owner/repo across graphs); dispatch normalized events to handleConnectorEvent; always 204 on accepted/ignored, 401 only on signature failure. `webhooksEnabled` toggle requires a configured public URL (validation on PUT); polling remains active as fallback; on daemon start with webhooks enabled, run one catch-up pollOnce.

Tests (all injected fetch / synthetic keys): manifest state round-trip (tamper → 400); conversion exchange stores encrypted creds (assert ciphertext at rest, decrypt round-trip); JWT shape (header/claims decode, RS256 verifies against the synthetic public key); installation-token cache (second call within expiry uses cache — count fetch calls); webhook signature valid → event ingested (same assertion as the poll parity test), invalid sig → 401 body-less, unknown repo → 204 no write; poll/webhook parity: the SAME comment delivered via pollOnce on one graph and via webhook on an identical second graph produces identical node content (compare attribute maps).

- [ ] Steps: failing tests → implement → suite + web checks green → commit `feat(connector): GitHub App mode — manifest flow, encrypted credentials, installation tokens, HMAC webhooks`.

---

### Task 4: surface integration — check-runs on cards, connector settings UI, smoke, spec

**Files:**
- Modify: `packages/core/src/gitreview.ts` (proposal cards gain `checks: Array<{name,status,conclusion?}>` read from check_status), api gitreview list/detail include it, client regen
- Modify: web GitProposalCard (checks row incl. the governance check by name), Settings area (connector section: mode picker, credential-mode connect button, app-mode wizard per the manifest flow — launch button that form-POSTs the manifest to GitHub, status display, webhook toggle gated on public URL field, manual "Poll now" button), hooks
- Create/extend: web tests; a daemon smoke with a mocked GitHub (report transcript)
- Modify: docs/specs/2026-08-04-governed-review-surface-design.md (sub-project 4 + M4 overall status)

**Steps:**
- [ ] Checks on cards: core+api+client+web with tests (mocked check_status rows render on the card; absent → no row).
- [ ] Settings connector UI with tests (mode flows against mocked client; wizard renders the form-POST with the manifest; webhook toggle disabled without public URL; vocabulary).
- [ ] Smoke: daemon on a temp home/port with a scratch repo graph; configure credential mode with a PATH-stubbed `gh` + injected mock upstream is NOT possible through the real daemon — so smoke the credential-config 409 path + poll trigger against the mock-friendly route if the daemon can take a GITHUB_API_BASE env override (add one: `GITHUB_API_BASE` respected by github.ts default client — small, honest, testable); transcript in report. Do NOT touch port 8710 or /Users/conner/code/allod.
- [ ] Spec: sub-project 4 status + deviations; M4 overall status note (all four sub-projects shipped; link: dependency pre-push caveat restated).
- [ ] Full suite + web build green. Commit `feat(web)+docs: connector surface; M4 shipped`.

## Self-review notes

- Spec coverage: credential mode w/ gh + credential-helper fallback (T1/T2), App manifest wizard incl. HMAC state/conversions/encrypted creds/installation tokens (T3), webhooks w/ signature validation + polling fallback + startup catch-up (T3), one-way ingest w/ provenance/dedup/edit/tombstone (T1), poll/webhook parity test (T3), check-run status on cards (T4), repo linkage from originRemote (T1/T2), no posting back (constraint).
- The ingest principal decision (github-connector service principal) is Task 1's; Tasks 2-4 must reuse whatever it ships — the report must state it for the later briefs.
- GITHUB_API_BASE override is introduced in T1's client (default https://api.github.com) so T4's smoke works — T1 implementer: make the default overridable by env there.
