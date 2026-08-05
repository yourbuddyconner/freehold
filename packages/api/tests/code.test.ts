/**
 * Task 2 — Code API routes tests.
 *
 * Tests:
 *   - GET /api/v1/code/tree → 400 on memory (default) graph
 *   - GET /api/v1/code/file → 400 on memory graph
 *   - GET /api/v1/code/item/:nodeId → 400 on memory graph
 *   - GET /api/v1/code/regions → 400 on memory graph
 *   - GET /api/v1/graphs/:id/code/tree → 200 with tree on repo graph
 *   - GET /api/v1/graphs/:id/code/file?path=src/lib.rs → 200 with CodeFileView
 *   - GET /api/v1/graphs/:id/code/file?path=nonexistent → 404 with hint
 *   - GET /api/v1/graphs/:id/code/item/:nodeId → 200 with CodeItemView
 *   - GET /api/v1/graphs/:id/code/item/missing → 404
 *   - GET /api/v1/graphs/:id/code/regions → 200 with rules array
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  GraphManager,
  createGraph,
  hashEmbedder,
  loadConfig,
  syncIndex,
  approve,
  installOntology,
  describeSchema,
} from "@freehold/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function assetYaml(name: string): string {
  const url = new URL("../../core/assets/" + name, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

function stripOntologyPreamble(yaml: string): string {
  const lines = yaml.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trimStart().startsWith("#")) {
    start++;
  }
  const result: string[] = [];
  let inImports = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^imports:/.test(line)) {
      inImports = true;
      continue;
    }
    if (inImports && (line.startsWith(" ") || line.startsWith("\t") || line === "")) {
      if (line === "") inImports = false;
      continue;
    }
    inImports = false;
    result.push(line);
  }
  return result.join("\n");
}

async function commitAndApprove(
  graph: any,
  author: string,
  intent: string,
  ops: unknown[]
): Promise<{ status: "saved" | "pending"; hash: string }> {
  const raw = await graph.commit(author, intent, ops, [], true);
  if (raw && typeof raw === "object" && "Admitted" in raw) {
    return { status: "saved", hash: (raw as any).Admitted.hash };
  }
  if (raw && typeof raw === "object" && "Held" in raw) {
    const hash: string = (raw as any).Held.hash;
    const decision = await approve(graph, "owner", hash);
    expect(decision.status, `approval of '${intent}' failed`).toBe("approved");
    return { status: "pending", hash };
  }
  throw new Error(`Unexpected commit result for '${intent}': ${JSON.stringify(raw)}`);
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let home: string;
let repoDir: string;
let repoBasename: string;
let app: ReturnType<typeof createApp>;
let token: string;
let repoGraphId: string;
let manager: GraphManager;

// Node IDs from the fixture
let sfLibId: string;
let fnAId: string;

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
  // Set up home dir + manager
  home = makeTempDir("freehold-code-test-");
  const config = loadConfig(home);
  token = config.token;
  manager = await GraphManager.open(home);
  app = createApp(manager, hashEmbedder, config);

  // Create repo dir with a git repo + allod graph
  repoDir = makeTempDir("freehold-code-repo-");
  repoBasename = basename(repoDir);

  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# test");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  await createGraph(repoDir, "owner");

  // Register the repo graph through the API
  repoGraphId = `code-test-repo-${Date.now()}`;
  const { status: regStatus } = await req("POST", "/api/v1/graphs", {
    path: repoDir,
    id: repoGraphId,
    name: "Code Test Repo",
  });
  expect(regStatus, "failed to register repo graph").toBe(201);

  // Get the freehold handle from the manager (same instance the API will use)
  const fh = await manager.get(repoGraphId);

  // Install code ontology
  const codeYaml = stripOntologyPreamble(assetYaml("code-ontology.yaml"));
  const codeInstall = await installOntology(fh.graph, codeYaml);
  if (codeInstall.status === "pending" && codeInstall.hash) {
    const d = await approve(fh.graph, "owner", codeInstall.hash);
    expect(d.status).toBe("approved");
  }

  // Look up edge type refs from schema
  const schema = await describeSchema(fh.graph);
  const edgeNames: string[] = schema.edgeTypes.map((et: { name: string }) => et.name);
  const findEdge = (fragment: string): string =>
    edgeNames.find((n: string) => n === fragment || n.endsWith(`/${fragment}`)) ?? fragment;
  const declaresTypeRef = findEdge("declares");

  // Create SourceFile node
  sfLibId = crypto.randomUUID();
  await commitAndApprove(fh.graph, "owner", "Create src/lib.rs", [
    {
      create: {
        kind: "node",
        id: sfLibId,
        type: "code/SourceFile@1",
        attributes: { path: "src/lib.rs", language: "rust", blob: "git:repo#abc:src/lib.rs" },
      },
    },
  ]);

  // Create Function node
  fnAId = crypto.randomUUID();
  await commitAndApprove(fh.graph, "owner", "Create fnA", [
    {
      create: {
        kind: "node",
        id: fnAId,
        type: "code/Function@1",
        attributes: { name: "fnA", signature: "fn fnA() -> i32", span: "L1-L10" },
      },
    },
  ]);

  // Declares edge (SourceFile → Function)
  await commitAndApprove(fh.graph, "owner", "declares fnA", [
    {
      create: {
        kind: "edge",
        id: crypto.randomUUID(),
        type: `${declaresTypeRef}@1`,
        from: `node:${sfLibId}`,
        to: `node:${fnAId}`,
      },
    },
  ]);

  // Install a policy with a repo-binding path rule so code/regions has rules to return.
  // The repo: selector uses the directory basename — matching what the fixed route
  // derives via basename(fh.graphDir). Under the old graphName-based code this rule
  // would not match (graphName is the registry id, not the dir basename).
  const policyYaml = `policy: api-test-policy
version: 1
default_posture: permissive
roles:
  owner:
    - principal:owner
rules:
  - name: repo-src-rule
    select:
      substrate: git
      repo: "${repoBasename}"
      path: "src/**"
    require:
      reviewers:
        - role: owner
          quorum: 1
`;
  const policyResult = await (fh.graph as any).install_policy(policyYaml, "owner");
  if (policyResult && typeof policyResult === "object" && "Held" in policyResult) {
    const d = await approve(fh.graph, "owner", (policyResult as any).Held.hash);
    expect(d.status, "policy approval failed").toBe("approved");
  }

  // Sync PGlite index so the code view queries can find the nodes
  await syncIndex(fh, hashEmbedder);
}, 120_000);

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 400 on memory (default) graph — unscoped routes
// ---------------------------------------------------------------------------

describe("code routes on memory graph return 400", () => {
  test("GET /api/v1/code/tree → 400 with error message", async () => {
    const { status, body } = await req("GET", "/api/v1/code/tree");
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("code view is only available for repo graphs");
  });

  test("GET /api/v1/code/file?path=foo → 400", async () => {
    const { status, body } = await req("GET", "/api/v1/code/file?path=foo");
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("code view is only available for repo graphs");
  });

  test("GET /api/v1/code/item/some-id → 400", async () => {
    const { status, body } = await req("GET", "/api/v1/code/item/some-id");
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("code view is only available for repo graphs");
  });

  test("GET /api/v1/code/regions → 400", async () => {
    const { status, body } = await req("GET", "/api/v1/code/regions");
    expect(status).toBe(400);
    const b = body as { error: string };
    expect(b.error).toBe("code view is only available for repo graphs");
  });
});

// ---------------------------------------------------------------------------
// Scoped repo graph — happy path
// ---------------------------------------------------------------------------

describe("GET /api/v1/graphs/:id/code/tree on repo graph", () => {
  test("returns 200 with tree array", async () => {
    const { status, body } = await req("GET", `/api/v1/graphs/${repoGraphId}/code/tree`);
    expect(status).toBe(200);
    const b = body as { tree: unknown[] };
    expect(Array.isArray(b.tree)).toBe(true);
  });

  test("tree contains the indexed SourceFile path", async () => {
    const { body } = await req("GET", `/api/v1/graphs/${repoGraphId}/code/tree`);
    const b = body as { tree: Array<{ name: string; kind: string; children?: unknown[] }> };
    // src/lib.rs → root has "src" dir
    const srcDir = b.tree.find((n) => n.name === "src" && n.kind === "dir");
    expect(srcDir, "src dir not in tree").toBeDefined();
  });
});

describe("GET /api/v1/graphs/:id/code/file on repo graph", () => {
  test("returns 200 with CodeFileView for an indexed path", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/code/file?path=src/lib.rs`
    );
    expect(status).toBe(200);
    const b = body as { path: string; language: string; nodeId: string; items: unknown[] };
    expect(b.path).toBe("src/lib.rs");
    expect(b.language).toBe("rust");
    expect(b.nodeId).toBe(sfLibId);
    expect(Array.isArray(b.items)).toBe(true);
  });

  test("returns 404 with hint for unindexed path", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/code/file?path=nonexistent/path.rs`
    );
    expect(status).toBe(404);
    const b = body as { error: string; hint: string };
    expect(b.error).toBe("not indexed");
    expect(b.hint).toBe("run: allod git index");
  });

  test("returns 400 when path query param is missing", async () => {
    const { status } = await req("GET", `/api/v1/graphs/${repoGraphId}/code/file`);
    expect(status).toBe(400);
  });
});

describe("GET /api/v1/graphs/:id/code/item/:nodeId on repo graph", () => {
  test("returns 200 with CodeItemView for an indexed node", async () => {
    const { status, body } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/code/item/${fnAId}`
    );
    expect(status).toBe(200);
    const b = body as {
      nodeId: string;
      name: string;
      callersIn: unknown[];
      callsOut: unknown[];
    };
    expect(b.nodeId).toBe(fnAId);
    expect(b.name).toBe("fnA");
    expect(Array.isArray(b.callersIn)).toBe(true);
    expect(Array.isArray(b.callsOut)).toBe(true);
  });

  test("returns 404 for unknown nodeId", async () => {
    const { status } = await req(
      "GET",
      `/api/v1/graphs/${repoGraphId}/code/item/00000000-0000-0000-0000-000000000000`
    );
    expect(status).toBe(404);
  });
});

describe("GET /api/v1/graphs/:id/code/regions on repo graph", () => {
  test("returns 200 with rules array", async () => {
    const { status, body } = await req("GET", `/api/v1/graphs/${repoGraphId}/code/regions`);
    expect(status).toBe(200);
    const b = body as { rules: unknown[] };
    expect(Array.isArray(b.rules)).toBe(true);
  });

  test("repo-src-rule appears in regions (repo: binding resolved via dir basename)", async () => {
    // This test verifies that the route resolves repoName from basename(graphDir),
    // not from graphName (the registry id). The policy rule uses repo: "<basename>",
    // which only matches when the correct basename is passed to git_checklist.
    // Under the old graphName-based code the rule would come back empty.
    const { status, body } = await req("GET", `/api/v1/graphs/${repoGraphId}/code/regions`);
    expect(status).toBe(200);
    const b = body as { rules: Array<{ rule: string; paths: string[] }> };
    const srcRule = b.rules.find((r) => r.rule === "repo-src-rule");
    expect(srcRule, "repo-src-rule not found — repoName was not resolved from dir basename").toBeDefined();
    // src/lib.rs matches the path pattern src/**
    expect(srcRule!.paths).toContain("src/lib.rs");
  });

  test("repo-src-rule does not include unmatched paths", async () => {
    const { status, body } = await req("GET", `/api/v1/graphs/${repoGraphId}/code/regions`);
    expect(status).toBe(200);
    const b = body as { rules: Array<{ rule: string; paths: string[] }> };
    // The only indexed file is src/lib.rs — no file outside src/ exists in the fixture
    const srcRule = b.rules.find((r) => r.rule === "repo-src-rule");
    expect(srcRule).toBeDefined();
    // All returned paths should start with src/
    for (const p of srcRule!.paths) {
      expect(p.startsWith("src/"), `unexpected path outside src/: ${p}`).toBe(true);
    }
  });
});
