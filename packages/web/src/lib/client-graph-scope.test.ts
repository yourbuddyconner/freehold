/**
 * FreeholdClient — graph-scoped path prefixing.
 *
 * A client constructed with graphId rewrites /api/v1/... paths to
 * /api/v1/graphs/<id>/... for every knowledge/retrieval/governance/schema/
 * policy/log route (all routes under /api/v1/ except session, agents, and
 * openapi.json which are graph-agnostic).
 */
import { FreeholdClient } from "@freehold/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeMockFetch(status = 200, body: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe("FreeholdClient — graph-scoped path prefixing", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("without graphId, /api/v1/memories is requested as-is", async () => {
    const mock = makeMockFetch(200, { results: [] });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok" });
    await client.recentMemories();

    expect(mock).toHaveBeenCalledOnce();
    const [url] = mock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("/api/v1/memories");
  });

  it("with graphId, /api/v1/memories is rewritten to /api/v1/graphs/<id>/memories", async () => {
    const mock = makeMockFetch(200, { results: [] });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok", graphId: "g1" });
    await client.recentMemories();

    expect(mock).toHaveBeenCalledOnce();
    const [url] = mock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/^\/api\/v1\/graphs\/g1\/memories/);
  });

  it("with graphId, /api/v1/proposals is rewritten", async () => {
    const mock = makeMockFetch(200, { proposals: [] });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok", graphId: "g1" });
    await client.proposals();

    const [url] = mock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/^\/api\/v1\/graphs\/g1\/proposals/);
  });

  it("with graphId, /api/v1/recall is rewritten", async () => {
    const mock = makeMockFetch(200, { results: [] });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok", graphId: "g1" });
    await client.recall("hello");

    const [url] = mock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/^\/api\/v1\/graphs\/g1\/recall/);
  });

  it("with graphId, /api/v1/session is NOT rewritten (graph-agnostic)", async () => {
    const mock = makeMockFetch(200, {
      defaultAgent: null,
      embedder: "hash",
      port: 8710,
      owner: "test",
      graphs: [],
      defaultGraph: "main",
    });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok", graphId: "g1" });
    await client.session();

    const [url] = mock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("/api/v1/session");
  });

  it("listGraphs calls GET /api/v1/graphs", async () => {
    const mock = makeMockFetch(200, { graphs: [] });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok" });
    await client.listGraphs();

    const [url] = mock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("/api/v1/graphs");
  });

  it("registerGraph calls POST /api/v1/graphs", async () => {
    const mock = makeMockFetch(200, { id: "g2", name: "repo", kind: "repo" });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok" });
    await client.registerGraph({ name: "repo", kind: "repo" });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/graphs");
    expect(init.method).toBe("POST");
  });

  it("updateGraph calls PATCH /api/v1/graphs/:id", async () => {
    const mock = makeMockFetch(200, { id: "g1", name: "updated", kind: "memory" });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok" });
    await client.updateGraph("g1", { name: "updated" });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/graphs/g1");
    expect(init.method).toBe("PATCH");
  });

  // Registry routes are graph-agnostic — even a scoped client must not prefix them
  it("with graphId, listGraphs still calls GET /api/v1/graphs (not /api/v1/graphs/<id>/graphs)", async () => {
    const mock = makeMockFetch(200, { graphs: [] });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok", graphId: "g1" });
    await client.listGraphs();

    const [url] = mock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("/api/v1/graphs");
  });

  it("with graphId, registerGraph still calls POST /api/v1/graphs (not /api/v1/graphs/<id>/graphs)", async () => {
    const mock = makeMockFetch(200, { id: "g2", name: "repo", kind: "repo" });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok", graphId: "g1" });
    await client.registerGraph({ name: "repo", kind: "repo" });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/graphs");
    expect(init.method).toBe("POST");
  });

  it("with graphId, updateGraph still calls PATCH /api/v1/graphs/:id (not /api/v1/graphs/<id>/graphs/g2)", async () => {
    const mock = makeMockFetch(200, { id: "g2", name: "updated", kind: "memory" });
    globalThis.fetch = mock;

    const client = new FreeholdClient({ baseUrl: "", token: "tok", graphId: "g1" });
    await client.updateGraph("g2", { name: "updated" });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/graphs/g2");
    expect(init.method).toBe("PATCH");
  });
});
