/**
 * F4 contract tests: founding loop over HTTP, auth, held shape, openapi coverage.
 *
 * All tests use hashEmbedder and a temp FREEHOLD_HOME — never the real home.
 * The Hono app is tested in-process via app.request() — no port is bound.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Freehold, hashEmbedder, loadConfig } from "@freehold/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { getOpenApiDoc } from "../src/openapi.js";

let home: string;
let app: ReturnType<typeof createApp>;
let token: string;

async function makeTestApp() {
  home = mkdtempSync(join(tmpdir(), "freehold-api-test-"));
  const config = loadConfig(home);
  token = config.token;
  const fh = await Freehold.open(home);
  app = createApp(fh, hashEmbedder, config);
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
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("GET /health", () => {
  test("returns 200 ok without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});

describe("Auth middleware", () => {
  test("returns 401 with error.code=auth on missing token", async () => {
    const res = await app.request("/api/v1/proposals", {
      method: "GET",
      headers: {},
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect((body as { error?: { code?: string } }).error?.code).toBe("auth");
  });

  test("returns 401 with wrong token", async () => {
    const res = await app.request("/api/v1/proposals", {
      method: "GET",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });
});

describe("Founding loop", () => {
  let agentName: string;
  let proposalHash: string | undefined;

  test("POST /api/v1/agents — register an agent", async () => {
    agentName = `test-agent-${Date.now()}`;
    const { status, body } = await req("POST", "/api/v1/agents", { name: agentName });
    expect(status).toBe(200);
    const b = body as { name: string; mcpSnippet: string };
    expect(b.name).toBe(agentName);
    expect(typeof b.mcpSnippet).toBe("string");
  });

  test("POST /api/v1/remember — scratch note is admitted (200)", async () => {
    const { status, body } = await req("POST", "/api/v1/remember", {
      agent: agentName,
      content: "I prefer morning meetings",
    });
    expect(status).toBe(200);
    const b = body as { status: string; noteId: string; changeset: string };
    expect(b.status).toBe("admitted");
    expect(typeof b.noteId).toBe("string");
    expect(typeof b.changeset).toBe("string");
  });

  test("POST /api/v1/entities — governed Preference entity write is held (no scratch classification)", async () => {
    // Preference without workspace/scratch@1 classification goes through governance → held
    const { status, body } = await req("POST", "/api/v1/entities", {
      agent: agentName,
      type: "memory/Preference@1",
      attributes: { statement: "prefers morning meetings", strength: "soft" },
      // No classification → governed by default → should be held under memory-baseline
    });
    expect(status).toBe(200);
    const b = body as { status: string; nodeId: string; changeset: string };
    // Under memory-baseline policy, Preference writes without scratch classification are held
    expect(b.status).toBe("held");
    expect(typeof b.changeset).toBe("string");
    proposalHash = b.changeset;
  });

  test("GET /api/v1/proposals — proposals array contains the held entity proposal", async () => {
    const { status, body } = await req("GET", "/api/v1/proposals");
    expect(status).toBe(200);
    const b = body as { proposals: Array<{ hash: string; summary: string; rules: string[] }> };
    expect(Array.isArray(b.proposals)).toBe(true);
    expect(b.proposals.length).toBeGreaterThan(0);
    // proposalHash was set from the changeset of the held write above
    const found = b.proposals.find((p) => p.hash === proposalHash);
    expect(found).toBeDefined();
    expect(typeof found?.hash).toBe("string");
  });

  test("POST /api/v1/proposals/:hash/approve — approve the held Preference proposal", async () => {
    // proposalHash is always defined because the preceding entity test asserts status=held
    const { status, body } = await req("POST", `/api/v1/proposals/${proposalHash}/approve`);
    expect(status).toBe(200);
    const b = body as { status: string };
    expect(b.status === "admitted" || b.status === "still-unmet").toBe(true);
  });

  test("GET /api/v1/recall — returns results array", async () => {
    const { status, body } = await req("GET", "/api/v1/recall?q=morning+meetings");
    expect(status).toBe(200);
    const b = body as { results: unknown[] };
    expect(Array.isArray(b.results)).toBe(true);
  });

  test("GET /api/v1/verify — returns ok:true on a fresh valid graph", async () => {
    const { status, body } = await req("GET", "/api/v1/verify");
    expect(status).toBe(200);
    const b = body as { ok: boolean };
    expect(b.ok).toBe(true);
  });
});

describe("held shape is 200, not an error", () => {
  test("POST /api/v1/entities returns 200 whether admitted or held", async () => {
    const agentName2 = `held-test-agent-${Date.now()}`;
    await req("POST", "/api/v1/agents", { name: agentName2 });

    const { status, body } = await req("POST", "/api/v1/entities", {
      agent: agentName2,
      type: "memory/Preference@1",
      attributes: { statement: "prefers tea", strength: "soft" },
    });
    expect(status).toBe(200);
    const b = body as { status: string };
    expect(b.status === "admitted" || b.status === "held").toBe(true);
  });
});

describe("GET /api/v1/schema", () => {
  test("returns entityTypes, edgeTypes, terms arrays", async () => {
    const { status, body } = await req("GET", "/api/v1/schema");
    expect(status).toBe(200);
    const b = body as { entityTypes: unknown[]; edgeTypes: unknown[]; terms: unknown[] };
    expect(Array.isArray(b.entityTypes)).toBe(true);
    expect(Array.isArray(b.edgeTypes)).toBe(true);
    expect(Array.isArray(b.terms)).toBe(true);
  });
});

describe("OpenAPI document coverage", () => {
  test("openapi.json contains every required route path", () => {
    const doc = getOpenApiDoc() as { paths: Record<string, unknown> };
    const paths = Object.keys(doc.paths);

    const required = [
      "/health",
      "/api/v1/remember",
      "/api/v1/entities",
      "/api/v1/entities/{id}",
      "/api/v1/entities/{id}/traverse",
      "/api/v1/relations",
      "/api/v1/classifications",
      "/api/v1/documents",
      "/api/v1/recall",
      "/api/v1/proposals",
      "/api/v1/proposals/{hash}/approve",
      "/api/v1/proposals/{hash}/reject",
      "/api/v1/verify",
      "/api/v1/reindex",
      "/api/v1/principals",
      "/api/v1/agents",
      "/api/v1/schema",
      "/api/v1/schema/proposals",
      "/api/v1/schema/install",
      "/api/v1/policy",
      "/api/v1/log",
    ];

    for (const p of required) {
      expect(paths).toContain(p);
    }
  });

  test("openapi.json is valid OpenAPI 3.1 object with info and servers", () => {
    const doc = getOpenApiDoc() as {
      openapi: string;
      info: { title: string; version: string };
      servers: Array<{ url: string }>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(typeof doc.info.title).toBe("string");
    expect(typeof doc.info.version).toBe("string");
    expect(doc.servers.length).toBeGreaterThan(0);
  });

  test("mutating routes have requestBody schemas defined", () => {
    const doc = getOpenApiDoc() as {
      paths: Record<
        string,
        Record<
          string,
          {
            requestBody?: { content?: { "application/json"?: { schema?: unknown } } };
          }
        >
      >;
    };

    const mutatingRoutes: Array<[string, string]> = [
      ["post", "/api/v1/remember"],
      ["post", "/api/v1/entities"],
      ["patch", "/api/v1/entities/{id}"],
      ["post", "/api/v1/relations"],
      ["post", "/api/v1/classifications"],
      ["post", "/api/v1/documents"],
      ["post", "/api/v1/agents"],
      ["post", "/api/v1/schema/proposals"],
      ["post", "/api/v1/schema/install"],
    ];

    for (const [method, path] of mutatingRoutes) {
      const op = doc.paths[path]?.[method];
      expect(op, `Missing operation ${method.toUpperCase()} ${path}`).toBeDefined();
      const schema = op?.requestBody?.content?.["application/json"]?.schema;
      expect(
        schema,
        `Missing requestBody schema for ${method.toUpperCase()} ${path}`
      ).toBeDefined();
    }
  });

  test("typed response schemas exist for key routes", () => {
    const doc = getOpenApiDoc() as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses?: Record<string, { content?: { "application/json"?: { schema?: unknown } } }>;
          }
        >
      >;
    };

    const typedRoutes: Array<[string, string]> = [
      ["post", "/api/v1/remember"],
      ["post", "/api/v1/entities"],
      ["get", "/api/v1/proposals"],
      ["get", "/api/v1/recall"],
      ["get", "/api/v1/verify"],
      ["get", "/api/v1/schema"],
    ];

    for (const [method, path] of typedRoutes) {
      const op = doc.paths[path]?.[method];
      expect(op, `Missing operation ${method.toUpperCase()} ${path}`).toBeDefined();
      const schema = op?.responses?.["200"]?.content?.["application/json"]?.schema;
      expect(
        schema,
        `Missing 200 response schema for ${method.toUpperCase()} ${path}`
      ).toBeDefined();
    }
  });
});

describe("POST /api/v1/policy", () => {
  test("returns 400 on non-JSON body", async () => {
    const res = await app.request("/api/v1/policy", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${token}`,
      },
      body: "not json !!",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as { error?: { code?: string } }).error?.code).toBe("validation");
  });
});

describe("POST /api/v1/policy — real flow", () => {
  const newPolicyYaml = `name: custom-test-policy
rules:
  - name: scratch-is-free
    when:
      all_ops_match:
        region: workspace/scratch@1
    allow: true
`;

  let policyHash: string | undefined;

  test("POST /policy returns held with a real changeset hash", async () => {
    const { status, body } = await req("POST", "/api/v1/policy", {
      policy_yaml: newPolicyYaml,
    });
    expect(status).toBe(200);
    const b = body as { status: string; hash: string };
    expect(b.status).toBe("held");
    // Real changeset hash from allod (not a synthetic sha256: prefix)
    expect(typeof b.hash).toBe("string");
    expect(b.hash.length).toBeGreaterThan(0);
    policyHash = b.hash;
  });

  test("GET /proposals contains the policy proposal with isSchemaProposal true", async () => {
    if (!policyHash) return;
    const { status, body } = await req("GET", "/api/v1/proposals");
    expect(status).toBe(200);
    const b = body as { proposals: Array<{ hash: string; isSchemaProposal: boolean }> };
    const policyProposal = b.proposals.find((p) => p.hash === policyHash);
    expect(policyProposal).toBeDefined();
    expect(policyProposal?.isSchemaProposal).toBe(true);
  });

  test("approve the policy proposal and verify GET /policy reflects new name", async () => {
    if (!policyHash) return;
    const { status: approveStatus } = await req("POST", `/api/v1/proposals/${policyHash}/approve`);
    expect(approveStatus).toBe(200);

    const { status, body } = await req("GET", "/api/v1/policy");
    expect(status).toBe(200);
    const b = body as { name: string; definition?: string };
    // After approval the new policy name should be active
    expect(b.name).toBe("custom-test-policy");
  });
});

describe("GET / — web console serving", () => {
  test("returns HTML when dist/index.html is missing (placeholder fallback)", async () => {
    // The dist doesn't exist in test environment — should get the fallback HTML
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<html");
    expect(text).toContain("Freehold");
  });

  test("fallback HTML does not contain the bearer token", async () => {
    const res = await app.request("/");
    const text = await res.text();
    // The bearer token must not leak into placeholder HTML
    expect(text).not.toContain(token);
  });
});

describe("SPA catch-all routing", () => {
  test("GET /memory returns HTML shell (not 404) when dist is absent", async () => {
    const res = await app.request("/memory");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<html");
  });

  test("GET /settings returns HTML shell (not 404) when dist is absent", async () => {
    const res = await app.request("/settings");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<html");
  });

  test("unknown /api/* path still returns 404", async () => {
    const res = await app.request("/api/v1/does-not-exist", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("Static asset security and caching", () => {
  // Hono normalises `..` segments before routing, so /assets/../../etc/passwd
  // is delivered to the handler as /etc/passwd — it cannot reach the assets
  // handler at all (falls through to the SPA catch-all which returns HTML, not
  // the file). The containment check in the assets handler defends against any
  // future case where a raw traversal path reaches it directly.
  test("path traversal with encoded segments returns 404", async () => {
    const res = await app.request("/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd");
    expect(res.status).toBe(404);
  });

  test("valid /assets/* path that does not exist returns 404", async () => {
    const res = await app.request("/assets/nonexistent-file.js");
    expect(res.status).toBe(404);
  });

  test("traversal-normalised path does not return file contents", async () => {
    // Hono normalises /assets/../../../etc/passwd → /etc/passwd which hits the
    // SPA catch-all and returns HTML, not the file.
    const res = await app.request("/assets/../../../etc/passwd");
    expect(res.status).toBe(200); // catch-all serves SPA HTML, not the file
    const text = await res.text();
    expect(text).toContain("<html"); // HTML shell, not /etc/passwd contents
    expect(text).not.toContain("root:"); // definitely not /etc/passwd
  });
});

describe("OpenAPI drift: committed openapi.json must match getOpenApiDoc() output", () => {
  test("openapi.json on disk equals getOpenApiDoc() — run 'pnpm openapi' if this fails", () => {
    // Resolve relative to the test file: tests/ → packages/api/
    const committedPath = resolve(__dirname, "../openapi.json");
    let committed: unknown;
    try {
      committed = JSON.parse(readFileSync(committedPath, "utf-8"));
    } catch {
      throw new Error(
        `Could not read ${committedPath}. Run 'pnpm --filter @freehold/api openapi' to generate it.`
      );
    }
    const generated = getOpenApiDoc();
    // Compare serialised JSON (normalises key order via JSON.stringify with stable sort)
    const committedStr = JSON.stringify(committed, Object.keys(committed as object).sort(), 2);
    const generatedStr = JSON.stringify(generated, Object.keys(generated as object).sort(), 2);
    expect(committedStr).toBe(generatedStr);
  });
});
