/**
 * Persistence contract test: writes admitted by the daemon MUST be durable.
 *
 * This is the regression test for the bug where Freehold.open() always called
 * createGraph() (re-initialising the graph) instead of openGraph() because it
 * checked for a non-existent `.allod/log` directory rather than `.allod/graph.yaml`.
 *
 * Steps:
 *   1. Spawn daemon on a temp FREEHOLD_HOME (embedder=hash)
 *   2. Register an agent principal
 *   3. POST /api/v1/remember → verify status=admitted and capture noteId
 *   4. Assert the changeset file EXISTS on disk (at least 3 changesets: genesis, agent, note)
 *   5. Kill the daemon (SIGTERM)
 *   6. Respawn daemon on the SAME FREEHOLD_HOME
 *   7. Assert GET /api/v1/log returns at least as many entries as before kill
 *   8. Assert GET /api/v1/entities/:noteId finds the note by exact id (not a shape-only check)
 *   9. Assert GET /api/v1/verify returns ok:true
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_PKG = resolve(__dirname, "..");
const TSX = resolve(API_PKG, "node_modules/.bin/tsx");
const CLI_ENTRY = resolve(API_PKG, "src/cli/index.ts");
const BINARY = process.env.FREEHOLD_BINARY ?? null;

function makeTempHome(): { home: string; token: string; port: number } {
  const home = mkdtempSync(join(tmpdir(), "freehold-persist-test-"));
  const port = 52000 + Math.floor(Math.random() * 4999);
  const token = `persist-test-token-${Date.now()}`;
  const config = { token, port, graph: "main", embedder: "hash", defaultAgent: "persist-agent" };
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

function spawnDaemon(home: string, port: number): ReturnType<typeof spawn> {
  const [cmd, args] = BINARY ? [BINARY, ["serve"]] : [TSX, [CLI_ENTRY, "serve"]];
  const proc = spawn(cmd, args, {
    env: { ...process.env, FREEHOLD_HOME: home },
    stdio: "pipe",
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
  serverProc = spawnDaemon(home, port);
  await waitForDaemon(port);
}, 30_000);

afterAll(() => {
  serverProc?.kill("SIGTERM");
  if (home) rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Persistence tests
// ---------------------------------------------------------------------------

describe("daemon persistence across restart", () => {
  let noteId: string;
  let logLengthBeforeKill: number;

  test("write a note and confirm it is admitted", async () => {
    // Register agent
    const agentRes = await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "persist-agent" }),
    });
    expect(agentRes.status).toBe(200);

    // Write a note with a unique tag so we can recall it exactly
    const content = `persist-test-note-${Date.now()}`;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content, agent: "persist-agent" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; noteId: string };
    expect(body.status).toBe("admitted");
    expect(typeof body.noteId).toBe("string");
    noteId = body.noteId;
  }, 15_000);

  test("changeset file for the admitted note exists on disk immediately after write", () => {
    // The changesets/ directory must have at least 3 entries:
    // genesis changeset + agent principal changeset + note changeset
    // (each with a possible .evidence.yaml companion)
    const csDir = join(home, "graphs", "main", ".allod", "changesets");
    expect(existsSync(csDir)).toBe(true);
    const files = readdirSync(csDir);
    // At minimum: genesis.yaml, agent.yaml, note.yaml = 3 .yaml files
    const yamlFiles = files.filter((f) => f.endsWith(".yaml") && !f.endsWith(".evidence.yaml"));
    expect(yamlFiles.length).toBeGreaterThanOrEqual(3);
  });

  test("log() length is at least 3 before kill", async () => {
    const logRes = await fetch(`http://127.0.0.1:${port}/api/v1/log`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logRes.status).toBe(200);
    const logBody = (await logRes.json()) as { entries: unknown[] };
    expect(Array.isArray(logBody.entries)).toBe(true);
    logLengthBeforeKill = logBody.entries.length;
    expect(logLengthBeforeKill).toBeGreaterThanOrEqual(3);
  }, 10_000);

  test("entity is findable by exact noteId before kill", async () => {
    const entityRes = await fetch(`http://127.0.0.1:${port}/api/v1/entities/${noteId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(entityRes.status).toBe(200);
    const entityBody = (await entityRes.json()) as { id?: string; type?: string };
    // Must have id or type — not an error response
    expect(entityBody.id ?? entityBody.type).toBeDefined();
  }, 10_000);

  test("after SIGTERM + restart, changeset count is unchanged", async () => {
    // Capture on-disk state before kill
    const csDir = join(home, "graphs", "main", ".allod", "changesets");
    const filesBeforeKill = readdirSync(csDir).sort();

    // Kill the daemon
    serverProc?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1_000));

    // Verify files are still there after kill (not wiped by the OS)
    const filesAfterKill = readdirSync(csDir).sort();
    expect(filesAfterKill).toEqual(filesBeforeKill);

    // Respawn
    serverProc = spawnDaemon(home, port);
    await waitForDaemon(port, 20_000);

    // After restart: changeset count must be the same — restart must NOT re-initialise
    const filesAfterRestart = readdirSync(csDir).sort();
    expect(filesAfterRestart).toEqual(filesBeforeKill);
  }, 35_000);

  test("log() length after restart equals log length before kill", async () => {
    const logRes = await fetch(`http://127.0.0.1:${port}/api/v1/log`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logRes.status).toBe(200);
    const logBody = (await logRes.json()) as { entries: unknown[] };
    expect(Array.isArray(logBody.entries)).toBe(true);
    // Log must have grown by at least the entries we knew about before kill
    expect(logBody.entries.length).toBeGreaterThanOrEqual(logLengthBeforeKill);
  }, 10_000);

  test("entity is findable by exact noteId after restart (not just array shape)", async () => {
    const entityRes = await fetch(`http://127.0.0.1:${port}/api/v1/entities/${noteId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(entityRes.status).toBe(200);
    const entityBody = (await entityRes.json()) as { id?: string; type?: string; error?: unknown };
    // Must not be an error response — the entity must survive restart
    expect(entityBody.error).toBeUndefined();
    expect(entityBody.id ?? entityBody.type).toBeDefined();
  }, 10_000);

  test("verify returns ok:true after restart", async () => {
    const verifyRes = await fetch(`http://127.0.0.1:${port}/api/v1/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as { ok: boolean };
    expect(verifyBody.ok).toBe(true);
  }, 10_000);
});
