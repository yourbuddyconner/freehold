/**
 * @freehold/core/connector — Connector config + encrypted secrets store.
 *
 * Config rows live in connector_config (plain metadata) and connector_secrets
 * (AES-256-GCM encrypted secrets, random IV per value). The encryption key is
 * derived from the daemon token via scrypt so it is never stored.
 *
 * Never logs secrets or tokens.
 */

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { DbHandle } from "../db.js";

// ── Encryption parameters ─────────────────────────────────────────────────────

// Fixed application salt — changing this invalidates all stored secrets.
const APP_SALT = Buffer.from("freehold.connector.v1.aes-256-gcm", "utf8");
// N=16384 (2^14): enough work-factor for a daemon token (not a password), within Node's memory limits.
// Node default scrypt memory limit is 32MB = N*r*128 bytes; 16384 * 8 * 128 = 16MB < 32MB.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const IV_LEN = 12;  // GCM standard

// ── Public types ──────────────────────────────────────────────────────────────

export type ConnectorMode = "credential" | "app";

export interface ConnectorConfig {
  graphId: string;
  mode: ConnectorMode;
  owner: string;
  repo: string;
  pollIntervalSec: number;
  webhooksEnabled: boolean;
  // App mode metadata (plain, not encrypted):
  appId?: string;
  appSlug?: string;
  installationId?: string;
  publicUrl?: string;
}

// ── Schema migration ──────────────────────────────────────────────────────────

/**
 * Ensure connector tables exist. Called lazily from getConnector / setConnector.
 * Idempotent (IF NOT EXISTS).
 */
async function ensureTables(db: DbHandle): Promise<void> {
  await db.pg.exec(`
    CREATE TABLE IF NOT EXISTS connector_config (
      graph_id          text PRIMARY KEY,
      mode              text NOT NULL,
      owner             text NOT NULL,
      repo              text NOT NULL,
      poll_interval     integer NOT NULL DEFAULT 300,
      webhooks_enabled  boolean NOT NULL DEFAULT false,
      app_id            text,
      app_slug          text,
      installation_id   text,
      public_url        text,
      updated_at        timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS connector_secrets (
      graph_id    text NOT NULL,
      name        text NOT NULL,
      ciphertext  bytea NOT NULL,
      iv          bytea NOT NULL,
      tag         bytea NOT NULL,
      PRIMARY KEY (graph_id, name)
    );

    CREATE TABLE IF NOT EXISTS check_status (
      graph_id    text NOT NULL,
      sha         text NOT NULL,
      name        text NOT NULL,
      status      text NOT NULL,
      conclusion  text,
      PRIMARY KEY (graph_id, sha, name)
    );

    CREATE TABLE IF NOT EXISTS connector_cursor (
      graph_id      text PRIMARY KEY,
      last_poll_at  timestamptz,
      state         jsonb NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS connector_soft_tombstone (
      graph_id    text NOT NULL,
      external_id text NOT NULL,
      node_id     text NOT NULL,
      PRIMARY KEY (graph_id, external_id)
    );
  `);

  // Schema migrations — run separately so IF NOT EXISTS works on pre-existing tables.
  await db.pg.query(`ALTER TABLE connector_config ADD COLUMN IF NOT EXISTS public_url text`);
}

// ── deriveEncKey ──────────────────────────────────────────────────────────────

/**
 * Derive a 32-byte AES key from the daemon token using scrypt with a fixed salt.
 * Deterministic: same input always produces the same key.
 */
export function deriveEncKey(daemonToken: string): Buffer {
  return scryptSync(daemonToken, APP_SALT, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }) as Buffer;
}

// ── encrypt / decrypt ─────────────────────────────────────────────────────────

function encryptSecret(plaintext: string, key: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: ct, iv, tag };
}

function decryptSecret(ciphertext: Buffer, iv: Buffer, tag: Buffer, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve the connector config for a graph. Returns null if none is configured.
 */
export async function getConnector(db: DbHandle, graphId: string): Promise<ConnectorConfig | null> {
  await ensureTables(db);

  const result = await db.pg.query<{
    mode: string;
    owner: string;
    repo: string;
    poll_interval: number;
    webhooks_enabled: boolean;
    app_id: string | null;
    app_slug: string | null;
    installation_id: string | null;
    public_url: string | null;
  }>(
    `SELECT mode, owner, repo, poll_interval, webhooks_enabled, app_id, app_slug, installation_id, public_url
     FROM connector_config WHERE graph_id = $1`,
    [graphId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const cfg: ConnectorConfig = {
    graphId,
    mode: row.mode as ConnectorMode,
    owner: row.owner,
    repo: row.repo,
    pollIntervalSec: row.poll_interval,
    webhooksEnabled: row.webhooks_enabled,
  };
  if (row.app_id) cfg.appId = row.app_id;
  if (row.app_slug) cfg.appSlug = row.app_slug;
  if (row.installation_id) cfg.installationId = row.installation_id;
  if (row.public_url) cfg.publicUrl = row.public_url;

  return cfg;
}

/**
 * Persist (upsert) a connector config and optionally store encrypted secrets.
 *
 * @param secrets - plaintext secrets to encrypt and store (only provided values written)
 * @param encKey  - AES key from deriveEncKey(); required if secrets is non-empty
 */
export async function setConnector(
  db: DbHandle,
  cfg: ConnectorConfig,
  secrets?: { pem?: string; credentialToken?: string; webhookSecret?: string; clientSecret?: string },
  encKey?: Buffer
): Promise<void> {
  await ensureTables(db);

  await db.pg.query(
    `INSERT INTO connector_config
       (graph_id, mode, owner, repo, poll_interval, webhooks_enabled, app_id, app_slug, installation_id, public_url, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (graph_id) DO UPDATE SET
       mode             = EXCLUDED.mode,
       owner            = EXCLUDED.owner,
       repo             = EXCLUDED.repo,
       poll_interval    = EXCLUDED.poll_interval,
       webhooks_enabled = EXCLUDED.webhooks_enabled,
       app_id           = EXCLUDED.app_id,
       app_slug         = EXCLUDED.app_slug,
       installation_id  = EXCLUDED.installation_id,
       public_url       = EXCLUDED.public_url,
       updated_at       = now()`,
    [
      cfg.graphId,
      cfg.mode,
      cfg.owner,
      cfg.repo,
      cfg.pollIntervalSec,
      cfg.webhooksEnabled,
      cfg.appId ?? null,
      cfg.appSlug ?? null,
      cfg.installationId ?? null,
      cfg.publicUrl ?? null,
    ]
  );

  if (secrets && encKey) {
    const entries: Array<[string, string]> = [];
    if (secrets.pem !== undefined) entries.push(["pem", secrets.pem]);
    if (secrets.credentialToken !== undefined) entries.push(["credentialToken", secrets.credentialToken]);
    if (secrets.webhookSecret !== undefined) entries.push(["webhookSecret", secrets.webhookSecret]);
    if (secrets.clientSecret !== undefined) entries.push(["clientSecret", secrets.clientSecret]);

    for (const [name, plaintext] of entries) {
      const { ciphertext, iv, tag } = encryptSecret(plaintext, encKey);
      await db.pg.query(
        `INSERT INTO connector_secrets (graph_id, name, ciphertext, iv, tag)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (graph_id, name) DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext,
           iv         = EXCLUDED.iv,
           tag        = EXCLUDED.tag`,
        [cfg.graphId, name, ciphertext, iv, tag]
      );
    }
  }
}

/**
 * Retrieve and decrypt a named secret for a graph.
 * Returns null if the secret has not been stored.
 * Throws if decryption fails (wrong key or corrupted data).
 */
export async function getSecret(
  db: DbHandle,
  graphId: string,
  name: "pem" | "credentialToken" | "webhookSecret" | "clientSecret",
  encKey: Buffer
): Promise<string | null> {
  await ensureTables(db);

  const result = await db.pg.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>(
    `SELECT ciphertext, iv, tag FROM connector_secrets WHERE graph_id = $1 AND name = $2`,
    [graphId, name]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  // PGlite returns bytea as Buffer or Uint8Array
  const ct = Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(row.ciphertext);
  const iv = Buffer.isBuffer(row.iv) ? row.iv : Buffer.from(row.iv);
  const tag = Buffer.isBuffer(row.tag) ? row.tag : Buffer.from(row.tag);

  return decryptSecret(ct, iv, tag, encKey);
}
