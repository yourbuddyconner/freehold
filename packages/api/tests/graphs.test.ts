/**
 * Task 5 — Graph-scoped API tests.
 *
 * Tests:
 *   - GET /api/v1/graphs lists at least the default "main" graph
 *   - POST /api/v1/graphs registers a scratch repo graph
 *   - POST /api/v1/graphs with bogus path → 400
 *   - Scoped route parity: GET /api/v1/graphs/main/memories?scope=all matches unscoped
 *   - Unknown graph id → 404
 *   - PATCH /api/v1/graphs/:id round-trips settings
 *   - DELETE /api/v1/graphs/main → 409
 *   - MCP: recall tool accepts graph param (with/without → same shape)
 *   - GET /api/v1/session includes graphs + defaultGraph
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GraphManager, createGraph, hashEmbedder, loadConfig } from "@freehold/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Create a scratch git repo with an initialised allod graph (mirrors manager.test.ts). */
async function makeRepoGraph(repoDir: string): Promise<void> {
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# test repo");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  await createGraph(repoDir, "owner");
}

// ---------------------------------------------------------------------------
// In-process app suite (no port, uses app.request())
// ---------------------------------------------------------------------------

let home: string;
let repoDir: string;
let app: ReturnType<typeof createApp>;
let token: string;

async function makeTestApp() {
  home = makeTempDir("freehold-graphs-test-");
  const config = loadConfig(home);
  token = config.token;
  const manager = await GraphManager.open(home);
  app = createApp(manager, hashEmbedder, config);
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await app.request(path, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

beforeAll(async () => {
  await makeTestApp();
  // Create a scratch repo for registration tests
  repoDir = makeTempDir("freehold-graphs-repo-");
  await makeRepoGraph(repoDir);
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Graph registry routes
// ---------------------------------------------------------------------------

describe("GET /api/v1/graphs", () => {
  test("returns 200 with graphs array containing main", async () => {
    const { status, body } = await req("GET", "/api/v1/graphs");
    expect(status).toBe(200);
    const b = body as { graphs: Array<{ id: string; kind: string }> };
    expect(Array.isArray(b.graphs)).toBe(true);
    const ids = b.graphs.map((g) => g.id);
    expect(ids).toContain("main");
  });
});

describe("POST /api/v1/graphs", () => {
  test("registers a repo graph and it appears in list", async () => {
    const { status, body } = await req("POST", "/api/v1/graphs", { path: repoDir, id: "test-repo", name: "Test Repo" });
    expect(status).toBe(201);
    const entry = body as { id: string; kind: string; name: string };
    expect(entry.id).toBe("test-repo");
    expect(entry.kind).toBe("repo");

    // Should appear in list
    const { body: listBody } = await req("GET", "/api/v1/graphs");
    const list = listBody as { graphs: Array<{ id: string }> };
    expect(list.graphs.map((g) => g.id)).toContain("test-repo");
  });

  test("returns 400 for bogus path", async () => {
    const { status, body } = await req("POST", "/api/v1/graphs", { path: "/tmp/definitely-not-a-repo-xyzzy" });
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(typeof b.error).toBe("string");
    expect(b.error.length).toBeGreaterThan(0);
  });

  test("returns 400 when path is missing", async () => {
    const { status } = await req("POST", "/api/v1/graphs", {});
    expect(status).toBe(400);
  });
});

describe("PATCH /api/v1/graphs/:id", () => {
  test("round-trips name update", async () => {
    const { status, body } = await req("PATCH", "/api/v1/graphs/main", { name: "Main Updated" });
    expect(status).toBe(200);
    const entry = body as { id: string; name: string };
    expect(entry.id).toBe("main");
    expect(entry.name).toBe("Main Updated");
  });

  test("returns 404 for unknown id", async () => {
    const { status } = await req("PATCH", "/api/v1/graphs/no-such-graph", { name: "x" });
    expect(status).toBe(404);
  });
});

describe("DELETE /api/v1/graphs/:id", () => {
  test("returns 409 for the default main graph", async () => {
    const { status } = await req("DELETE", "/api/v1/graphs/main");
    expect(status).toBe(409);
  });

  test("removes a non-default graph", async () => {
    // Register a fresh repo
    const delDir = makeTempDir("freehold-graphs-del-");
    await makeRepoGraph(delDir);
    try {
      await req("POST", "/api/v1/graphs", { path: delDir, id: "to-delete" });
      const { status } = await req("DELETE", "/api/v1/graphs/to-delete");
      expect(status).toBe(204);
      // No longer in list
      const { body } = await req("GET", "/api/v1/graphs");
      const list = body as { graphs: Array<{ id: string }> };
      expect(list.graphs.map((g) => g.id)).not.toContain("to-delete");
    } finally {
      rmSync(delDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Graph-scoped routes
// ---------------------------------------------------------------------------

describe("Scoped routes: /api/v1/graphs/:graphId/*", () => {
  test("GET /api/v1/graphs/main/memories?scope=all returns same shape as unscoped", async () => {
    const { status: s1, body: b1 } = await req("GET", "/api/v1/memories?scope=all");
    const { status: s2, body: b2 } = await req("GET", "/api/v1/graphs/main/memories?scope=all");
    expect(s1).toBe(200);
    expect(s2).toBe(200);
    // Both should have a results array
    const r1 = b1 as { results: unknown[] };
    const r2 = b2 as { results: unknown[] };
    expect(Array.isArray(r1.results)).toBe(true);
    expect(Array.isArray(r2.results)).toBe(true);
  });

  test("unknown graph id → 404", async () => {
    const { status, body } = await req("GET", "/api/v1/graphs/nonexistent-graph/memories?scope=all");
    expect(status).toBe(404);
    const b = body as { error: string };
    expect(b.error).toBe("unknown graph");
  });
});

// ---------------------------------------------------------------------------
// Session includes graphs
// ---------------------------------------------------------------------------

describe("GET /api/v1/session", () => {
  test("includes graphs array and defaultGraph field", async () => {
    const { status, body } = await req("GET", "/api/v1/session");
    expect(status).toBe(200);
    const b = body as { graphs: unknown[]; defaultGraph: string };
    expect(Array.isArray(b.graphs)).toBe(true);
    expect(b.defaultGraph).toBe("main");
  });

  test("graphs entries have id, name, kind fields", async () => {
    const { body } = await req("GET", "/api/v1/session");
    const b = body as { graphs: Array<{ id: string; name: string; kind: string }> };
    const main = b.graphs.find((g) => g.id === "main");
    expect(main).toBeDefined();
    expect(main!.name).toBeDefined();
    expect(main!.kind).toBe("memory");
  });
});

// ---------------------------------------------------------------------------
// MCP: graph param (live daemon)
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const API_PKG = resolve(__dirname, "..");
const TSX = resolve(API_PKG, "node_modules/.bin/tsx");
const CLI_ENTRY = resolve(API_PKG, "src/cli/index.ts");

function makeMcpHome(): { home: string; token: string; port: number } {
  const h = makeTempDir("freehold-graphs-mcp-");
  const port = 47100 + Math.floor(Math.random() * 1000);
  const t = `graphs-mcp-token-${Date.now()}`;
  const config = { token: t, port, graph: "main", embedder: "hash", defaultAgent: "test-agent" };
  writeFileSync(join(h, "config.json"), JSON.stringify(config));
  return { home: h, token: t, port };
}

async function waitForDaemon(port: number, maxWait = 20_000): Promise<void> {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Daemon on port ${port} did not start within ${maxWait}ms`);
}

describe("MCP: recall tool graph param", () => {
  let mcpHome: string;
  let mcpToken: string;
  let mcpPort: number;
  let serverProc: ReturnType<typeof spawn> | null = null;
  let client: Client | null = null;

  beforeAll(async () => {
    const cfg = makeMcpHome();
    mcpHome = cfg.home;
    mcpToken = cfg.token;
    mcpPort = cfg.port;

    serverProc = spawn(TSX, [CLI_ENTRY, "serve"], {
      env: { ...process.env, FREEHOLD_HOME: mcpHome },
      stdio: "pipe",
    });
    await waitForDaemon(mcpPort);


    const url = new URL(`http://127.0.0.1:${mcpPort}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
    });
    client = new Client({ name: "freehold-graphs-test", version: "0.1.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close().catch(() => {});
    if (serverProc) {
      serverProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
    if (mcpHome) rmSync(mcpHome, { recursive: true, force: true });
  });

  test("recall without graph param returns content array", async () => {
    const result = await client!.callTool({ name: "recall", arguments: { query: "test" } });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(typeof text).toBe("string");
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  test("recall with graph: 'main' returns same shape", async () => {
    const result = await client!.callTool({ name: "recall", arguments: { query: "test", graph: "main" } });
    expect(result.content).toBeDefined();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  test("recall with unknown graph returns error result (not throw)", async () => {
    const result = await client!.callTool({ name: "recall", arguments: { query: "test", graph: "no-such-graph" } });
    expect(result.content).toBeDefined();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeDefined();
  });
});
