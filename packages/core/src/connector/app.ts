/**
 * @freehold/core/connector — GitHub App JWT minting and installation-token cache.
 *
 * mintAppJwt: build an RS256 JWT signed with the app's private key.
 * makeAppClient: return a GithubClient backed by a minted (and cached) installation token.
 *
 * The token cache is stored in the connector_secrets table under the key
 * "installationToken" (ciphertext) and "installationTokenExpiry" (plain text ISO).
 * An in-process Map provides a hot-path shortcut within a single daemon session
 * so the PGlite query is also skipped on repeated calls.
 *
 * Never logs secrets, tokens, or PEM material.
 */

import { createPrivateKey, sign } from "node:crypto";
import type { DbHandle } from "../db.js";
import type { Freehold } from "../graphs.js";
import { deriveEncKey, getConnector, getSecret } from "./config.js";
import { makeTokenClient } from "./github.js";
import type { GithubClient } from "./github.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const GITHUB_API_BASE = "https://api.github.com";
/** Back-date the JWT `iat` by 60 seconds to tolerate clock skew. */
const JWT_IAT_BACKDATE_SEC = 60;
/** Expire the JWT 9 minutes out (GitHub max is 10). */
const JWT_EXP_DURATION_SEC = 540;
/** Refresh the installation token when it has fewer than 5 minutes remaining. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// ── In-process token cache ────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  /** Absolute expiry timestamp as returned by GitHub (ms since epoch). */
  expiresAtMs: number;
}

/** Hot-path in-process cache keyed by graphId. Cleared on daemon restart. */
const inProcessCache = new Map<string, CachedToken>();

// ── JWT minting ───────────────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a short-lived GitHub App JWT (RS256) from the app's private key PEM.
 *
 * @param opts.appId       - The numeric GitHub App ID (string or number).
 * @param opts.privateKeyPem - PKCS#1 or PKCS#8 PEM.
 * @param opts.nowMs       - Override for the current time in ms (tests).
 */
export function mintAppJwt(opts: {
  appId: string;
  privateKeyPem: string;
  nowMs?: number;
}): string {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSec - JWT_IAT_BACKDATE_SEC,
    exp: nowSec + JWT_EXP_DURATION_SEC,
    iss: opts.appId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const privateKey = createPrivateKey(opts.privateKeyPem);
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

// ── Installation-token minting + caching ──────────────────────────────────────

interface AccessTokenResponse {
  token: string;
  expires_at: string;
}

function parseAccessTokenResponse(payload: unknown): { token: string; expiresAtMs: number } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("installation access_tokens: unexpected response shape");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.token !== "string") throw new Error("installation access_tokens: missing token");
  if (typeof p.expires_at !== "string")
    throw new Error("installation access_tokens: missing expires_at");
  const expiresAtMs = Date.parse(p.expires_at);
  if (Number.isNaN(expiresAtMs))
    throw new Error("installation access_tokens: unparseable expires_at");
  return { token: p.token, expiresAtMs };
}

/**
 * Build a GithubClient for app mode backed by a cached installation token.
 *
 * Returns null when:
 * - No connector config is set for this graph.
 * - The config has no appId or installationId.
 * - No PEM secret is stored.
 *
 * The token is cached in-process (and in PGlite) for the session duration.
 * A second call within the expiry window re-uses the cached token without
 * a network round-trip.
 */
export async function makeAppClient(
  fh: Pick<Freehold, "db" | "graphId">,
  encKey: Buffer,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<GithubClient | null> {
  const cfg = await getConnector(fh.db, fh.graphId);
  if (!cfg || !cfg.appId || !cfg.installationId) return null;

  const nowMs = Date.now();

  // ── Hot-path: in-process cache ────────────────────────────────────────────
  const cached = inProcessCache.get(fh.graphId);
  if (cached && cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > nowMs) {
    return makeTokenClient(cached.token, fetchImpl);
  }

  // ── PEM retrieval ─────────────────────────────────────────────────────────
  const pem = await getSecret(fh.db, fh.graphId, "pem", encKey);
  if (!pem) return null;

  // ── Mint JWT ──────────────────────────────────────────────────────────────
  const jwt = mintAppJwt({ appId: cfg.appId, privateKeyPem: pem });

  // ── Mint installation token ───────────────────────────────────────────────
  const apiBase = (process.env.GITHUB_API_BASE ?? GITHUB_API_BASE).replace(/\/$/, "");
  const url = `${apiBase}/app/installations/${cfg.installationId}/access_tokens`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    throw new Error(
      `GitHub App: POST /app/installations/${cfg.installationId}/access_tokens returned ${res.status}`
    );
  }

  const { token, expiresAtMs } = parseAccessTokenResponse(await res.json());

  // ── Update in-process cache ───────────────────────────────────────────────
  inProcessCache.set(fh.graphId, { token, expiresAtMs });

  return makeTokenClient(token, fetchImpl);
}

/** Clear the in-process token cache for a graph (e.g. after config change). */
export function clearAppClientCache(graphId: string): void {
  inProcessCache.delete(graphId);
}

// ── Manifest helpers ──────────────────────────────────────────────────────────

export interface AppManifest {
  name: string;
  url: string;
  redirect_url: string;
  default_permissions: {
    contents: string;
    pull_requests: string;
    checks: string;
    metadata: string;
  };
  default_events: string[];
  public: boolean;
  hook_attributes?: { url: string };
}

/**
 * Build the GitHub App manifest for the freehold connector.
 *
 * @param origin     - Base URL of the freehold daemon (used for redirect_url).
 * @param graphId    - The graph this app is being created for.
 * @param publicUrl  - If set, includes webhook configuration in the manifest.
 */
export function buildConnectorManifest(opts: {
  origin: string;
  graphId: string;
  publicUrl?: string;
}): AppManifest {
  const { origin, graphId, publicUrl } = opts;
  const callbackBase = publicUrl ?? origin;

  const manifest: AppManifest = {
    name: `freehold-${graphId
      .slice(0, 20)
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase()}`,
    url: callbackBase,
    redirect_url: `${origin}/connector/app/callback`,
    default_permissions: {
      contents: "read",
      pull_requests: "read",
      checks: "read",
      metadata: "read",
    },
    default_events: ["push", "pull_request", "pull_request_review", "issue_comment"],
    public: false,
  };

  if (publicUrl) {
    manifest.hook_attributes = { url: `${publicUrl}/webhooks/github` };
  }

  return manifest;
}
