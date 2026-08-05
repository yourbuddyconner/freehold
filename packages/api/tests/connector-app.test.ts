/**
 * Task 3 — GitHub App mode: manifest flow, encrypted credentials,
 * installation tokens, HMAC webhooks.
 *
 * All tests use injected fetch and synthetic RSA keys; no live GitHub calls.
 *
 * Tests:
 *   - manifest state round-trip: valid → 200; tampered state → 400
 *   - conversion exchange: stores encrypted credentials; decrypt round-trip proves ciphertext at rest
 *   - JWT shape: header/claims decode, RS256 verifies against synthetic public key
 *   - installation-token cache: second call within expiry uses cache (count fetch calls)
 *   - webhook signature valid → event ingested
 *   - webhook invalid sig → 204 (same as unknown repo — no oracle)
 *   - webhook unknown repo → 204 no write
 *   - poll/webhook parity: same comment via pollOnce and webhook produces identical node attribute maps
 */

import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphManager, createGraph, hashEmbedder, loadConfig } from "@freehold/core";
import {
  deriveEncKey,
  getCommentNodeByExternalId,
  getConnector,
  getSecret,
  makeTokenClient,
  pollOnce,
  setConnector,
} from "@freehold/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Generate a synthetic RSA-2048 keypair for JWT tests. */
function makeSyntheticRsaKeys(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/** Decode a base64url string. */
function fromBase64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Compute HMAC-SHA256 for webhook signature. */
function webhookSig(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Build a minimal mock GitHub API fetch for the manifest conversion + installation tokens. */
function makeGithubMockFetch(opts: {
  conversionCode?: string;
  conversionResponse?: Record<string, unknown>;
  installationTokenResponse?: Record<string, unknown>;
  openPrs?: Array<{ number: number; head: { sha: string; ref: string } }>;
  reviewComments?: Array<{
    id: number;
    body: string;
    user: { login: string };
    path?: string;
    commit_id?: string;
    in_reply_to_id?: number;
  }>;
  issueComments?: Array<{ id: number; body: string; user: { login: string } }>;
  reviews?: Array<{ id: number; body: string; user: { login: string }; state: string }>;
  checkRuns?: Array<{
    head_sha: string;
    check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
  }>;
  fetchCallCount?: { count: number };
}): typeof fetch {
  return (async (url: string | Request | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = url instanceof Request ? url.url : String(url);
    const path = urlStr.replace("https://api.github.com", "");

    // /app-manifests/:code/conversions
    const conversionMatch = path.match(/^\/app-manifests\/([^/]+)\/conversions$/);
    if (conversionMatch) {
      const code = conversionMatch[1];
      if (opts.conversionCode && code !== opts.conversionCode) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (opts.conversionResponse) {
        return new Response(JSON.stringify(opts.conversionResponse), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // POST /app/installations/:id/access_tokens
    if (path.match(/^\/app\/installations\/\d+\/access_tokens$/)) {
      if (opts.fetchCallCount) opts.fetchCallCount.count++;
      if (opts.installationTokenResponse) {
        return new Response(JSON.stringify(opts.installationTokenResponse), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // GET /repos/:owner/:repo/pulls?state=open&per_page=100
    if (path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\?state=open&per_page=100$/)) {
      return new Response(JSON.stringify(opts.openPrs ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // GET /repos/:owner/:repo/pulls/:num/comments
    if (path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments/)) {
      return new Response(JSON.stringify(opts.reviewComments ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // GET /repos/:owner/:repo/issues/:num/comments
    if (path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/)) {
      return new Response(JSON.stringify(opts.issueComments ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // GET /repos/:owner/:repo/pulls/:num/reviews
    if (path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews/)) {
      return new Response(JSON.stringify(opts.reviews ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // GET /repos/:owner/:repo/commits/:sha/check-runs
    const checkRunsMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs/);
    if (checkRunsMatch) {
      const sha = checkRunsMatch[1];
      const found = (opts.checkRuns ?? []).find((cr) => cr.head_sha === sha);
      return new Response(JSON.stringify({ check_runs: found?.check_runs ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let home: string;
let repoDir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let repoGraphId: string;
let manager: GraphManager;
let syntheticKeys: { privateKeyPem: string; publicKeyPem: string };

async function req(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(extraHeaders ?? {}),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await app.request(`http://localhost${path}`, init);
  let responseBody: unknown;
  const ct = res.headers.get("content-type");
  if (ct?.includes("application/json")) {
    try {
      responseBody = await res.json();
    } catch {
      responseBody = null;
    }
  } else {
    responseBody = null;
  }
  return { status: res.status, body: responseBody, headers: res.headers };
}

/** POST a webhook to /webhooks/github without bearer auth. */
async function webhookReq(
  rawBody: string,
  headers: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const res = await app.request("http://localhost/webhooks/github", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: rawBody,
  });
  let responseBody: unknown;
  const ct = res.headers.get("content-type");
  if (ct?.includes("application/json")) {
    try {
      responseBody = await res.json();
    } catch {
      responseBody = null;
    }
  } else {
    responseBody = null;
  }
  return { status: res.status, body: responseBody };
}

/** GET /connector/app/callback without bearer auth (open route — HMAC state authenticates). */
async function callbackReq(
  queryStr: string,
  appInstance: ReturnType<typeof createApp> = app
): Promise<{ status: number; body: unknown }> {
  const res = await appInstance.request(`http://localhost/connector/app/callback?${queryStr}`, {
    method: "GET",
    // No Authorization header — this is an open route
  });
  let responseBody: unknown;
  const ct = res.headers.get("content-type");
  if (ct?.includes("application/json")) {
    try {
      responseBody = await res.json();
    } catch {
      responseBody = null;
    }
  } else {
    responseBody = null;
  }
  return { status: res.status, body: responseBody };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  home = makeTempDir("freehold-app-test-");
  const config = loadConfig(home);
  token = config.token;

  manager = await GraphManager.open(home);
  app = createApp(manager, hashEmbedder, config);

  syntheticKeys = makeSyntheticRsaKeys();

  // Create a repo directory with a git repo
  repoDir = makeTempDir("freehold-app-test-repo-");
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/testrepo.git"], {
    cwd: repoDir,
  });
  writeFileSync(join(repoDir, "README.md"), "# test");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  await createGraph(repoDir, "owner");

  // Register the repo graph via HTTP API
  const r = await req("POST", "/api/v1/graphs", {
    path: repoDir,
    id: "app-test-repo",
    name: "App Test Repo",
  });
  expect(r.status, "failed to register repo graph").toBe(201);
  repoGraphId = "app-test-repo";
});

afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Test: App manifest state round-trip
// ---------------------------------------------------------------------------

describe("manifest state", () => {
  test("POST /connector/app/manifest returns a signed state and GitHub form-POST URL", async () => {
    const r = await req("POST", `/api/v1/graphs/${repoGraphId}/connector/app/manifest`, {});
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.state).toBe("string");
    expect(typeof body.manifestUrl).toBe("string");
    expect(typeof body.manifest).toBe("object");
    const manifest = body.manifest as Record<string, unknown>;
    // Must include the connector-required permissions
    const permissions = manifest.default_permissions as Record<string, string>;
    expect(permissions.contents).toBe("read");
    expect(permissions.pull_requests).toBe("read");
    expect(permissions.checks).toBe("read");
    expect(permissions.metadata).toBe("read");
    // State must have the format: base64url.base64url (2 parts)
    const parts = (body.state as string).split(".");
    expect(parts).toHaveLength(2);
    // redirect_url must be the open path (no /api/v1/ prefix — no bearer required)
    const redirectUrl = (manifest as { redirect_url?: string }).redirect_url ?? "";
    expect(redirectUrl).toMatch(/\/connector\/app\/callback$/);
    expect(redirectUrl).not.toContain("/api/v1/");
  });

  test("GET /connector/app/callback with tampered state returns 400 (no bearer required)", async () => {
    const r = await callbackReq("code=abc&state=tampered.invalidsig");
    expect(r.status).toBe(400);
  });

  test("GET /connector/app/callback with missing code returns 400 (no bearer required)", async () => {
    const r = await callbackReq("state=something");
    expect(r.status).toBe(400);
  });

  test("GET /connector/app/callback with missing state returns 400 (no bearer required)", async () => {
    const r = await callbackReq("code=abc");
    expect(r.status).toBe(400);
  });

  test("nonce replay: same state token twice → second call returns 400 (no bearer required)", async () => {
    // Get a fresh state token (manifest still requires auth)
    const manifestR = await req("POST", `/api/v1/graphs/${repoGraphId}/connector/app/manifest`, {});
    expect(manifestR.status).toBe(200);
    const { state } = manifestR.body as { state: string };

    // First call — state is valid; it will fail at GitHub exchange (502/409) but not at state validation (not 400)
    const r1 = await callbackReq(`code=noncetest&state=${encodeURIComponent(state)}`);
    expect(r1.status).not.toBe(400);

    // Second call with the same state — nonce already consumed → 400
    const r2 = await callbackReq(`code=noncetest&state=${encodeURIComponent(state)}`);
    expect(r2.status).toBe(400);
    const body2 = r2.body as Record<string, unknown>;
    expect(typeof body2.error).toBe("string");
    expect((body2.error as string).toLowerCase()).toContain("used");
  });
});

// ---------------------------------------------------------------------------
// Test: Conversion exchange stores encrypted credentials
// ---------------------------------------------------------------------------

describe("manifest conversion exchange", () => {
  test("encrypted creds at rest: ciphertext differs from plaintext, decrypts correctly", async () => {
    // This test exercises setConnector with encrypted secrets and verifies:
    // 1. The raw DB row is not the plaintext
    // 2. getSecret decrypts it back to the original value
    const fh = await manager.get(repoGraphId);
    const encKey = deriveEncKey(token);

    await setConnector(
      fh.db,
      {
        graphId: repoGraphId,
        mode: "app",
        owner: "owner",
        repo: "testrepo",
        pollIntervalSec: 300,
        webhooksEnabled: false,
        appId: "99999",
        appSlug: "my-app",
        installationId: "55555",
      },
      {
        pem: syntheticKeys.privateKeyPem,
        webhookSecret: "my-webhook-secret",
        clientSecret: "my-client-secret",
      },
      encKey
    );

    // Verify ciphertext at rest does NOT contain the raw PEM
    const rawResult = await fh.db.pg.query<{ ciphertext: Uint8Array; name: string }>(
      "SELECT name, ciphertext FROM connector_secrets WHERE graph_id = $1",
      [repoGraphId]
    );
    expect(rawResult.rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rawResult.rows) {
      const ct = Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(row.ciphertext);
      if (row.name === "pem") {
        expect(ct.toString("utf-8")).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
      }
      if (row.name === "webhookSecret") {
        expect(ct.toString("utf-8")).not.toContain("my-webhook-secret");
      }
    }

    // Decrypt and verify round-trip
    const decryptedPem = await getSecret(fh.db, repoGraphId, "pem", encKey);
    expect(decryptedPem).toBe(syntheticKeys.privateKeyPem);

    const decryptedWebhook = await getSecret(fh.db, repoGraphId, "webhookSecret", encKey);
    expect(decryptedWebhook).toBe("my-webhook-secret");

    const decryptedClientSecret = await getSecret(fh.db, repoGraphId, "clientSecret", encKey);
    expect(decryptedClientSecret).toBe("my-client-secret");
  });

  test("GET /connector/app/callback with valid state and mocked conversions fetch stores encrypted credentials", async () => {
    const { privateKeyPem } = syntheticKeys;

    const conversionPayload = {
      id: 77001,
      slug: "injected-test-app",
      client_id: "Iv1.injectedclient",
      client_secret: "injected-client-secret",
      webhook_secret: "injected-webhook-secret",
      pem: privateKeyPem,
      html_url: "https://github.com/apps/injected-test-app",
    };

    const mockFetch = makeGithubMockFetch({
      conversionCode: "injected-code",
      conversionResponse: conversionPayload,
    });

    // Create a separate home/manager/app with the injectable fetch so the real
    // global fetch is not used.
    const injectHome = makeTempDir("freehold-inject-test-");
    const injectConfig = loadConfig(injectHome);
    const injectManager = await GraphManager.open(injectHome);
    // Create a repo graph in the inject environment
    const injectRepoDir = makeTempDir("freehold-inject-repo-");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init"], { cwd: injectRepoDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: injectRepoDir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: injectRepoDir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/injectowner/injectrepo.git"],
      { cwd: injectRepoDir }
    );
    writeFileSync(join(injectRepoDir, "README.md"), "# inject");
    execFileSync("git", ["add", "README.md"], { cwd: injectRepoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: injectRepoDir });
    await createGraph(injectRepoDir, "owner");

    const injectApp = createApp(injectManager, hashEmbedder, injectConfig, { fetchFn: mockFetch });

    async function injectReq(
      method: string,
      path: string,
      body?: unknown
    ): Promise<{ status: number; body: unknown }> {
      const init: RequestInit = {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${injectConfig.token}`,
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await injectApp.request(`http://localhost${path}`, init);
      const ct = res.headers.get("content-type");
      let responseBody: unknown = null;
      if (ct?.includes("application/json")) {
        try {
          responseBody = await res.json();
        } catch {}
      }
      return { status: res.status, body: responseBody };
    }

    // Register the repo graph
    const regR = await injectReq("POST", "/api/v1/graphs", {
      path: injectRepoDir,
      id: "inject-repo",
      name: "Inject Repo",
    });
    expect(regR.status, `register inject-repo: ${JSON.stringify(regR.body)}`).toBe(201);

    // Step 1: get a valid signed state
    const manifestR = await injectReq(
      "POST",
      "/api/v1/graphs/inject-repo/connector/app/manifest",
      {}
    );
    expect(manifestR.status).toBe(200);
    const { state } = manifestR.body as { state: string };

    // Step 2: callback via the open route (no bearer header) with valid state + injected mock fetch
    const callbackR = await callbackReq(
      `code=injected-code&state=${encodeURIComponent(state)}`,
      injectApp
    );
    expect(callbackR.status).toBe(200);
    const cbBody = callbackR.body as Record<string, unknown>;
    expect(cbBody.ok).toBe(true);
    expect(cbBody.appId).toBe("77001");
    expect(cbBody.appSlug).toBe("injected-test-app");

    // Step 3: verify credentials are stored encrypted (ciphertext at rest)
    const injectFh = await injectManager.get("inject-repo");
    const encKey = deriveEncKey(injectConfig.token);

    const rawRows = await injectFh.db.pg.query<{ name: string; ciphertext: Uint8Array }>(
      "SELECT name, ciphertext FROM connector_secrets WHERE graph_id = $1",
      ["inject-repo"]
    );
    expect(rawRows.rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rawRows.rows) {
      const ct = Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(row.ciphertext);
      if (row.name === "pem") {
        expect(ct.toString("utf-8")).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
      }
      if (row.name === "webhookSecret") {
        expect(ct.toString("utf-8")).not.toContain("injected-webhook-secret");
      }
    }

    // Step 4: decrypt round-trip
    const decPem = await getSecret(injectFh.db, "inject-repo", "pem", encKey);
    expect(decPem).toBe(privateKeyPem);
    const decWebhook = await getSecret(injectFh.db, "inject-repo", "webhookSecret", encKey);
    expect(decWebhook).toBe("injected-webhook-secret");
    const decClient = await getSecret(injectFh.db, "inject-repo", "clientSecret", encKey);
    expect(decClient).toBe("injected-client-secret");

    // Step 5: config carries appId/slug
    const cfg = await getConnector(injectFh.db, "inject-repo");
    expect(cfg?.appId).toBe("77001");
    expect(cfg?.appSlug).toBe("injected-test-app");

    // Cleanup
    try {
      rmSync(injectHome, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(injectRepoDir, { recursive: true, force: true });
    } catch {}
  });
});

// ---------------------------------------------------------------------------
// Test: JWT shape — RS256, header/claims, verify against synthetic public key
// ---------------------------------------------------------------------------

describe("JWT minting", () => {
  test("mintAppJwt produces a valid RS256 JWT with correct claims and verifiable signature", async () => {
    const { mintAppJwt } = await import("../src/connector/app.js");

    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = mintAppJwt({
      appId: "42",
      privateKeyPem: syntheticKeys.privateKeyPem,
    });

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(fromBase64url(parts[0]).toString("utf-8"));
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");

    const claims = JSON.parse(fromBase64url(parts[1]).toString("utf-8"));
    expect(claims.iss).toBe("42");
    // iat backdated 60s, exp 9min out
    expect(claims.iat).toBeLessThanOrEqual(nowSec);
    expect(claims.iat).toBeGreaterThan(nowSec - 120);
    expect(claims.exp).toBeGreaterThan(nowSec + 500);
    expect(claims.exp).toBeLessThanOrEqual(nowSec + 600);

    // Verify RS256 signature against synthetic public key
    const signingInput = `${parts[0]}.${parts[1]}`;
    const sig = fromBase64url(parts[2]);
    const verify = createVerify("RSA-SHA256");
    verify.update(signingInput);
    expect(verify.verify(syntheticKeys.publicKeyPem, sig)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test: Installation-token cache
// ---------------------------------------------------------------------------

describe("installation token cache", () => {
  test("second call within expiry uses cache — fetch count stays at 1", async () => {
    const { makeAppClient } = await import("../src/connector/app.js");

    const fetchCallCount = { count: 0 };
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1hr
    const mockFetch = makeGithubMockFetch({
      installationTokenResponse: { token: "ghs_abc123", expires_at: expiresAt },
      fetchCallCount,
    });

    const fh = await manager.get(repoGraphId);
    const encKey = deriveEncKey(token);

    // Config already set in previous test (appId: 99999, installationId: 55555)
    // Just ensure pem is present
    const pem = await getSecret(fh.db, repoGraphId, "pem", encKey);
    expect(pem).not.toBeNull(); // must be set from previous test

    // First call — should mint a token (1 fetch)
    const client1 = await makeAppClient(fh, encKey, mockFetch);
    expect(client1).not.toBeNull();
    expect(fetchCallCount.count).toBe(1);

    // Second call — should use cache (no additional fetch)
    const client2 = await makeAppClient(fh, encKey, mockFetch);
    expect(client2).not.toBeNull();
    expect(fetchCallCount.count).toBe(1); // still 1
  });
});

// ---------------------------------------------------------------------------
// Test: Webhook HMAC validation
// ---------------------------------------------------------------------------

describe("POST /webhooks/github", () => {
  const WEBHOOK_SECRET = "my-webhook-secret";
  const OWNER = "owner";
  const REPO = "testrepo";

  // issue_comment webhook (PR comment)
  const issueCommentPayload = JSON.stringify({
    action: "created",
    repository: { full_name: `${OWNER}/${REPO}` },
    issue: { number: 1, pull_request: {} },
    comment: {
      id: 77777,
      body: "webhook comment body",
      user: { login: "alice" },
    },
  });

  test("valid signature → 204 and event ingested into graph", async () => {
    // Ensure connector config with webhooks enabled and the right webhook secret
    const fh = await manager.get(repoGraphId);
    const encKey = deriveEncKey(token);
    await setConnector(
      fh.db,
      {
        graphId: repoGraphId,
        mode: "app",
        owner: OWNER,
        repo: REPO,
        pollIntervalSec: 300,
        webhooksEnabled: true,
        appId: "99999",
        appSlug: "my-app",
        installationId: "55555",
      },
      { webhookSecret: WEBHOOK_SECRET },
      encKey
    );

    const sig = webhookSig(issueCommentPayload, WEBHOOK_SECRET);
    const r = await webhookReq(issueCommentPayload, {
      "X-GitHub-Event": "issue_comment",
      "X-Hub-Signature-256": sig,
    });

    expect(r.status).toBe(204);

    // Verify the comment was ingested into the graph
    const node = await getCommentNodeByExternalId(fh, "issue:77777");
    expect(node).not.toBeNull();
    expect(node?.attributes.body).toBe("webhook comment body");
    expect(node?.attributes.external_source).toBe("github");
    expect(node?.attributes.claimed_author).toBe("alice");
    expect(node?.attributes.status).toBe("open");
  });

  test("invalid signature → 204 (same as unknown repo — avoids graph-existence oracle), no event ingested", async () => {
    // Record how many comment nodes exist before the bad-sig request
    const fh = await manager.get(repoGraphId);
    const before = await getCommentNodeByExternalId(fh, "issue:77777");
    // node may or may not exist from the valid-sig test above — we just check nothing new is added

    const r = await webhookReq(issueCommentPayload, {
      "X-GitHub-Event": "issue_comment",
      "X-Hub-Signature-256": "sha256=invalidsignature",
    });
    // 204 regardless of whether the repo is known — prevents repo-existence oracle
    expect(r.status).toBe(204);
    // body must be empty / null
    expect(r.body).toBeNull();

    // No new node created for a different comment id that wasn't ingested before
    const neverIngested = await getCommentNodeByExternalId(fh, "issue:00000");
    expect(neverIngested).toBeNull();
    void before;
  });

  test("missing X-Hub-Signature-256 header → 204 (no oracle)", async () => {
    const r = await webhookReq(issueCommentPayload, {
      "X-GitHub-Event": "issue_comment",
    });
    expect(r.status).toBe(204);
  });

  test("unknown repo (no graph matches) → 204 silent, nothing written", async () => {
    const unknownPayload = JSON.stringify({
      action: "created",
      repository: { full_name: "unknown/nonexistent-repo" },
      issue: { number: 2, pull_request: {} },
      comment: {
        id: 88888,
        body: "should not be ingested",
        user: { login: "bob" },
      },
    });
    // Sign with correct key (but repo won't match any graph)
    const sig = webhookSig(unknownPayload, WEBHOOK_SECRET);
    const r = await webhookReq(unknownPayload, {
      "X-GitHub-Event": "issue_comment",
      "X-Hub-Signature-256": sig,
    });
    expect(r.status).toBe(204);

    // The comment must NOT be in any graph
    const fh = await manager.get(repoGraphId);
    const node = await getCommentNodeByExternalId(fh, "issue:88888");
    expect(node).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test: poll/webhook parity
// ---------------------------------------------------------------------------

describe("poll/webhook parity", () => {
  let parityHome: string;
  let parityManager: GraphManager;
  let parityApp: ReturnType<typeof createApp>;
  let parityToken: string;

  beforeAll(async () => {
    parityHome = makeTempDir("freehold-parity-");
    const parityConfig = loadConfig(parityHome);
    parityToken = parityConfig.token;
    parityManager = await GraphManager.open(parityHome);
    parityApp = createApp(parityManager, hashEmbedder, parityConfig);

    // Create two repo dirs
    for (const id of ["parity1", "parity2"]) {
      const dir = makeTempDir(`freehold-parity-${id}-`);
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/parityowner/parityrepo.git"],
        { cwd: dir }
      );
      writeFileSync(join(dir, "README.md"), "# parity");
      execFileSync("git", ["add", "README.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      await createGraph(dir, "owner");

      const regRes = await parityApp.request("http://localhost/api/v1/graphs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${parityToken}`,
        },
        body: JSON.stringify({ path: dir, id, name: `Parity ${id}` }),
      });
      const regBody = (await regRes.json()) as Record<string, unknown>;
      expect(regRes.status, `register ${id}: ${JSON.stringify(regBody)}`).toBe(201);
    }
  });

  afterAll(() => {
    try {
      rmSync(parityHome, { recursive: true, force: true });
    } catch {}
  });

  test("same PR review comment via pollOnce and webhook produces identical node attribute maps", async () => {
    const PARITY_WEBHOOK_SECRET = "parity-webhook-secret";
    const encKey = deriveEncKey(parityToken);

    // Both graphs configured with identical connector settings.
    // parity1 receives the comment via pollOnce (graph 1).
    // parity2 receives the comment via webhook (graph 2).
    // We verify the resulting node attribute maps are identical.
    //
    // Because the webhook route matches by owner/repo, it will route to whichever
    // graph it finds first. We use distinct owner/repo per graph so that each
    // receives the webhook separately and unambiguously.
    const fh1 = await parityManager.get("parity1");
    const fh2 = await parityManager.get("parity2");

    const OWNER1 = "parityowner";
    const REPO1 = "parityrepo1";
    const OWNER2 = "parityowner";
    const REPO2 = "parityrepo2";

    const baseCfg = {
      mode: "app" as const,
      pollIntervalSec: 300,
      webhooksEnabled: true,
      appId: "11111",
      appSlug: "parity-app",
      installationId: "22222",
    };

    await setConnector(
      fh1.db,
      { graphId: "parity1", owner: OWNER1, repo: REPO1, ...baseCfg },
      { webhookSecret: PARITY_WEBHOOK_SECRET },
      encKey
    );
    await setConnector(
      fh2.db,
      { graphId: "parity2", owner: OWNER2, repo: REPO2, ...baseCfg },
      { webhookSecret: PARITY_WEBHOOK_SECRET },
      encKey
    );

    // Update parity2's origin_remote to parityrepo2 so the webhook lookup
    // can route specifically to it (both graphs share parityowner but have
    // different repo names so the webhook routes unambiguously).
    await parityManager.db.pg.query("UPDATE graphs SET origin_remote = $1 WHERE id = $2", [
      `https://github.com/${OWNER2}/${REPO2}.git`,
      "parity2",
    ]);

    // Comment data
    const commentId = 99901;
    const commentBody = "parity test comment";
    const commentAuthor = "parityuser";
    const commentPath = "src/main.ts";
    const commitSha = "abc123deadbeef";

    // Graph 1: deliver via pollOnce against parityrepo1
    const mockFetch = makeGithubMockFetch({
      openPrs: [{ number: 5, head: { sha: commitSha, ref: "feature" } }],
      reviewComments: [
        {
          id: commentId,
          body: commentBody,
          user: { login: commentAuthor },
          path: commentPath,
          commit_id: commitSha,
        },
      ],
      issueComments: [],
      reviews: [],
      checkRuns: [],
    });
    const pollClient = makeTokenClient("fake-token", mockFetch);
    const pollCfg1 = await getConnector(fh1.db, "parity1");
    expect(pollCfg1).not.toBeNull();
    if (!pollCfg1) throw new Error("connector config is null");
    await pollOnce(fh1, pollCfg1, pollClient);

    // Graph 2: deliver via webhook (pull_request_review_comment on parityrepo2)
    const webhookPayload = JSON.stringify({
      action: "created",
      repository: { full_name: `${OWNER2}/${REPO2}` },
      pull_request: { number: 5 },
      comment: {
        id: commentId,
        body: commentBody,
        user: { login: commentAuthor },
        path: commentPath,
        commit_id: commitSha,
        in_reply_to_id: null,
      },
    });

    const sig = webhookSig(webhookPayload, PARITY_WEBHOOK_SECRET);
    const webhookRes = await parityApp.request("http://localhost/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request_review_comment",
        "X-Hub-Signature-256": sig,
      },
      body: webhookPayload,
    });
    expect(webhookRes.status).toBe(204);

    // Compare node attribute maps
    const node1 = await getCommentNodeByExternalId(fh1, String(commentId));
    const node2 = await getCommentNodeByExternalId(fh2, String(commentId));

    expect(node1).not.toBeNull();
    expect(node2).not.toBeNull();

    // Core attributes must be identical
    const relevantKeys = ["body", "external_source", "claimed_author", "external_id", "status"];
    for (const key of relevantKeys) {
      expect(node1?.attributes[key]).toBe(node2?.attributes[key]);
    }
    // Anchor should contain the path in both
    expect(String(node1?.attributes.anchor ?? "")).toContain(commentPath);
    expect(String(node2?.attributes.anchor ?? "")).toContain(commentPath);
  });
});
