/**
 * Connector API routes.
 *
 * Scoped mount — all routes guard against non-repo graphs with a 400.
 * GET  /connector       → { configured, config?: sans-secrets, status: { lastPollAt?, lastErrors? } }
 * PUT  /connector       → credential mode; 409 no-credential / missing-origin-remote
 * POST /connector/poll  → run pollOnce now
 * DELETE /connector     → remove config + secrets
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  getConnector,
  setConnector,
  discoverCredential,
  parseOriginRemote,
  makeTokenClient,
  pollOnce,
} from "@freehold/core";
import type { AppEnv } from "../types.js";

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
  const { deriveEncKey } = await import("@freehold/core");
  const encKey = deriveEncKey(config.token);
  await setConnector(fh.db, cfg, { webhookSecret: token }, encKey);

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

  // Retrieve stored token (credential mode: stored under "webhookSecret" key)
  const config = c.get("config");
  const { deriveEncKey, getSecret } = await import("@freehold/core");
  const encKey = deriveEncKey(config.token);
  const token = await getSecret(fh.db, fh.graphId, "webhookSecret", encKey);
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
