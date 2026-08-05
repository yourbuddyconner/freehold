/**
 * Connector API routes.
 *
 * Scoped mount — all routes guard against non-repo graphs with a 400.
 * GET  /connector                  → { configured, config?: sans-secrets, status: { lastPollAt?, lastErrors? } }
 * PUT  /connector                  → credential mode; 409 no-credential / missing-origin-remote
 * POST /connector/poll             → run pollOnce now
 * DELETE /connector                → remove config + secrets
 *
 * GitHub App mode (Task 3):
 * POST /connector/app/manifest     → build manifest + signed HMAC state for browser form-POST
 * GET  /connector/app/callback     → verify state HMAC → exchange conversions → store encrypted creds
 * POST /connector/app/installation → persist installationId; 204
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  getConnector,
  setConnector,
  discoverCredential,
  parseOriginRemote,
  makeTokenClient,
  pollOnce,
  deriveEncKey,
  getSecret,
  buildConnectorManifest,
} from "@freehold/core";
import type { AppEnv } from "../types.js";

// ── HMAC state helpers (manifest flow) ───────────────────────────────────────

interface ManifestStatePayload {
  graphId: string;
  nonce: string;
  exp: number;
}

const STATE_TTL_MS = 15 * 60 * 1000;

function signManifestState(payload: ManifestStatePayload, key: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifyManifestState(
  state: string,
  key: Buffer,
  nowMs: number
): ManifestStatePayload | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = createHmac("sha256", key).update(payloadB64).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.graphId !== "string") return null;
  if (typeof p.nonce !== "string") return null;
  if (typeof p.exp !== "number") return null;
  if (p.exp < nowMs) return null; // expired
  return { graphId: p.graphId, nonce: p.nonce, exp: p.exp };
}

// ── Manifest conversion response parser ──────────────────────────────────────

interface ParsedConversion {
  appId: string;
  appSlug: string;
  pem: string;
  webhookSecret: string;
  clientSecret: string;
}

function parseManifestConversion(payload: unknown): ParsedConversion | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.id !== "number" && typeof p.id !== "string") return null;
  if (typeof p.slug !== "string") return null;
  if (typeof p.pem !== "string") return null;
  if (typeof p.client_secret !== "string") return null;
  // webhook_secret may be null for apps without a public URL
  const webhookSecret =
    typeof p.webhook_secret === "string" ? p.webhook_secret : "";
  return {
    appId: String(p.id),
    appSlug: p.slug,
    pem: p.pem,
    webhookSecret,
    clientSecret: p.client_secret,
  };
}

export const connectorRouter = new Hono<AppEnv>();

/** Guard: connector routes are only available for repo graphs. */
function repoOnly(fh: { kind: string }): boolean {
  return fh.kind === "repo";
}

const REPO_ONLY_ERROR = "connector is only available for repo graphs";

// ── GET /connector ────────────────────────────────────────────────────────────

connectorRouter.get("/connector", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  const cfg = await getConnector(fh.db, fh.graphId);

  if (!cfg) {
    return c.json({ configured: false, status: {} });
  }

  // Read cursor state for status
  let lastPollAt: string | null = null;
  let lastErrors: string[] | undefined;
  try {
    const cursor = await fh.db.pg.query<{ last_poll_at: string | null; state: unknown }>(
      `SELECT last_poll_at, state FROM connector_cursor WHERE graph_id = $1`,
      [fh.graphId]
    );
    if (cursor.rows.length > 0) {
      lastPollAt = cursor.rows[0].last_poll_at;
      const st = cursor.rows[0].state;
      if (st && typeof st === "object" && !Array.isArray(st)) {
        const stateObj = st as Record<string, unknown>;
        if (Array.isArray(stateObj.lastErrors)) {
          lastErrors = stateObj.lastErrors as string[];
        }
      }
    }
  } catch {
    // cursor table may not exist yet
  }

  // Config sans secrets (never return token/pem/webhookSecret/clientSecret)
  const configSansSecrets = {
    mode: cfg.mode,
    owner: cfg.owner,
    repo: cfg.repo,
    pollIntervalSec: cfg.pollIntervalSec,
    webhooksEnabled: cfg.webhooksEnabled,
    ...(cfg.appId ? { appId: cfg.appId } : {}),
    ...(cfg.appSlug ? { appSlug: cfg.appSlug } : {}),
    ...(cfg.installationId ? { installationId: cfg.installationId } : {}),
  };

  const status: Record<string, unknown> = {};
  if (lastPollAt) status.lastPollAt = lastPollAt;
  if (lastErrors) status.lastErrors = lastErrors;

  return c.json({ configured: true, config: configSansSecrets, status });
});

// ── PUT /connector ────────────────────────────────────────────────────────────

const PutConnectorBody = z.object({
  mode: z.literal("credential"),
  pollIntervalSec: z.number().int().positive().optional(),
});

connectorRouter.put("/connector", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const parsed = PutConnectorBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.issues }, 400);
  }

  const { pollIntervalSec = 300 } = parsed.data;

  // Discover credential via gh auth token / git credential fill
  const token = await discoverCredential();
  if (!token) {
    return c.json(
      { error: "no credential found", code: "no-credential" },
      409
    );
  }

  // Parse originRemote from manager entry
  const manager = c.get("manager");
  const entry = await manager.getEntry(fh.graphId);
  if (!entry?.originRemote) {
    return c.json(
      { error: "graph has no originRemote configured", code: "missing-origin-remote" },
      409
    );
  }

  const parsed_remote = parseOriginRemote(entry.originRemote);
  if (!parsed_remote) {
    return c.json(
      { error: "cannot parse originRemote as a GitHub remote", code: "missing-origin-remote" },
      409
    );
  }

  const cfg = {
    graphId: fh.graphId,
    mode: "credential" as const,
    owner: parsed_remote.owner,
    repo: parsed_remote.repo,
    pollIntervalSec,
    webhooksEnabled: false,
  };

  // Store config (token stored as a secret encrypted under daemon key)
  const config = c.get("config");
  const encKey = deriveEncKey(config.token);
  await setConnector(fh.db, cfg, { credentialToken: token }, encKey);

  return c.json({
    config: {
      mode: cfg.mode,
      owner: cfg.owner,
      repo: cfg.repo,
      pollIntervalSec: cfg.pollIntervalSec,
      webhooksEnabled: cfg.webhooksEnabled,
    },
  });
});

// ── POST /connector/poll ──────────────────────────────────────────────────────

connectorRouter.post("/connector/poll", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  const cfg = await getConnector(fh.db, fh.graphId);
  if (!cfg) {
    return c.json({ error: "connector not configured" }, 409);
  }

  // Retrieve stored token (credential mode: stored under "credentialToken" key)
  const config = c.get("config");
  const encKey = deriveEncKey(config.token);
  const token = await getSecret(fh.db, fh.graphId, "credentialToken", encKey);
  if (!token) {
    return c.json({ error: "no stored token; configure the connector first" }, 409);
  }

  const client = makeTokenClient(token);
  const result = await pollOnce(fh, cfg, client);

  return c.json(result);
});

// ── DELETE /connector ─────────────────────────────────────────────────────────

connectorRouter.delete("/connector", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  // Remove config row
  try {
    await fh.db.pg.query(
      `DELETE FROM connector_config WHERE graph_id = $1`,
      [fh.graphId]
    );
    await fh.db.pg.query(
      `DELETE FROM connector_secrets WHERE graph_id = $1`,
      [fh.graphId]
    );
    await fh.db.pg.query(
      `DELETE FROM connector_cursor WHERE graph_id = $1`,
      [fh.graphId]
    );
  } catch {
    // Table may not exist — that's fine; just return success.
  }

  return c.json({ ok: true });
});

// ── POST /connector/app/manifest ──────────────────────────────────────────────

connectorRouter.post("/connector/app/manifest", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  const config = c.get("config");
  const encKey = deriveEncKey(config.token);

  // Determine public URL from config or env (optional)
  const publicUrl = process.env.FREEHOLD_PUBLIC_URL ?? undefined;

  // Infer the request origin for the redirect_url
  const origin = new URL(c.req.url).origin;

  const manifest = buildConnectorManifest({
    origin,
    graphId: fh.graphId,
    publicUrl,
  });

  // Build HMAC-signed state (bound to this graph + 15-min expiry)
  const statePayload: ManifestStatePayload = {
    graphId: fh.graphId,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  };
  const state = signManifestState(statePayload, encKey);

  // GitHub App creation URL (user or org)
  const githubBase = process.env.GITHUB_URL ?? "https://github.com";
  const manifestUrl = `${githubBase}/settings/apps/new`;

  return c.json({ manifestUrl, manifest, state });
});

// ── GET /connector/app/callback ───────────────────────────────────────────────

connectorRouter.get("/connector/app/callback", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "missing code or state" }, 400);
  }

  const config = c.get("config");
  const encKey = deriveEncKey(config.token);

  const verified = verifyManifestState(state, encKey, Date.now());
  if (!verified) {
    return c.json({ error: "invalid or expired state" }, 400);
  }

  if (verified.graphId !== fh.graphId) {
    return c.json({ error: "state graph mismatch" }, 400);
  }

  // Exchange code for app credentials via GitHub API
  const githubApiBase = (process.env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/$/, "");
  const conversionUrl = `${githubApiBase}/app-manifests/${encodeURIComponent(code)}/conversions`;

  let res: Response;
  try {
    res = await fetch(conversionUrl, {
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
  const manager = c.get("manager");
  const entry = await manager.getEntry(fh.graphId);
  const parsedRemote = entry?.originRemote ? parseOriginRemote(entry.originRemote) : null;

  await setConnector(
    fh.db,
    {
      graphId: fh.graphId,
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

// ── POST /connector/app/installation ─────────────────────────────────────────

const InstallationBody = z.object({
  installationId: z.union([z.string(), z.number()]).transform(String),
});

connectorRouter.post("/connector/app/installation", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const parsed = InstallationBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.issues }, 400);
  }

  const cfg = await getConnector(fh.db, fh.graphId);
  if (!cfg || cfg.mode !== "app") {
    return c.json({ error: "App mode connector not configured" }, 409);
  }

  const config = c.get("config");
  const encKey = deriveEncKey(config.token);

  await setConnector(
    fh.db,
    { ...cfg, installationId: parsed.data.installationId },
    undefined,
    encKey
  );

  return c.body(null, 204);
});
