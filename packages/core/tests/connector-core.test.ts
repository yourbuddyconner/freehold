/**
 * Tests for connector core: github client, encrypted config store, event handler.
 *
 * No live GitHub calls — all GitHub access uses injected fetch.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeAll } from "vitest";
import { openDb } from "../src/db.js";
import type { DbHandle } from "../src/db.js";
import { createGraph } from "../src/allod.js";
import { openFreehold } from "../src/graphs.js";
import type { Freehold } from "../src/graphs.js";

import { parseOriginRemote, makeTokenClient } from "../src/connector/github.js";
import {
  getConnector,
  setConnector,
  getSecret,
  deriveEncKey,
} from "../src/connector/config.js";
import { handleConnectorEvent } from "../src/connector/events.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── parseOriginRemote tests ───────────────────────────────────────────────────

describe("parseOriginRemote", () => {
  test("parses https remote", () => {
    const result = parseOriginRemote("https://github.com/acme/widgets");
    expect(result).toEqual({ owner: "acme", repo: "widgets" });
  });

  test("parses https remote with .git suffix", () => {
    const result = parseOriginRemote("https://github.com/acme/widgets.git");
    expect(result).toEqual({ owner: "acme", repo: "widgets" });
  });

  test("parses git@ remote (SSH form)", () => {
    const result = parseOriginRemote("git@github.com:acme/widgets.git");
    expect(result).toEqual({ owner: "acme", repo: "widgets" });
  });

  test("parses git@ remote without .git suffix", () => {
    const result = parseOriginRemote("git@github.com:acme/widgets");
    expect(result).toEqual({ owner: "acme", repo: "widgets" });
  });

  test("returns null for garbage", () => {
    expect(parseOriginRemote("not-a-remote")).toBeNull();
    expect(parseOriginRemote("")).toBeNull();
    expect(parseOriginRemote("https://example.com/only-one-segment")).toBeNull();
  });

  test("returns null for non-GitHub https URL with two path segments", () => {
    expect(parseOriginRemote("https://example.com/owner/repo")).toBeNull();
    expect(parseOriginRemote("https://gitlab.com/owner/repo")).toBeNull();
  });
});

// ── makeTokenClient tests ─────────────────────────────────────────────────────

describe("makeTokenClient", () => {
  test("injects Authorization header with Bearer token", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedHeaders = Object.fromEntries(
        new Headers(init?.headers as HeadersInit).entries()
      );
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = makeTokenClient("ghp_testtoken", mockFetch as typeof fetch);
    const result = await client.rest<{ login: string }>("/user");

    expect(capturedHeaders["authorization"]).toBe("Bearer ghp_testtoken");
    expect(result.login).toBe("octocat");
  });

  test("surfaces 401 as an error", async () => {
    const mockFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    const client = makeTokenClient("bad-token", mockFetch as typeof fetch);
    let caught: Error | null = null;
    try {
      await client.rest("/user");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/401/);
    expect(caught!.message).not.toContain("bad-token"); // token must not be leaked in error message
  });

  test("uses GITHUB_API_BASE env override when set", async () => {
    let capturedUrl = "";
    const mockFetch = async (url: string): Promise<Response> => {
      capturedUrl = url;
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const origBase = process.env.GITHUB_API_BASE;
    process.env.GITHUB_API_BASE = "https://ghes.example.com/api/v3";
    try {
      const client = makeTokenClient("tok", mockFetch as typeof fetch);
      await client.rest("/repos/owner/repo");
      expect(capturedUrl).toContain("ghes.example.com");
    } finally {
      if (origBase === undefined) {
        delete process.env.GITHUB_API_BASE;
      } else {
        process.env.GITHUB_API_BASE = origBase;
      }
    }
  });
});

// ── config round-trip tests ───────────────────────────────────────────────────

describe("config round-trip", () => {
  let db: DbHandle;

  beforeAll(async () => {
    const pgDir = makeTempDir("connector-cfg-pg-");
    db = await openDb(pgDir);
  });

  test("getConnector returns null for unknown graphId", async () => {
    const result = await getConnector(db, "nonexistent-graph");
    expect(result).toBeNull();
  });

  test("setConnector and getConnector round-trip basic config", async () => {
    await setConnector(db, {
      graphId: "g1",
      mode: "credential",
      owner: "acme",
      repo: "widgets",
      pollIntervalSec: 300,
      webhooksEnabled: false,
    });

    const cfg = await getConnector(db, "g1");
    expect(cfg).not.toBeNull();
    expect(cfg!.owner).toBe("acme");
    expect(cfg!.repo).toBe("widgets");
    expect(cfg!.mode).toBe("credential");
    expect(cfg!.pollIntervalSec).toBe(300);
    expect(cfg!.webhooksEnabled).toBe(false);
  });

  test("setConnector encrypts secrets: ciphertext differs from plaintext", async () => {
    const encKey = deriveEncKey("test-daemon-token");
    await setConnector(
      db,
      {
        graphId: "g2",
        mode: "app",
        owner: "acme",
        repo: "widgets",
        pollIntervalSec: 60,
        webhooksEnabled: true,
        appId: "12345",
        appSlug: "my-app",
      },
      { pem: "-----BEGIN RSA PRIVATE KEY-----\nFAKEKEYDATA\n-----END RSA PRIVATE KEY-----" },
      encKey
    );

    const pem = await getSecret(db, "g2", "pem", encKey);
    expect(pem).toContain("FAKEKEYDATA");

    // Wrong key should fail to decrypt
    const wrongKey = deriveEncKey("wrong-token");
    await expect(getSecret(db, "g2", "pem", wrongKey)).rejects.toThrow();
  });

  test("getSecret returns null for missing secret", async () => {
    const encKey = deriveEncKey("test-daemon-token");
    await setConnector(db, {
      graphId: "g3",
      mode: "credential",
      owner: "acme",
      repo: "repo",
      pollIntervalSec: 300,
      webhooksEnabled: false,
    });
    const result = await getSecret(db, "g3", "pem", encKey);
    expect(result).toBeNull();
  });
});

// ── deriveEncKey tests ────────────────────────────────────────────────────────

describe("deriveEncKey", () => {
  test("is deterministic — same input produces same 32-byte key", () => {
    const k1 = deriveEncKey("daemon-token-abc");
    const k2 = deriveEncKey("daemon-token-abc");
    expect(k1).toBeInstanceOf(Buffer);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  test("different tokens produce different keys", () => {
    const k1 = deriveEncKey("token-a");
    const k2 = deriveEncKey("token-b");
    expect(k1.equals(k2)).toBe(false);
  });
});

// ── handleConnectorEvent tests ────────────────────────────────────────────────

describe("handleConnectorEvent", () => {
  let fh: Freehold;
  let graphDir: string;
  let pgDir: string;

  beforeAll(async () => {
    graphDir = makeTempDir("connector-events-graph-");
    pgDir = makeTempDir("connector-events-pg-");
    const db = await openDb(pgDir);
    const graph = await createGraph(graphDir, "owner");
    fh = await openFreehold({
      graphDir,
      db,
      home: makeTempDir("connector-events-home-"),
      graphName: "main",
      graphId: "main",
      kind: "repo",
    });
  });

  test("push event returns null", async () => {
    const result = await handleConnectorEvent(fh, {
      kind: "push",
      ref: "refs/heads/main",
      headSha: "abc123",
    });
    expect(result).toBeNull();
  });

  test("pr event returns null", async () => {
    const result = await handleConnectorEvent(fh, {
      kind: "pr",
      action: "opened",
      number: 42,
      headSha: "def456",
    });
    expect(result).toBeNull();
  });

  test("check event upserts to check_status and returns null", async () => {
    const result = await handleConnectorEvent(fh, {
      kind: "check",
      sha: "abc123",
      name: "CI / lint",
      status: "completed",
      conclusion: "success",
    });
    expect(result).toBeNull();

    // Verify row stored in PGlite
    const rows = await fh.db.pg.query<{ sha: string; name: string; status: string; conclusion: string | null }>(
      "SELECT sha, name, status, conclusion FROM check_status WHERE graph_id = $1 AND sha = $2 AND name = $3",
      ["main", "abc123", "CI / lint"]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].status).toBe("completed");
    expect(rows.rows[0].conclusion).toBe("success");
  });

  test("check event upsert is idempotent", async () => {
    const ev = { kind: "check" as const, sha: "sha999", name: "tests", status: "in_progress" };
    await handleConnectorEvent(fh, ev);
    // Update with conclusion
    await handleConnectorEvent(fh, { ...ev, status: "completed", conclusion: "success" });
    // Should not throw; result is null
    const r = await handleConnectorEvent(fh, { ...ev, status: "completed", conclusion: "success" });
    expect(r).toBeNull();

    // Verify final stored state reflects last update
    const rows = await fh.db.pg.query<{ status: string; conclusion: string | null }>(
      "SELECT status, conclusion FROM check_status WHERE graph_id = $1 AND sha = $2 AND name = $3",
      ["main", "sha999", "tests"]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].status).toBe("completed");
    expect(rows.rows[0].conclusion).toBe("success");
  });

  test("comment created returns created result with nodeId", async () => {
    const result = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "created",
      id: "gh-comment-1",
      body: "This looks good",
      author: "alice",
      path: "src/main.rs",
      commitSha: "abc123",
      prNumber: 42,
    });
    expect(result).not.toBeNull();
    expect(result!.written).toBe("created");
    expect(typeof result!.nodeId).toBe("string");
  });

  test("comment edited returns updated result", async () => {
    // First create
    const createResult = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "created",
      id: "gh-comment-2",
      body: "Initial comment",
      author: "bob",
    });

    // Then edit
    const editResult = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "edited",
      id: "gh-comment-2",
      body: "Edited comment",
      author: "bob",
    });
    expect(editResult!.written).toBe("updated");
    expect(editResult!.nodeId).toBe(createResult!.nodeId); // same node, not a new one
  });

  test("comment redelivered (same body) returns unchanged and does NOT append a new changeset", async () => {
    // Create
    const body = "Unchanged comment body";
    await handleConnectorEvent(fh, {
      kind: "comment",
      action: "created",
      id: "gh-comment-3",
      body,
      author: "carol",
    });

    // Get log length before re-delivery
    const { withGraph } = await import("../src/lock.js");
    const logBefore = await withGraph(fh.graph, () => {
      return (fh.graph as any).log() as unknown[];
    });
    const logLenBefore = Array.isArray(logBefore) ? logBefore.length : 0;

    // Re-deliver same comment
    const result = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "created",
      id: "gh-comment-3",
      body,
      author: "carol",
    });

    expect(result!.written).toBe("unchanged");

    // Log length must not have grown
    const logAfter = await withGraph(fh.graph, () => {
      return (fh.graph as any).log() as unknown[];
    });
    const logLenAfter = Array.isArray(logAfter) ? logAfter.length : 0;
    expect(logLenAfter).toBe(logLenBefore);
  });

  test("comment deleted returns tombstoned result", async () => {
    // Create first
    await handleConnectorEvent(fh, {
      kind: "comment",
      action: "created",
      id: "gh-comment-4",
      body: "To be deleted",
      author: "dave",
    });

    // Delete
    const result = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "deleted",
      id: "gh-comment-4",
      body: "",
      author: "dave",
    });
    expect(result!.written).toBe("tombstoned");
  });

  test("tombstone then re-ingest same id+body resurrects as updated", async () => {
    // Step 1: create comment
    const createResult = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "created",
      id: "gh-comment-resurrect",
      body: "Original body",
      author: "frank",
    });
    expect(createResult!.written).toBe("created");
    const originalNodeId = createResult!.nodeId;

    // Step 2: tombstone it
    const tombResult = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "deleted",
      id: "gh-comment-resurrect",
      body: "",
      author: "frank",
    });
    expect(tombResult!.written).toBe("tombstoned");

    // Step 3: re-ingest with same id and same body — resurrection
    const resurrectResult = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "created",
      id: "gh-comment-resurrect",
      body: "Original body",
      author: "frank",
    });
    // Node is tombstoned so it needs to be reactivated — must be "updated", not "unchanged"
    expect(resurrectResult!.written).toBe("updated");
    expect(resurrectResult!.nodeId).toBe(originalNodeId);
  });

  test("dedup across two ingests of the same comment id", async () => {
    // First ingest
    const first = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "created",
      id: "gh-comment-dedup",
      body: "Dedup test",
      author: "eve",
    });
    expect(first!.written).toBe("created");
    const firstNodeId = first!.nodeId;

    // Second ingest of same id with same body — must be unchanged, same node
    const second = await handleConnectorEvent(fh, {
      kind: "comment",
      action: "created",
      id: "gh-comment-dedup",
      body: "Dedup test",
      author: "eve",
    });
    expect(second!.written).toBe("unchanged");
    expect(second!.nodeId).toBe(firstNodeId);
  });
});
