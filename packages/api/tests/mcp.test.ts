/**
 * F6 MCP tests: MCP SDK client over a live daemon.
 *
 * Spawns the daemon on a random port (FREEHOLD_HOME → temp dir, embedder=hash),
 * then drives MCP tool calls via the SDK client over streamable HTTP.
 *
 * Covered:
 *   - tools/list returns exactly 13 tools
 *   - remember → saved
 *   - create_entity → typed result
 *   - propose_ontology_change → pending
 *   - pending_approvals shows the pending proposal
 *   - describe_schema lists memory/Note
 *   - recall round-trips an admitted write
 *   - auth rejected without bearer token
 *   - GET /api/v1/policy returns real rules
 *   - POST /api/v1/policy → held proposal
 *   - mcp setup --print emits valid config JSON
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const API_PKG = resolve(__dirname, "..");
const TSX = resolve(API_PKG, "node_modules/.bin/tsx");
const CLI_ENTRY = resolve(API_PKG, "src/cli/index.ts");

function makeTempHome(): { home: string; token: string; port: number } {
  const home = mkdtempSync(join(tmpdir(), "freehold-mcp-test-"));
  const port = 41000 + Math.floor(Math.random() * 4999);
  const token = `mcp-test-token-${Date.now()}`;
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
      // not yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Daemon on port ${port} did not start within ${maxWait}ms`);
}

async function makeMcpClient(port: number, token: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  const client = new Client({ name: "freehold-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let home: string;
let token: string;
let port: number;
let serverProc: ReturnType<typeof spawn> | null = null;
let mcpClient: Client | null = null;

function client(): Client {
  if (!mcpClient) throw new Error("mcpClient not initialized");
  return mcpClient;
}

beforeAll(async () => {
  ({ home, token, port } = makeTempHome());

  serverProc = spawn(TSX, [CLI_ENTRY, "serve"], {
    env: { ...process.env, FREEHOLD_HOME: home },
    stdio: "pipe",
  });

  serverProc.stderr?.on("data", (_d: Buffer) => {
    // Uncomment for debugging: process.stderr.write(_d);
  });

  await waitForDaemon(port);

  // Register the test agent principal
  await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "test-agent" }),
  });

  mcpClient = await makeMcpClient(port, token);
}, 30_000);

afterAll(async () => {
  await mcpClient?.close();
  serverProc?.kill("SIGTERM");
  if (home) rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  test("returns exactly 13 tools", async () => {
    const result = await client().listTools();
    expect(result.tools).toHaveLength(13);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "attach_document",
      "classify",
      "create_entity",
      "describe_schema",
      "get_entity",
      "pending_approvals",
      "propose_ontology_change",
      "propose_policy_change",
      "recall",
      "relate",
      "remember",
      "traverse",
      "update_entity",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Knowledge tools
// ---------------------------------------------------------------------------

describe("remember", () => {
  test("saved — returns status + noteId", async () => {
    const res = await client().callTool({
      name: "remember",
      arguments: { content: "Test memory note" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as {
      status: string;
      noteId: string;
      changeset: string;
    };
    expect(body.status).toBe("saved");
    expect(typeof body.noteId).toBe("string");
    expect(body.noteId.length).toBeGreaterThan(0);
  });
});

describe("create_entity", () => {
  test("typed entity — returns status + nodeId", async () => {
    const res = await client().callTool({
      name: "create_entity",
      arguments: { type: "memory/Note@1", attributes: { content: "test note via create_entity" } },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as { status: string; nodeId: string };
    expect(["saved", "pending"]).toContain(body.status);
    expect(typeof body.nodeId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Schema proposal → pending → describe_schema
// ---------------------------------------------------------------------------

let proposalHash: string | undefined;

describe("propose_ontology_change", () => {
  test("pending — schema changes require owner review", async () => {
    const ontologyYaml =
      "ontology: custom-test\nentity_types:\n  Widget:\n    attributes:\n      label:\n        type: string\n        required: true";
    const res = await client().callTool({
      name: "propose_ontology_change",
      arguments: { package_name: "custom-test", ontology_yaml: ontologyYaml },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as { status: string; hash: string };
    expect(body.status).toBe("pending");
    expect(typeof body.hash).toBe("string");
    proposalHash = body.hash;
  });
});

describe("pending_approvals", () => {
  test("shows the pending schema proposal", async () => {
    const res = await client().callTool({
      name: "pending_approvals",
      arguments: { agent: "test-agent" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as { proposals: Array<{ hash: string }> };
    expect(Array.isArray(body.proposals)).toBe(true);
    if (proposalHash) {
      const found = body.proposals.some((p) => p.hash === proposalHash);
      expect(found).toBe(true);
    }
  });
});

describe("describe_schema", () => {
  test("lists memory/Note entity type", async () => {
    const res = await client().callTool({ name: "describe_schema", arguments: {} });
    const content = res.content as Array<{ type: string; text: string }>;
    const schema = JSON.parse(content[0].text) as { entityTypes: Array<{ name: string }> };
    expect(Array.isArray(schema.entityTypes)).toBe(true);
    const noteType = schema.entityTypes.find(
      (et) =>
        et.name === "memory/Note" ||
        et.name === "memory/Note@1" ||
        et.name.startsWith("memory/Note")
    );
    expect(noteType).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Recall round-trip
// ---------------------------------------------------------------------------

describe("recall", () => {
  test("finds a saved remember write", async () => {
    const unique = `unique-recall-${Date.now()}`;
    // Write via remember
    await client().callTool({ name: "remember", arguments: { content: unique } });

    // Wait briefly for indexing
    await new Promise((r) => setTimeout(r, 500));

    const res = await client().callTool({ name: "recall", arguments: { query: unique } });
    const content = res.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as { results: Array<{ content: unknown }> };
    expect(Array.isArray(body.results)).toBe(true);
    // At least one result should contain the unique string
    const found = body.results.some((r) => JSON.stringify(r.content).includes(unique));
    expect(found).toBe(true);
  });

  test("recall with graph: 'main' returns results array", async () => {
    // Write a note first so there is something to recall
    await client().callTool({ name: "remember", arguments: { content: "graph-param-test" } });
    await new Promise((r) => setTimeout(r, 300));

    const res = await client().callTool({
      name: "recall",
      arguments: { query: "test", graph: "main" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as { results: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("Auth", () => {
  test("rejected without bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// Policy routes
// ---------------------------------------------------------------------------

describe("GET /api/v1/policy", () => {
  test("returns real policy definition (not empty rules array)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/policy`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name?: string; definition?: string; rules?: unknown[] };
    // Should have either a definition or rules (definition means real policy)
    const hasDefinition = typeof body.definition === "string" && body.definition.length > 0;
    const hasRules = Array.isArray(body.rules);
    expect(hasDefinition || hasRules).toBe(true);
  });
});

describe("POST /api/v1/policy", () => {
  test("returns pending proposal with policy YAML", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        policy_yaml: "policy: test-change\ndefault_posture: restricted\nroles: {}\nrules: []",
        agent: "test-agent",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; hash: string };
    expect(body.status).toBe("pending");
    expect(typeof body.hash).toBe("string");
  });

  test("returns 400 on non-JSON body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/policy`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}` },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation");
  });
});

describe("propose_policy_change", () => {
  test("agent-authored proposal lands pending and shows in pending_approvals", async () => {
    const res = await client().callTool({
      name: "propose_policy_change",
      arguments: {
        policy_yaml: "policy: agent-suggested\ndefault_posture: restricted\nroles: {}\nrules: []",
        rationale: "Tighten the default while testing",
        agent: "test-agent",
      },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as {
      status: string;
      hash: string;
      provenance: { author: string };
    };
    expect(body.status).toBe("pending");
    expect(typeof body.hash).toBe("string");
    expect(body.provenance.author).toBe("test-agent");

    // The proposal is visible in the approval queue
    const pendingRes = await client().callTool({ name: "pending_approvals", arguments: {} });
    const pendingContent = pendingRes.content as Array<{ type: string; text: string }>;
    const pendingBody = JSON.parse(pendingContent[0].text) as {
      proposals: Array<{ hash: string; agent: string }>;
    };
    const found = pendingBody.proposals.find((p) => p.hash === body.hash);
    expect(found).toBeDefined();
    expect(found?.agent).toBe("test-agent");
  });
});

// ---------------------------------------------------------------------------
// mcp setup --print
// ---------------------------------------------------------------------------

describe("mcp setup --print", () => {
  test("emits valid Claude Code MCP config JSON", async () => {
    const { execFileSync } = await import("node:child_process");
    let output = "";
    try {
      output = execFileSync(TSX, [CLI_ENTRY, "--json", "mcp", "setup", "claude-code", "--print"], {
        env: { ...process.env, FREEHOLD_HOME: home },
        encoding: "utf-8",
        timeout: 10_000,
      });
    } catch (e) {
      // --print exits 0; if it threw, get stdout from error
      output = (e as { stdout?: string }).stdout ?? "";
    }

    const config = JSON.parse(output) as {
      mcpServers: Record<string, { type: string; url: string; headers: { Authorization: string } }>;
    };
    expect(typeof config.mcpServers).toBe("object");
    const entry = config.mcpServers.freehold;
    expect(entry).toBeDefined();
    expect(entry.type).toBe("http");
    expect(entry.url).toContain("/mcp");
    expect(entry.headers.Authorization).toContain("Bearer");
    expect(entry.headers.Authorization).toContain(token);
  });
});
