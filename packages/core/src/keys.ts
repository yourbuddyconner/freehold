/**
 * @freehold/core — TypeScript KeyBackend mirror of allod-core/src/keys.rs
 *
 * Provides key resolution and ed25519 signing backed by XDG files or macOS Keychain.
 * Never logs secrets or raw YAML content.
 */

import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { load as yamlLoad } from "js-yaml";

const execFileAsync = promisify(execFile);

// ─── graphDirComponent ────────────────────────────────────────────────────────

/**
 * Filesystem-safe directory component from a graph id.
 *
 * Strips the `sha256:` prefix if present, then maps any character
 * outside `[A-Za-z0-9._-]` to `'-'`. Mirrors allod's graph_dir_component.
 */
export function graphDirComponent(graphId: string): string {
  const stripped = graphId.startsWith("sha256:") ? graphId.slice("sha256:".length) : graphId;
  return stripped.replace(/[^A-Za-z0-9._-]/g, "-");
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResolvedKey {
  backend: "file" | "keychain";
  principal: string;
  location: string; // path or "keychain:<service>/<account>"
}

export interface KeyBackendOptions {
  repoDir?: string;       // enables the legacy .allod/keys fallback
  keychainService?: string; // default "allod"; tests override
}

interface KeyYaml {
  name: string;
  key_id: string;
  algorithm: string;
  public: string;
  secret: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the XDG keys directory: ALLOD_KEYS_DIR > XDG_DATA_HOME/allod/keys > ~/.local/share/allod/keys.
 */
function keysDir(): string {
  if (process.env.ALLOD_KEYS_DIR) {
    return process.env.ALLOD_KEYS_DIR;
  }
  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, "allod", "keys");
  }
  return join(homedir(), ".local", "share", "allod", "keys");
}

/**
 * Parse and validate a key YAML string. Throws if required fields are missing or algorithm is wrong.
 */
function parseKeyYaml(yamlStr: string, location: string): KeyYaml {
  const doc = yamlLoad(yamlStr) as Record<string, unknown>;
  if (!doc || typeof doc !== "object") {
    throw new Error(`invalid key YAML at ${location}`);
  }
  const { name, key_id, algorithm, public: pub, secret } = doc;
  if (typeof name !== "string" || typeof key_id !== "string" ||
      typeof algorithm !== "string" || typeof pub !== "string" || typeof secret !== "string") {
    throw new Error(`key YAML at ${location} is missing required fields`);
  }
  if (algorithm !== "ed25519") {
    throw new Error(`key at ${location} uses unsupported algorithm: ${algorithm}`);
  }
  return { name, key_id, algorithm, public: pub, secret };
}

/**
 * Read a key YAML file and parse it.
 */
function loadKeyFile(path: string): KeyYaml {
  const contents = readFileSync(path, "utf8");
  return parseKeyYaml(contents, path);
}

/**
 * Sign `payload` with the 32-byte ed25519 secret key (hex-encoded).
 * Returns `sig:ed25519:<hex 128>`.
 */
function signWithSecret(secretHex: string, payload: string): string {
  // PKCS8 wrap: ASN.1 header for ed25519 private key + the 32-byte seed
  const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
  const secretBytes = Buffer.from(secretHex, "hex");
  const pkcs8 = Buffer.concat([pkcs8Header, secretBytes]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const sig = cryptoSign(null, Buffer.from(payload, "utf8"), privateKey);
  return `sig:ed25519:${sig.toString("hex")}`;
}

// ─── Keychain helper (macOS) ──────────────────────────────────────────────────

/**
 * Classify whether an error from `security` is a not-found error.
 * Exit code 44 = errSecItemNotFound; all other errors should propagate.
 */
export function isKeychainNotFound(err: unknown): boolean {
  const e = err as { code?: number | string; stderr?: string };
  // execFile reports exit codes as the `code` property
  return e.code === 44 || e.code === "44";
}

/**
 * Attempt to fetch a YAML record from macOS Keychain for the given service + account.
 * Returns null if the item does not exist (exit code 44).
 * The `-w` flag output may be hex-encoded when the stored value contains newlines;
 * detect hex output and decode back to UTF-8.
 * Throws if the security binary is absent, keychain is locked, or permission is denied.
 */
async function fetchFromKeychain(service: string, account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", service,
      "-a", account,
      "-w",
    ]);
    const raw = stdout.trim();
    // Detect hex-encoded output: all hex chars and even length
    if (raw.length > 0 && raw.length % 2 === 0 && /^[0-9a-f]+$/.test(raw)) {
      return Buffer.from(raw, "hex").toString("utf8");
    }
    return raw;
  } catch (err: unknown) {
    // Only return null for not-found (exit code 44); re-throw everything else
    if (isKeychainNotFound(err)) {
      return null;
    }
    throw err;
  }
}

// ─── resolveKey ───────────────────────────────────────────────────────────────

/**
 * Locate a key for `principal` within `allodGraphId`.
 *
 * Resolution order (mirrors allod §6.4):
 *   1. macOS Keychain (darwin only)
 *   2. XDG file: $ALLOD_KEYS_DIR/<graphDirComponent>/<principal>.yaml (or XDG fallback)
 *   3. Legacy repo file: <repoDir>/.allod/keys/<principal>.yaml
 *
 * Throws with a "searched" message listing all locations tried if not found.
 */
export async function resolveKey(
  allodGraphId: string,
  principal: string,
  opts?: KeyBackendOptions,
): Promise<ResolvedKey> {
  const searched: string[] = [];

  // 1. macOS Keychain (darwin only)
  if (process.platform === "darwin") {
    const service = opts?.keychainService ?? "allod";
    const account = `${graphDirComponent(allodGraphId)}/${principal}`;
    const keychainLocation = `keychain:${service}/${account}`;
    searched.push(keychainLocation);
    const yamlStr = await fetchFromKeychain(service, account);
    if (yamlStr !== null) {
      return { backend: "keychain", principal, location: keychainLocation };
    }
  }

  // 2. XDG / ALLOD_KEYS_DIR file
  const xdgPath = join(keysDir(), graphDirComponent(allodGraphId), `${principal}.yaml`);
  searched.push(xdgPath);
  if (existsSync(xdgPath)) {
    return { backend: "file", principal, location: xdgPath };
  }

  // 3. Legacy repo fallback
  if (opts?.repoDir) {
    const legacyPath = join(opts.repoDir, ".allod", "keys", `${principal}.yaml`);
    searched.push(legacyPath);
    if (existsSync(legacyPath)) {
      return { backend: "file", principal, location: legacyPath };
    }
  }

  throw new Error(`key not found for principal '${principal}' (searched: ${searched.join(", ")})`);
}

// ─── signPayload ──────────────────────────────────────────────────────────────

/**
 * Sign `payload` using the key identified by `key`.
 * Returns `sig:ed25519:<hex 128>`.
 */
export async function signPayload(
  key: ResolvedKey,
  payload: string,
  allodGraphId: string,
  opts?: KeyBackendOptions,
): Promise<string> {
  if (key.backend === "file") {
    const kp = loadKeyFile(key.location);
    return signWithSecret(kp.secret, payload);
  }

  if (key.backend === "keychain") {
    if (process.platform !== "darwin") {
      throw new Error("keychain backend is only available on macOS");
    }
    const service = opts?.keychainService ?? "allod";
    const account = `${graphDirComponent(allodGraphId)}/${key.principal}`;
    const yamlStr = await fetchFromKeychain(service, account);
    if (yamlStr === null) {
      throw new Error(`key not found in keychain at ${key.location}`);
    }
    const kp = parseKeyYaml(yamlStr, key.location);
    return signWithSecret(kp.secret, payload);
  }

  throw new Error(`unknown backend: ${(key as ResolvedKey).backend}`);
}

// ─── publicHex ────────────────────────────────────────────────────────────────

/**
 * Return the hex-encoded public key for `key`.
 */
export async function publicHex(
  key: ResolvedKey,
  allodGraphId: string,
  opts?: KeyBackendOptions,
): Promise<string> {
  if (key.backend === "file") {
    const kp = loadKeyFile(key.location);
    return kp.public;
  }

  if (key.backend === "keychain") {
    if (process.platform !== "darwin") {
      throw new Error("keychain backend is only available on macOS");
    }
    const service = opts?.keychainService ?? "allod";
    const account = `${graphDirComponent(allodGraphId)}/${key.principal}`;
    const yamlStr = await fetchFromKeychain(service, account);
    if (yamlStr === null) {
      throw new Error(`key not found in keychain at ${key.location}`);
    }
    const kp = parseKeyYaml(yamlStr, key.location);
    return kp.public;
  }

  throw new Error(`unknown backend: ${(key as ResolvedKey).backend}`);
}
