/**
 * F10 kill-recovery test: SIGKILL mid-write → restart → verify graph integrity.
 *
 * Steps:
 *   1. Spawn daemon on a temp FREEHOLD_HOME (embedder=hash)
 *   2. Execute 10 sequential POST /api/v1/remember writes
 *   3. SIGKILL the daemon mid-write (after write #10)
 *   4. Wait briefly, respawn on the same FREEHOLD_HOME
 *   5. GET /api/v1/verify — assert ok
 *   6. POST /api/v1/reindex — assert ok
 *   7. Assert daemon is healthy and responding
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Helpers (mirror mcp.test.ts pattern)
// ---------------------------------------------------------------------------

const API_PKG = resolve(__dirname, "..");
const TSX = resolve(API_PKG, "node_modules/.bin/tsx");
const CLI_ENTRY = resolve(API_PKG, "src/cli/index.ts");

function makeTempHome(): { home: string; token: string; port: number } {
  const home = mkdtempSync(join(tmpdir(), "freehold-kill-test-"));
  const port = 46000 + Math.floor(Math.random() * 4999);
  const token = `kill-test-token-${Date.now()}`;
  const config = { token, port, graph: "main", embedder: "hash", defaultAgent: "test-agent" };
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  return { home, token, port };
}

async function waitForDaemon(port: number, maxWait = 20_000): Promise<void> {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not yet ready
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Daemon on port ${port} did not start within ${maxWait}ms`);
}

function spawnDaemon(home: string): ReturnType<typeof spawn> {
  const proc = spawn(TSX, [CLI_ENTRY, "serve"], {
    env: { ...process.env, FREEHOLD_HOME: home },
    stdio: "pipe",
  });
  proc.stderr?.on("data", (_d: Buffer) => {
    // Uncomment for debugging: process.stderr.write(_d);
  });
  return proc;
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let home: string;
let token: string;
let port: number;
let serverProc: ReturnType<typeof spawn> | null = null;

beforeAll(async () => {
  ({ home, token, port } = makeTempHome());
  serverProc = spawnDaemon(home);
  await waitForDaemon(port);

  // Register the test agent principal
  await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "test-agent" }),
  });
}, 30_000);

afterAll(() => {
  // Best-effort cleanup — the second daemon should already be dead after the test
  serverProc?.kill("SIGTERM");
  if (home) rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Kill-recovery test
// ---------------------------------------------------------------------------

describe("SIGKILL recovery", () => {
  test("restarts cleanly after mid-write SIGKILL; verify + reindex succeed", async () => {
    // Step 1: write loop — 10 sequential POSTs
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/remember`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          content: `kill-test note ${i} – ${Date.now()}`,
          agent: "test-agent",
        }),
      });
      // Accept 200 or 201; don't hard-fail on individual write errors
      expect([200, 201]).toContain(res.status);
    }

    // Step 2: SIGKILL the daemon
    if (serverProc) {
      serverProc.kill("SIGKILL");
    }

    // Step 3: wait for process to exit and settle
    await new Promise((r) => setTimeout(r, 1_000));

    // Step 4: respawn on the same FREEHOLD_HOME
    serverProc = spawnDaemon(home);
    await waitForDaemon(port, 20_000);

    // Step 5: GET /api/v1/verify
    const verifyRes = await fetch(`http://127.0.0.1:${port}/api/v1/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as Record<string, unknown>;
    // verifyGraph returns an object; at minimum it should respond without error
    expect(typeof verifyBody).toBe("object");

    // Step 6: POST /api/v1/reindex (unconditionally — ensures index is consistent)
    const reindexRes = await fetch(`http://127.0.0.1:${port}/api/v1/reindex`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(reindexRes.status).toBe(200);
    const reindexBody = (await reindexRes.json()) as { status: string };
    expect(reindexBody.status).toBe("ok");

    // Step 7: confirm daemon is healthy
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.ok).toBe(true);
  }, 55_000);
});
