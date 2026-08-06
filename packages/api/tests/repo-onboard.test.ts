/**
 * Repo onboarding tests:
 *   1. POST /api/v1/repos/onboard — in-process route tests
 *   2. CLI `repo add` — end-to-end against a real daemon
 *   3. Key generation round-trip — generate → resolveKey / signPayload → verify
 */

import { execFileSync, spawn } from "node:child_process";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GraphManager,
  createGraph,
  generateKeyPair,
  hashEmbedder,
  loadConfig,
  resolveKey,
  signPayload,
} from "@freehold/core";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const API_PKG = resolve(__dirname, "..");
const CLI_SRC = resolve(API_PKG, "src/cli");
const TSX = resolve(API_PKG, "node_modules/.bin/tsx");
const CLI_ENTRY = resolve(CLI_SRC, "index.ts");

function runCli(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 15_000
): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    const out = execFileSync(TSX, [CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      encoding: "utf-8",
    });
    stdout = out;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    code = e.status ?? 1;
  }
  return { code, stdout, stderr };
}

async function waitForDaemon(port: number, maxWait = 15_000): Promise<void> {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Daemon on port ${port} did not start within ${maxWait}ms`);
}

/** Create a scratch git repo with an allod graph at repoDir. */
async function makeAlloddRepo(repoDir: string): Promise<void> {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# test");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  await createGraph(repoDir, "owner");
}

// ---------------------------------------------------------------------------
// 1. POST /api/v1/repos/onboard — in-process route tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/repos/onboard", () => {
  let home: string;
  let repoDir: string;
  let app: ReturnType<typeof createApp>;
  let token: string;
  const cleanups: string[] = [];

  beforeAll(async () => {
    home = makeTempDir("freehold-onboard-route-");
    cleanups.push(home);

    repoDir = makeTempDir("freehold-onboard-repo-");
    cleanups.push(repoDir);
    await makeAlloddRepo(repoDir);

    const config = loadConfig(home);
    // Point to a nonexistent binary so git index step fails gracefully in tests
    (config as Record<string, unknown>).allodBin = "/nonexistent/allod";
    token = config.token;
    const manager = await GraphManager.open(home);
    app = createApp(manager, hashEmbedder, config);
  });

  afterAll(() => {
    for (const p of cleanups) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  async function req(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown }> {
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await app.request(path, init);
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  test("onboard registers the graph and returns step list", async () => {
    const { status, body } = await req("POST", "/api/v1/repos/onboard", {
      path: repoDir,
      noIndex: true,
    });

    expect(status).toBe(201);
    const b = body as {
      steps: Array<{ step: string; status: string }>;
      entry: { id: string; path: string; kind: string };
      keyPath: string;
      principal: string;
    };
    expect(Array.isArray(b.steps)).toBe(true);
    expect(b.steps.length).toBeGreaterThanOrEqual(3);

    // allod init is skipped (graph.yaml already exists from createGraph)
    const initStep = b.steps.find((s) => s.step === "allod init");
    expect(initStep?.status).toBe("skipped");

    // Key generation succeeds
    const keyStep = b.steps.find((s) => s.step === "generate key");
    expect(keyStep?.status).toBe("ok");

    // Graph registration succeeds
    const regStep = b.steps.find((s) => s.step === "register graph");
    expect(regStep?.status).toBe("ok");

    // Entry shape
    expect(b.entry.kind).toBe("repo");
    expect(b.entry.path).toBe(repoDir);
    expect(b.principal).toBe("owner");
    expect(b.keyPath).toBeTruthy();
    expect(existsSync(b.keyPath)).toBe(true);
  });

  test("missing path returns 400", async () => {
    const { status, body } = await req("POST", "/api/v1/repos/onboard", {});
    expect(status).toBe(400);
    expect((body as { error: string }).error).toContain("path is required");
  });

  test("already-registered path returns 400 with step list", async () => {
    // Second call on same repo — step 3 (register graph) fails with duplicate
    const { status, body } = await req("POST", "/api/v1/repos/onboard", {
      path: repoDir,
      noIndex: true,
    });
    expect(status).toBe(400);
    const b = body as { error: string; steps: unknown[] };
    expect(b.error).toBeTruthy();
    expect(Array.isArray(b.steps)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. CLI `repo add` — end-to-end against a real daemon
// ---------------------------------------------------------------------------

describe("CLI repo add (real daemon)", () => {
  let home: string;
  let repoDir: string;
  let serverProc: ReturnType<typeof spawn> | null = null;
  let port: number;
  const cleanups: string[] = [];

  beforeAll(async () => {
    home = makeTempDir("freehold-cli-repoadd-");
    cleanups.push(home);
    port = 41500 + Math.floor(Math.random() * 500);
    const token = `test-token-${Date.now()}`;
    const config = { token, port, graph: "main", embedder: "hash" };
    writeFileSync(join(home, "config.json"), JSON.stringify(config));

    repoDir = makeTempDir("freehold-cli-repoadd-git-");
    cleanups.push(repoDir);
    await makeAlloddRepo(repoDir);

    serverProc = spawn(TSX, [CLI_ENTRY, "serve"], {
      env: { ...process.env, FREEHOLD_HOME: home, FREEHOLD_EMBEDDER: "hash" },
      stdio: "pipe",
    });
    await waitForDaemon(port);
  });

  afterAll(() => {
    serverProc?.kill("SIGTERM");
    for (const p of cleanups) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  test("repo add exits 0 and prints summary", () => {
    const { code, stdout } = runCli(["repo", "add", repoDir, "--no-index"], {
      FREEHOLD_HOME: home,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Graph registered:");
    expect(stdout).toContain("principal:");
    expect(stdout).toContain("key:");
  });

  test("repo --help exits 0 and shows subcommand list", () => {
    const { code, stdout } = runCli(["repo", "--help"], { FREEHOLD_HOME: home });
    expect(code).toBe(0);
    expect(stdout).toContain("repo add");
  });

  test("repo add already-registered path exits with error", () => {
    // Try to add the same repo twice — second attempt should fail
    const { code, stderr } = runCli(["repo", "add", repoDir, "--no-index"], {
      FREEHOLD_HOME: home,
    });
    expect(code).not.toBe(0);
    // Some error output about already registered
    expect(stderr.length + repoDir.length).toBeGreaterThan(0); // non-empty
  });
});

// ---------------------------------------------------------------------------
// 3. Key generation round-trip
// ---------------------------------------------------------------------------

describe("generateKeyPair round-trip", () => {
  let keysDir: string;
  const cleanups: string[] = [];

  beforeAll(() => {
    keysDir = makeTempDir("freehold-keys-roundtrip-");
    cleanups.push(keysDir);
    process.env.ALLOD_KEYS_DIR = keysDir;
  });

  afterAll(() => {
    process.env.ALLOD_KEYS_DIR = undefined;
    for (const p of cleanups) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  test("generates key file with correct YAML fields", () => {
    const fakeGraphId = "sha256:abc123def456roundtrip";
    const keyPath = generateKeyPair(fakeGraphId, "owner");

    expect(existsSync(keyPath)).toBe(true);
    const yaml = readFileSync(keyPath, "utf-8");
    expect(yaml).toContain("name: owner");
    expect(yaml).toContain("algorithm: ed25519");
    expect(yaml).toContain("key_id: sha256:");
    expect(yaml).toContain("public:");
    expect(yaml).toContain("secret:");
  });

  test("does not overwrite existing key file", () => {
    const fakeGraphId = "sha256:abc123def456roundtrip";
    const keyPath = generateKeyPair(fakeGraphId, "owner");
    const content1 = readFileSync(keyPath, "utf-8");

    // Call again — should return same path, not overwrite
    generateKeyPair(fakeGraphId, "owner");
    const content2 = readFileSync(keyPath, "utf-8");
    expect(content1).toBe(content2);
  });

  test("generate → signPayload → cryptoVerify round-trip", async () => {
    const fakeGraphId = "sha256:roundtrip-sigverify-xyz";
    const keyPath = generateKeyPair(fakeGraphId, "reviewer");

    const resolvedKey = await resolveKey(fakeGraphId, "reviewer");
    expect(resolvedKey.backend).toBe("file");
    expect(resolvedKey.location).toBe(keyPath);

    const payload = "hello-round-trip-payload";
    const signature = await signPayload(resolvedKey, payload, fakeGraphId);

    // Format: sig:ed25519:<128 hex chars>
    expect(signature).toMatch(/^sig:ed25519:[0-9a-f]{128}$/);

    // Read the public key from the YAML and verify the signature
    const yaml = readFileSync(keyPath, "utf-8");
    const pubHexMatch = yaml.match(/^public:\s*([0-9a-f]+)$/m);
    expect(pubHexMatch).not.toBeNull();
    const pubHex = pubHexMatch?.[1];
    expect(pubHex).toHaveLength(64); // 32 bytes

    // Construct the SPKI-wrapped public key for cryptoVerify
    // ed25519 SPKI prefix: 302a300506032b6570032100 (12 bytes)
    const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
    const pubKeyDer = Buffer.concat([spkiHeader, Buffer.from(pubHex, "hex")]);
    const publicKey = createPublicKey({ key: pubKeyDer, format: "der", type: "spki" });

    const sigBytes = Buffer.from(signature.replace("sig:ed25519:", ""), "hex");
    const valid = cryptoVerify(null, Buffer.from(payload, "utf-8"), publicKey, sigBytes);
    expect(valid).toBe(true);
  });
});
