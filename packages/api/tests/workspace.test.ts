/**
 * Workspace view contract tests: scope=all index, /graph, PATCH conflict flow.
 *
 * Runs against its own temp home (separate from api.test.ts) so the policy
 * mutations in that suite cannot leak into these assertions.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Freehold, hashEmbedder, loadConfig } from "@freehold/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

let home: string;
let app: ReturnType<typeof createApp>;
let token: string;

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(path, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

let savedNoteId: string;
let peerNoteId: string;
let pendingNodeId: string;
const wsAgent = "ws-agent";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "freehold-workspace-test-"));
  const config = loadConfig(home);
  token = config.token;
  const fh = await Freehold.open(home);
  app = createApp(fh, hashEmbedder, config);

  await req("POST", "/api/v1/agents", { name: wsAgent });
  const a = await req("POST", "/api/v1/remember", {
    agent: wsAgent,
    content: "# Workspace note\nwith a body line",
  });
  savedNoteId = (a.body as { noteId: string }).noteId;
  const b = await req("POST", "/api/v1/remember", { agent: wsAgent, content: "peer note" });
  peerNoteId = (b.body as { noteId: string }).noteId;
  await req("POST", "/api/v1/relations", {
    agent: wsAgent,
    from: savedNoteId,
    to: peerNoteId,
    edgeType: "memory/relates_to@1",
  });
  // Governed write → pending proposal, should surface in the index
  const held = await req("POST", "/api/v1/entities", {
    agent: wsAgent,
    type: "memory/Note@1",
    attributes: { title: "Pending workspace note", content: "awaiting review" },
  });
  pendingNodeId = (held.body as { nodeId: string }).nodeId;
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("Workspace views", () => {
  test("GET /api/v1/memories?scope=all — full index with derived titles and pending nodes", async () => {
    const { status, body } = await req("GET", "/api/v1/memories?scope=all");
    expect(status).toBe(200);
    const b = body as {
      results: Array<{ id: string; title: string; approval: string; terms: string[] }>;
    };
    const saved = b.results.find((r) => r.id === savedNoteId);
    expect(saved).toBeDefined();
    expect(saved?.title).toBe("Workspace note");
    expect(saved?.approval).toBe("saved");
    // Scratch notes carry the scratch classification as a term
    expect(saved?.terms).toContain("workspace/scratch@1");
    const pending = b.results.find((r) => r.id === pendingNodeId);
    expect(pending).toBeDefined();
    expect(pending?.approval).toBe("pending");
    expect(pending?.title).toBe("Pending workspace note");
  });

  test("GET /api/v1/graph — nodes and the relate edge exactly once", async () => {
    const { status, body } = await req("GET", "/api/v1/graph");
    expect(status).toBe(200);
    const b = body as {
      nodes: Array<{ id: string }>;
      edges: Array<{ from: string; to: string; type: string }>;
      truncated: boolean;
    };
    expect(b.truncated).toBe(false);
    expect(b.nodes.some((n) => n.id === savedNoteId)).toBe(true);
    expect(b.nodes.some((n) => n.id === peerNoteId)).toBe(true);
    const matches = b.edges.filter((e) => e.from === savedNoteId && e.to === peerNoteId);
    expect(matches.length).toBe(1);
    expect(matches[0].type).toBe("memory/relates_to@1");
  });

  test("PATCH /api/v1/entities/:id — owner edit of a scratch note lands saved", async () => {
    const { status, body } = await req("PATCH", `/api/v1/entities/${savedNoteId}`, {
      agent: "owner",
      type: "memory/Note@1",
      attributes: { content: "# Workspace note\nedited by the owner" },
    });
    expect(status).toBe(200);
    const b = body as { status: string; changeset: string };
    expect(b.status).toBe("saved");
    // The edit is visible through getEntity afterward
    const { body: entity } = await req("GET", `/api/v1/entities/${savedNoteId}`);
    expect((entity as { attributes?: { content?: string } }).attributes?.content).toContain(
      "edited by the owner"
    );
  });

  test("PATCH /api/v1/entities/:id — stale prior returns 409 conflict", async () => {
    const { status, body } = await req("PATCH", `/api/v1/entities/${savedNoteId}`, {
      agent: "owner",
      type: "memory/Note@1",
      attributes: { content: "conflicting edit" },
      prior: "0".repeat(64),
    });
    expect(status).toBe(409);
    expect((body as { error?: { code?: string } }).error?.code).toBe("conflict");
  });

  test("GET /api/v1/session — exposes the owner principal", async () => {
    const { status, body } = await req("GET", "/api/v1/session");
    expect(status).toBe(200);
    expect((body as { owner?: string }).owner).toBe("owner");
  });
});
