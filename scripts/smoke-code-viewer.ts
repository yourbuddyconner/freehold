#!/usr/bin/env tsx
/**
 * Live smoke test for the M4 code-viewer endpoints.
 *
 * Steps:
 *   1. Create a temp FREEHOLD_HOME with known token + port.
 *   2. Create a scratch git repo; populate it with a Freehold allod graph,
 *      code ontology, SourceFile + Function nodes, declares + calls edges.
 *   3. Spawn the daemon (tsx + CLI entry) against the temp home.
 *   4. Wait for /health.
 *   5. Register the repo graph via POST /api/v1/graphs.
 *   6. GET /api/v1/graphs/:id/code/tree       → assert 200 + tree
 *   7. GET /api/v1/graphs/:id/code/file?path= → assert 200 + CodeFileView
 *   8. GET /api/v1/graphs/:id/code/item/:id   → assert 200 + CodeItemView
 *   9. GET /api/v1/graphs/:id/code/neighborhood?path= → assert 200 + {nodes,edges}
 *  10. GET /api/v1/graphs/:id/code/regions    → assert 200 + rules
 *  11. GET /api/v1/code/tree (memory graph)   → assert 400
 *  12. Kill daemon. Clean up.
 *
 * Prints a full curl-style transcript of every request/response.
 * Exits 0 on pass, 1 on any failure.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { spawn } from "node:child_process";

// ── Paths ─────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const API_PKG = join(REPO_ROOT, "packages", "api");
const CORE_PKG = join(REPO_ROOT, "packages", "core");
const TSX = join(API_PKG, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(API_PKG, "src", "cli", "index.ts");
const CORE_ASSETS = join(CORE_PKG, "assets");

// ── Transcript ────────────────────────────────────────────────────────────────

const lines: string[] = [];
function log(...args: string[]) {
  const msg = args.join(" ");
  lines.push(msg);
  process.stdout.write(msg + "\n");
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function api(
  method: string,
  url: string,
  token: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// ── Daemon helpers ────────────────────────────────────────────────────────────

async function waitForHealth(port: number, maxWait = 25_000): Promise<void> {
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

// ── Core fixture helpers (dynamic import avoids top-level await issues) ───────

function assetYaml(name: string): string {
  return readFileSync(join(CORE_ASSETS, name), "utf-8");
}

function stripOntologyPreamble(yaml: string): string {
  const ls = yaml.split("\n");
  let start = 0;
  while (start < ls.length && ls[start].trimStart().startsWith("#")) start++;
  const result: string[] = [];
  let inImports = false;
  for (let i = start; i < ls.length; i++) {
    const line = ls[i];
    if (/^imports:/.test(line)) { inImports = true; continue; }
    if (inImports && (line.startsWith(" ") || line.startsWith("\t") || line === "")) {
      if (line === "") inImports = false;
      continue;
    }
    inImports = false;
    result.push(line);
  }
  return result.join("\n");
}

async function approveIfHeld(graph: any, hash: string) {
  const { approve } = await import(join(CORE_PKG, "src", "governance.js"));
  const d = await approve(graph, "owner", hash);
  if (d.status !== "approved") throw new Error(`approve failed: ${JSON.stringify(d)}`);
}

async function commitAndApprove(graph: any, author: string, intent: string, ops: unknown[]) {
  const raw = await graph.commit(author, intent, ops, [], true);
  if (raw && typeof raw === "object") {
    if ("Admitted" in raw) return (raw as any).Admitted.hash as string;
    if ("Held" in raw) {
      const hash = (raw as any).Held.hash as string;
      await approveIfHeld(graph, hash);
      return hash;
    }
  }
  throw new Error(`Unexpected commit result for '${intent}': ${JSON.stringify(raw)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

let home = "";
let repoDir = "";
let daemonProc: ReturnType<typeof spawn> | null = null;
const PORT = 52100 + Math.floor(Math.random() * 4999);
const TOKEN = `smoke-${Date.now()}`;
const GRAPH_ID = `smoke-repo-${Date.now()}`;

async function main() {
  // ── Step 1: temp home ────────────────────────────────────────────────────
  log("=== Step 1: create temp home ===");
  home = mkdtempSync(join(tmpdir(), "freehold-smoke-"));
  const config = { token: TOKEN, port: PORT, graph: "main", embedder: "hash", defaultAgent: "smoke-agent" };
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  log(`home=${home} port=${PORT}`);

  // ── Step 2: scratch git repo + allod graph + code nodes ─────────────────
  log("\n=== Step 2: create scratch repo + code fixture ===");
  repoDir = mkdtempSync(join(tmpdir(), "freehold-smoke-repo-"));
  log(`repoDir=${repoDir}`);
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "smoke@test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# smoke");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  log("git init + commit ok");

  // Create allod graph in the repo dir
  const { createGraph } = await import(join(CORE_PKG, "src", "allod.js"));
  await createGraph(repoDir, "owner");
  log("allod graph created");

  // Open freehold to populate nodes
  const { openFreehold } = await import(join(CORE_PKG, "src", "graphs.js"));
  const { openDb } = await import(join(CORE_PKG, "src", "db.js"));
  const { syncIndex } = await import(join(CORE_PKG, "src", "indexer.js"));
  const { hashEmbedder } = await import(join(CORE_PKG, "src", "embed.js"));
  const { installOntology, describeSchema } = await import(join(CORE_PKG, "src", "schema.js"));

  // PGlite needs to live in the home dir (will be recreated by daemon in the graphs/ dir)
  // We use a separate temp for fixture setup then discard; daemon will re-open from allod log.
  const pgDir = mkdtempSync(join(tmpdir(), "freehold-smoke-pg-"));
  const db = await openDb(pgDir);
  const fh = await openFreehold({
    graphDir: repoDir,
    db,
    home: home,
    graphName: "smoke-repo",
    graphId: GRAPH_ID,
    kind: "repo",
  });

  // Install code ontology
  const codeYaml = stripOntologyPreamble(assetYaml("code-ontology.yaml"));
  const codeInstall = await installOntology(fh.graph, codeYaml);
  if (codeInstall.status === "pending" && codeInstall.hash) {
    await approveIfHeld(fh.graph, codeInstall.hash);
  }
  log("code ontology installed");

  // Get edge type refs
  const schema = await describeSchema(fh.graph);
  const edgeNames: string[] = schema.edgeTypes.map((et: { name: string }) => et.name);
  const findEdge = (frag: string) =>
    edgeNames.find((n) => n === frag || n.endsWith(`/${frag}`)) ?? frag;
  const declaresRef = findEdge("declares");
  const callsRef = findEdge("calls");

  // Create SourceFile nodes
  const sfLibId = crypto.randomUUID();
  await commitAndApprove(fh.graph, "owner", "src/lib.rs", [
    { create: { kind: "node", id: sfLibId, type: "code/SourceFile@1",
        attributes: { path: "src/lib.rs", language: "rust", blob: "git:HEAD:src/lib.rs" } } },
  ]);

  const sfUtilId = crypto.randomUUID();
  await commitAndApprove(fh.graph, "owner", "src/util.rs", [
    { create: { kind: "node", id: sfUtilId, type: "code/SourceFile@1",
        attributes: { path: "src/util.rs", language: "rust", blob: "git:HEAD:src/util.rs" } } },
  ]);

  // Function nodes
  const fnAId = crypto.randomUUID();
  await commitAndApprove(fh.graph, "owner", "fnA", [
    { create: { kind: "node", id: fnAId, type: "code/Function@1",
        attributes: { name: "fnA", signature: "fn fnA() -> i32", span: "L1-L10" } } },
  ]);
  const fnBId = crypto.randomUUID();
  await commitAndApprove(fh.graph, "owner", "fnB", [
    { create: { kind: "node", id: fnBId, type: "code/Function@1",
        attributes: { name: "fnB", signature: "fn fnB() -> bool", span: "L12-L20" } } },
  ]);

  // Declares edges
  await commitAndApprove(fh.graph, "owner", "declares fnA", [
    { create: { kind: "edge", id: crypto.randomUUID(), type: `${declaresRef}@1`,
        from: `node:${sfLibId}`, to: `node:${fnAId}` } },
  ]);
  await commitAndApprove(fh.graph, "owner", "declares fnB", [
    { create: { kind: "edge", id: crypto.randomUUID(), type: `${declaresRef}@1`,
        from: `node:${sfLibId}`, to: `node:${fnBId}` } },
  ]);
  // Calls edge
  await commitAndApprove(fh.graph, "owner", "fnA→fnB", [
    { create: { kind: "edge", id: crypto.randomUUID(), type: `${callsRef}@1`,
        from: `node:${fnAId}`, to: `node:${fnBId}` } },
  ]);

  // Install a policy with a path rule so code/regions has something to return
  const repoName = basename(repoDir);
  const policyYaml = `policy: smoke-policy
version: 1
default_posture: permissive
roles:
  owner:
    - principal:owner
rules:
  - name: smoke-src-rule
    select:
      substrate: git
      repo: "${repoName}"
      path: "src/**"
    require:
      reviewers:
        - role: owner
          quorum: 1
`;
  const policyResult = await (fh.graph as any).install_policy(policyYaml, "owner");
  if (policyResult && typeof policyResult === "object" && "Held" in policyResult) {
    await approveIfHeld(fh.graph, (policyResult as any).Held.hash);
  }
  log(`fixture populated (sfLibId=${sfLibId}, fnAId=${fnAId})`);

  // Sync the PGlite index so the daemon (which opens fresh PGlite in its own dir)
  // can serve the queries.  The daemon will open its own PGlite under home/graphs/<id>/
  // and the graphview syncs happen at registration time.  We sync here so the
  // in-process PGlite (used later for any direct assertions) is consistent.
  await syncIndex(fh, hashEmbedder);
  rmSync(pgDir, { recursive: true, force: true });
  log("fixture index synced and pg scratch cleaned");

  // ── Step 3: spawn daemon ─────────────────────────────────────────────────
  log("\n=== Step 3: spawn daemon ===");
  daemonProc = spawn(TSX, [CLI_ENTRY, "serve"], {
    env: { ...process.env, FREEHOLD_HOME: home },
    stdio: "pipe",
  });
  log(`daemon pid=${daemonProc.pid}`);

  // ── Step 4: wait for health ───────────────────────────────────────────────
  log("\n=== Step 4: wait /health ===");
  await waitForHealth(PORT);
  log("daemon ready");

  const base = `http://127.0.0.1:${PORT}`;

  // ── Step 5: register repo graph ──────────────────────────────────────────
  log("\n=== Step 5: POST /api/v1/graphs (register) ===");
  const reg = await api("POST", `${base}/api/v1/graphs`, TOKEN, {
    path: repoDir,
    id: GRAPH_ID,
    name: "Smoke Repo",
  });
  log(`POST /api/v1/graphs → ${reg.status} ${JSON.stringify(reg.body)}`);
  if (reg.status !== 201) throw new Error(`Registration failed: ${reg.status}`);

  // Give the daemon a moment to sync the index after registration
  await new Promise((r) => setTimeout(r, 2000));

  // ── Step 6: GET code/tree ────────────────────────────────────────────────
  log("\n=== Step 6: GET /api/v1/graphs/:id/code/tree ===");
  const tree = await api("GET", `${base}/api/v1/graphs/${GRAPH_ID}/code/tree`, TOKEN);
  log(`GET /code/tree → ${tree.status}`);
  log(`  body=${JSON.stringify(tree.body)}`);
  if (tree.status !== 200) throw new Error(`code/tree expected 200 got ${tree.status}`);
  const treeBody = tree.body as { tree: Array<{ name: string; kind: string }> };
  const srcDir = treeBody.tree.find((n) => n.name === "src" && n.kind === "dir");
  if (!srcDir) throw new Error(`code/tree: no 'src' dir found`);
  log(`  ✓ src dir present in tree`);

  // ── Step 7: GET code/file ────────────────────────────────────────────────
  log("\n=== Step 7: GET /api/v1/graphs/:id/code/file?path=src/lib.rs ===");
  const file = await api("GET", `${base}/api/v1/graphs/${GRAPH_ID}/code/file?path=src/lib.rs`, TOKEN);
  log(`GET /code/file?path=src/lib.rs → ${file.status}`);
  log(`  body=${JSON.stringify(file.body)}`);
  if (file.status !== 200) throw new Error(`code/file expected 200 got ${file.status}`);
  const fileBody = file.body as { path: string; language: string; nodeId: string; items: unknown[] };
  if (fileBody.path !== "src/lib.rs") throw new Error(`code/file: wrong path`);
  if (fileBody.language !== "rust") throw new Error(`code/file: wrong language`);
  if (!Array.isArray(fileBody.items)) throw new Error(`code/file: items not array`);
  log(`  ✓ path=${fileBody.path} language=${fileBody.language} items=${fileBody.items.length}`);

  // ── Step 8: GET code/item ────────────────────────────────────────────────
  log("\n=== Step 8: GET /api/v1/graphs/:id/code/item/:fnAId ===");
  const item = await api("GET", `${base}/api/v1/graphs/${GRAPH_ID}/code/item/${fnAId}`, TOKEN);
  log(`GET /code/item/${fnAId} → ${item.status}`);
  log(`  body=${JSON.stringify(item.body)}`);
  if (item.status !== 200) throw new Error(`code/item expected 200 got ${item.status}`);
  const itemBody = item.body as { nodeId: string; name: string; callersIn: unknown[]; callsOut: unknown[] };
  if (itemBody.nodeId !== fnAId) throw new Error(`code/item: wrong nodeId`);
  if (itemBody.name !== "fnA") throw new Error(`code/item: wrong name`);
  log(`  ✓ nodeId=${itemBody.nodeId} name=${itemBody.name} callsOut=${itemBody.callsOut.length}`);

  // ── Step 9: GET code/neighborhood ────────────────────────────────────────
  log("\n=== Step 9: GET /api/v1/graphs/:id/code/neighborhood?path=src/lib.rs ===");
  const nb = await api("GET", `${base}/api/v1/graphs/${GRAPH_ID}/code/neighborhood?path=src/lib.rs`, TOKEN);
  log(`GET /code/neighborhood?path=src/lib.rs → ${nb.status}`);
  log(`  body nodes=${(nb.body as any)?.nodes?.length ?? "?"} edges=${(nb.body as any)?.edges?.length ?? "?"}`);
  if (nb.status !== 200) throw new Error(`code/neighborhood expected 200 got ${nb.status}`);
  const nbBody = nb.body as { nodes: unknown[]; edges: unknown[] };
  if (!Array.isArray(nbBody.nodes)) throw new Error(`code/neighborhood: nodes not array`);
  if (!Array.isArray(nbBody.edges)) throw new Error(`code/neighborhood: edges not array`);
  log(`  ✓ ${nbBody.nodes.length} nodes ${nbBody.edges.length} edges`);

  // ── Step 10: GET code/regions ────────────────────────────────────────────
  log("\n=== Step 10: GET /api/v1/graphs/:id/code/regions ===");
  const regions = await api("GET", `${base}/api/v1/graphs/${GRAPH_ID}/code/regions`, TOKEN);
  log(`GET /code/regions → ${regions.status}`);
  log(`  body=${JSON.stringify(regions.body)}`);
  if (regions.status !== 200) throw new Error(`code/regions expected 200 got ${regions.status}`);
  const regBody = regions.body as { rules: Array<{ rule: string; paths: string[] }> };
  if (!Array.isArray(regBody.rules)) throw new Error(`code/regions: rules not array`);
  log(`  ✓ ${regBody.rules.length} rules`);

  // ── Step 11: memory graph 400 ─────────────────────────────────────────────
  log("\n=== Step 11: GET /api/v1/code/tree (memory graph → expect 400) ===");
  const mem = await api("GET", `${base}/api/v1/code/tree`, TOKEN);
  log(`GET /api/v1/code/tree (memory) → ${mem.status}`);
  log(`  body=${JSON.stringify(mem.body)}`);
  if (mem.status !== 400) throw new Error(`memory graph code/tree expected 400 got ${mem.status}`);
  log(`  ✓ memory graph correctly returns 400`);

  log("\n=== ALL CHECKS PASSED ===");
  return {
    tree: treeBody.tree,
    file: fileBody,
    item: itemBody,
    neighborhood: nbBody,
    regions: regBody,
  };
}

main()
  .then(() => {
    log("\nSmoke test PASSED");
    process.exit(0);
  })
  .catch((err) => {
    log(`\nSmoke test FAILED: ${err}`);
    process.exit(1);
  })
  .finally(() => {
    daemonProc?.kill("SIGTERM");
    if (home) rmSync(home, { recursive: true, force: true });
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });
