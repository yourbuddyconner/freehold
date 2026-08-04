/**
 * F10 kill-recovery test: SIGKILL mid-write → restart → verify graph integrity.
 *
 * Steps:
 *   1. Spawn daemon on a temp FREEHOLD_HOME (embedder=hash)
 *   2. Fire 20 concurrent POST /api/v1/remember writes without awaiting
 *   3. SIGKILL the daemon 50ms later — while writes are in flight
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
const BINARY = process.env.FREEHOLD_BINARY ?? null;

function makeTempHome(): { home: string; token: string; port: number } {
  const home = mkdtempSync(join(tmpdir(), "freehold-kill-test-"));
  const port = 51000 + Math.floor(Math.random() * 4999);
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
  const [cmd, args] = BINARY ? [BINARY, ["serve"]] : [TSX, [CLI_ENTRY, "serve"]];
  const proc = spawn(cmd, args, {
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
    // Write a note BEFORE the SIGKILL — this should be durably committed and recallable after restart
    const PRE_KILL_TAG = `pre-kill-note-${Date.now()}`;
    const preKillRes = await fetch(`http://127.0.0.1:${port}/api/v1/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: PRE_KILL_TAG, agent: "test-agent" }),
    });
    const preKillBody = (await preKillRes.json()) as { status: string; noteId: string };
    expect(preKillRes.status).toBe(200);
    expect(preKillBody.status).toBe("saved");
    const preKillNoteId = preKillBody.noteId;

    // Fire a burst of writes without awaiting — SIGKILL arrives while writes are in flight
    const writeFn = (i: number) =>
      fetch(`http://127.0.0.1:${port}/api/v1/remember`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          content: `kill-test note ${i} – ${Date.now()}`,
          agent: "test-agent",
        }),
      }).catch(() => null); // writes may fail once the daemon is killed — that's expected

    // Launch 20 writes concurrently; SIGKILL fires after 50ms while writes are in flight
    const writePromises = Promise.all(Array.from({ length: 20 }, (_, i) => writeFn(i)));
    await new Promise((r) => setTimeout(r, 50));
    if (serverProc) {
      serverProc.kill("SIGKILL");
    }
    // Let the write promises settle (they may reject after the kill — that's fine)
    await writePromises.catch(() => null);

    // Wait for process to exit and settle
    await new Promise((r) => setTimeout(r, 1_000));

    // Step 4: respawn on the same FREEHOLD_HOME
    serverProc = spawnDaemon(home);
    await waitForDaemon(port, 20_000);

    // Step 5: GET /api/v1/verify — graph must be structurally valid after SIGKILL restart
    const verifyRes = await fetch(`http://127.0.0.1:${port}/api/v1/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as { ok: boolean };
    // Graph integrity must be ok after restart (any partial writes before SIGKILL are dropped)
    expect(verifyBody.ok).toBe(true);

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

    // Step 8: the pre-kill admitted write must survive restart.
    //
    // Assert via two routes:
    //   a) GET /api/v1/entities/:id — the note is findable by exact UUID (not just shape)
    //   b) GET /api/v1/log — the log length is at least 3 (genesis + agent + note)
    //
    // This is the regression guard for the Freehold.open() bug: it used to check for
    // a `.allod/log` directory that never exists, so every restart called createGraph()
    // instead of openGraph(), wiping all persisted state.
    expect(preKillNoteId).toBeDefined();

    // a) Entity lookup by exact UUID — must be found (not a 404)
    const entityRes = await fetch(`http://127.0.0.1:${port}/api/v1/entities/${preKillNoteId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(entityRes.status).toBe(200);
    const entityBody = (await entityRes.json()) as { id?: string; type?: string; error?: unknown };
    // Must not be an error — the note must survive the SIGKILL + restart cycle
    expect(entityBody.error).toBeUndefined();
    expect(entityBody.id ?? entityBody.type).toBeDefined();

    // b) Log must have at least 3 entries (genesis + agent + pre-kill note)
    const logRes = await fetch(`http://127.0.0.1:${port}/api/v1/log`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logRes.status).toBe(200);
    const logBody = (await logRes.json()) as { entries: unknown[] };
    expect(Array.isArray(logBody.entries)).toBe(true);
    expect(logBody.entries.length).toBeGreaterThanOrEqual(3);

    // c) Recall: after reindex (step 6), the pre-kill note content must be retrievable
    await new Promise((r) => setTimeout(r, 500)); // wait for index sync after reindex
    const recallRes = await fetch(
      `http://127.0.0.1:${port}/api/v1/recall?q=${encodeURIComponent(PRE_KILL_TAG)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(recallRes.status).toBe(200);
    const recallBody = (await recallRes.json()) as { results?: Array<{ id?: string }> };
    expect(Array.isArray(recallBody.results)).toBe(true);
    // The pre-kill note's id must appear in the recall results
    const found = recallBody.results?.some((r) => r.id === preKillNoteId);
    expect(found).toBe(true);
  }, 55_000);
});
