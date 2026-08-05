# M4 Foundation Implementation Plan (sub-project 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freehold becomes a multi-graph daemon — a persisted graph registry with per-graph services, graph-scoped API routes with default aliases, a TypeScript KeyBackend mirror, and the new @allod/core wasm bindings wired in — so sub-projects 2-4 (code viewer, git Inbox, connector) have their substrate.

**Architecture:** `GraphManager` (packages/core) owns a PGlite `graphs` registry and lazily opens one `Freehold` handle per entry; the existing memory graph is the seeded default with unchanged behavior. PGlite index tables gain a `graph_id` column. The API mounts the existing route files twice — unscoped (default graph) and under `/api/v1/graphs/:graphId` — with a resolver middleware that sets the per-graph `freehold`/`embedder` in context. A `keys.ts` module mirrors allod's KeyBackend (XDG file + macOS Keychain via the `security` CLI) using Node's ed25519. `@allod/core` switches to the local `link:` build carrying the two-phase signing seam and git bindings.

**Tech Stack:** TypeScript, pnpm workspace, PGlite (+pgvector), Hono, wasm-bindgen (@allod/core), vitest, React + TanStack Router (web).

Spec: `docs/specs/2026-08-04-governed-review-surface-design.md` (this repo, sub-project 1 section) and `docs/superpowers/specs/2026-08-04-key-backends-design.md` (allod repo — keychain item value is the plain-keypair YAML record, per its Deviations section).

## Global Constraints

- The existing memory graph keeps EXACTLY its current behavior: same home layout (`~/.freehold/graphs/main`), same in-store keys, same unscoped API routes, same MCP defaults. Every pre-existing test passes unmodified (except where a helper signature change forces a mechanical update).
- User-facing vocabulary: write statuses are `saved`/`pending`; decide outcomes `approved`/`rejected`/`incomplete`. Never "admitted"/"held" in UI or API-facing strings (raw wasm shapes unchanged internally).
- ALL wasm graph access goes through `withGraph` (packages/core/src/lock.ts). No exceptions.
- Signatures are raw ed25519 rendered `sig:ed25519:<hex>`; the TS signer must be byte-compatible with allod's Rust signer (same secret + payload → identical signature).
- File key locations (mirror allod exactly): create/read `$ALLOD_KEYS_DIR || $XDG_DATA_HOME/allod/keys || ~/.local/share/allod/keys` + `/<graph-dir-component>/<principal>.yaml`; legacy read fallback `<repo>/.allod/keys/<principal>.yaml`. `graph_dir_component` = strip `sha256:` prefix, then map chars outside `[A-Za-z0-9._-]` to `-`.
- Keychain item: service `allod`, account `<graph-dir-component>/<principal>`, value = the plain-keypair YAML record (parse YAML, not raw bytes). macOS only; tests env-gated on `ALLOD_KEYCHAIN_TESTS=1` with a throwaway service.
- Repo graphs are the ONLY place freehold shells to `git`. No git in wasm; no policy logic in TypeScript.
- `@allod/core` moves to `link:../../../allod/crates/allod-wasm` for local dev. THIS BREAKS CI/remote installs — the final task records this loudly in the plan report and the commit message; swapping back to a release tarball URL is a pre-push step outside this plan.
- Tests: vitest; temp homes via `mkdtempSync`; hash embedder unless a test opts into more.
- Run suites with `pnpm test:unit` (or the package-scoped `pnpm --filter @freehold/{core,api} test` equivalents used today — check package.json scripts and use the existing invocation).

---

## File map

- Modify: `packages/core/package.json` (@allod/core link) — Task 1
- Modify: `packages/core/src/db.ts` (graph_id columns, graphs registry table) — Task 2
- Modify: `packages/core/src/index2.ts`/indexer + retrieval query sites (graph_id threading) — Task 2 (find the real indexer/query files: `syncIndex` + whatever db.ts exposes)
- Create: `packages/core/src/git.ts` (git shell-outs for repo graphs) — Task 3
- Create: `packages/core/src/manager.ts` (GraphManager) — Task 3
- Create: `packages/core/src/keys.ts` (TS KeyBackend) — Task 4
- Modify: `packages/api/src/app.ts`, `packages/api/src/types.ts`, new `packages/api/src/routes/graphs.ts`; `packages/api/src/mcp.ts` (graph param); `serve.ts`/CLI boot — Task 5
- Modify: `packages/web/src/components/AppShell.tsx` + `packages/client/src/client.ts` (switcher + graph-scoped client) — Task 6
- Tests: `packages/core/tests/{dbscope,manager,keys,git}.test.ts`, `packages/api/tests/graphs.test.ts`, plus a wasm-bindings smoke test — Tasks 1-6

---

### Task 1: Link local @allod/core and smoke-test the new wasm surface

**Files:**
- Modify: `packages/core/package.json` (dependency line for `@allod/core`)
- Create: `packages/core/tests/wasm-bindings.test.ts`

**Interfaces:**
- Consumes: the allod checkout at `/Users/conner/code/allod` (local main already contains the new exports; `pnpm --dir crates/allod-wasm build` produces `pkg/` + `dist/`).
- Produces: an installed `@allod/core` whose `AllodGraph` instances expose (verified by the smoke test): `commit_payload`, `commit_signed`, `decide_payload`, `decide_with_record`, `envelope_payload`, `git_checklist`, `git_satisfaction`, `git_decision_payload`, `git_decision_attach` — alongside every pre-existing export (`commit`, `decide`, `init`, `state`, `verify`, ...).

- [ ] **Step 1: Build the local wasm package**

Run: `pnpm --dir /Users/conner/code/allod/crates/allod-wasm build`
Expected: `pkg/` and `dist/` produced without error.

- [ ] **Step 2: Switch the dependency and install**

In `packages/core/package.json` replace the `@allod/core` release-URL value with `"link:../../../allod/crates/allod-wasm"` (the README's documented local-dev override — verify the relative depth from `packages/core` to the allod checkout and adjust: from `<freehold-worktree>/packages/core` the allod checkout is at `/Users/conner/code/allod`, so use an absolute `link:/Users/conner/code/allod/crates/allod-wasm` if the relative path does not resolve from the worktree location).
Run: `pnpm install`
Expected: lockfile updates, link resolves.

- [ ] **Step 3: Write the failing smoke test**

```ts
// packages/core/tests/wasm-bindings.test.ts
import { describe, expect, it } from "vitest";
import { AllodGraph } from "@allod/core";

describe("@allod/core two-phase + git bindings", () => {
  it("exposes the new exports on a live graph", async () => {
    const g = new AllodGraph([], async () => {});
    await g.init("owner", "memory");
    for (const name of [
      "commit_payload", "commit_signed",
      "decide_payload", "decide_with_record",
      "envelope_payload",
      "git_checklist", "git_satisfaction",
      "git_decision_payload", "git_decision_attach",
    ]) {
      expect(typeof (g as any)[name], name).toBe("function");
    }
  });

  it("two-phase commit round-trips with an externally supplied signature", async () => {
    // The owner key is in the doc store; extract the secret, sign the
    // payload with node crypto, and admit via commit_signed.
    const docs: Array<[string, string]> = [];
    const g = new AllodGraph([], async (pairs: Array<[string, string]>) => {
      docs.length = 0;
      docs.push(...pairs);
    });
    await g.init("owner", "memory");
    const { changeset, hash } = (await (g as any).commit_payload(
      "owner", "smoke",
      [{ create: { kind: "node", id: "n-smoke", type: "memory/Note@1",
                   attributes: { content: "hi" } } }],
    )) as any;
    const keyDoc = docs.find(([p]) => p === "keys/owner.yaml");
    expect(keyDoc).toBeDefined();
    const secretHex = /secret:\s*([0-9a-f]{64})/.exec(keyDoc![1])![1];
    const { createPrivateKey, sign } = await import("node:crypto");
    const der = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(secretHex, "hex"),
    ]);
    const sig = sign(null, Buffer.from(hash, "utf8"),
      createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
    const outcome = (await (g as any).commit_signed(
      changeset, `sig:ed25519:${sig.toString("hex")}`, [],
    )) as any;
    expect(outcome.Admitted ?? outcome.Held).toBeDefined();
  });
});
```

(Adapt the classification detail if the note is Held rather than Admitted under the memory profile — asserting one of the two is fine here; byte-level behavior is pinned upstream in allod's own suites. If the doc-store key path or persist-callback shape differs, read how existing core tests obtain docs and adapt; the REQUIREMENT is: payload built by wasm, signature produced by node:crypto only, outcome returned.)

- [ ] **Step 4: Run to verify failure, then pass** — `pnpm --filter @freehold/core test wasm-bindings` (or the repo's equivalent filter invocation) → with the OLD tarball the first test fails (missing exports); after Steps 1-2 both pass.
- [ ] **Step 5: Full suite** — run the repo's standard unit-test script → all pre-existing tests still green against the linked package.
- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/tests/wasm-bindings.test.ts
git commit -m "chore(core): link local @allod/core with two-phase seam + git bindings (LOCAL DEV ONLY — swap to release tarball before push)"
```

---

### Task 2: Graph-scoped PGlite index tables

**Files:**
- Modify: `packages/core/src/db.ts` (schema + every query helper)
- Modify: the indexer (`syncIndex` and its call sites) and retrieval query sites in packages/core — locate by grepping for the table names `objects`, `embeddings`, `graph_edges`, `node_terms`, `meta`
- Create: `packages/core/tests/dbscope.test.ts`

**Interfaces:**
- Produces: every db helper that reads/writes the five index tables takes a `graphId: string` parameter (first or options position — follow one convention consistently). `DEFAULT_GRAPH_ID = "main"` exported from db.ts. `meta` keys become per-graph (`indexed_head` scoped by graph_id column, PK `(graph_id, key)`).
- Schema changes (all `IF NOT EXISTS` / additive so existing dev DBs migrate in place):

```sql
ALTER TABLE objects     ADD COLUMN IF NOT EXISTS graph_id text NOT NULL DEFAULT 'main';
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS graph_id text NOT NULL DEFAULT 'main';
ALTER TABLE node_terms  ADD COLUMN IF NOT EXISTS graph_id text NOT NULL DEFAULT 'main';
ALTER TABLE meta        ADD COLUMN IF NOT EXISTS graph_id text NOT NULL DEFAULT 'main';
-- embeddings scopes through its FK to objects; no column needed.
CREATE INDEX IF NOT EXISTS objects_graph_idx     ON objects (graph_id);
CREATE INDEX IF NOT EXISTS graph_edges_graph_idx ON graph_edges (graph_id);
```

Primary keys: `objects.id` stays global-unique (allod node ids are UUIDs — collision across graphs is not a practical concern, and keeping the PK avoids a cascade of FK changes in embeddings). `node_terms` PK becomes `(graph_id, subject_id, term)` and `meta` PK `(graph_id, key)` — for existing DBs, recreate those two PKs guardedly (drop + add constraint inside a try/catch or a `DO $$` block; PGlite supports plain multi-statement exec — verify how db.ts executes DDL today and follow it).

- Every SELECT/INSERT/DELETE against these tables gains `graph_id = $n` / the column in the insert list. The indexer (`syncIndex`) takes the graph id from its `Freehold` handle (Task 3 gives Freehold a `graphId`; until then pass `DEFAULT_GRAPH_ID` at existing call sites so this task lands independently green).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/dbscope.test.ts — shape; use db.ts's real helper names
import { describe, expect, it, beforeEach } from "vitest";
// import the real helpers: openDb + whatever insert/query functions db.ts exports

describe("index tables are graph-scoped", () => {
  it("rows written under graph A are invisible to graph B queries", async () => {
    // open a temp-dir PGlite via openDb(mkdtemp...)
    // insert an object row with graphId "a" via the real insert helper
    // query via the real search/list helper with graphId "b" → empty
    // query with graphId "a" → the row
  });
  it("meta indexed_head is per graph", async () => {
    // set indexed_head for "a" and "b" to different values; read both back
  });
});
```

Write it against db.ts's REAL exported helpers (read the file first; the test must call the same functions the indexer/retrieval routes call, not raw SQL).

- [ ] **Step 2: Run to verify failure** (helpers don't accept graphId yet).
- [ ] **Step 3: Implement** schema + helper threading + call-site updates (pass `DEFAULT_GRAPH_ID` everywhere for now).
- [ ] **Step 4: Full core+api suite green** (behavior identical for the default graph).
- [ ] **Step 5: Commit** — `git commit -m "feat(core): graph_id scoping across PGlite index tables (default 'main')"`

---

### Task 3: GraphManager + git.ts

**Files:**
- Create: `packages/core/src/git.ts`
- Create: `packages/core/src/manager.ts`
- Modify: `packages/core/src/graphs.ts` (Freehold gains `graphId`, `kind`, and an `openAt(path)` route for repo checkouts), `packages/core/src/db.ts` (graphs registry table), `packages/core/src/index.ts` (exports)
- Create: `packages/core/tests/manager.test.ts`, `packages/core/tests/git.test.ts`

**Interfaces:**

```ts
// git.ts — child_process.execFile("git", [...], { cwd }) promisified; every
// function throws Error with stderr on failure. NO shell interpolation.
export async function originRemote(repoDir: string): Promise<string | null>; // git remote get-url origin, null if none
export async function headSha(repoDir: string, ref = "HEAD"): Promise<string>; // git rev-parse
export async function commitMeta(repoDir: string, sha: string):
  Promise<{ sha: string; author: string; email: string; timestamp: string; message: string; parents: string[] }>;
  // git show -s --format=%H%n%an%n%ae%n%aI%n%P%n%B
export async function diffTreeOps(repoDir: string, sha: string):
  Promise<Array<[verb: string, path: string]>>;
  // parents.length===0 → git diff-tree --root --no-renames --name-status -r <sha>
  // else → git diff-tree --no-renames --name-status -r <parent0> <sha>   (first-parent, two-tree form)
  // verbs are git status letters (A/M/D...) passed through as-is
export async function readDecisions(repoDir: string, sha: string): Promise<unknown[]>;
  // git notes --ref=refs/notes/allod-decisions show <sha> → parse as YAML stream
  // (multi-doc: allod appends records separated by ---; mirror allod-substrate-git's read_decisions format — inspect
  //  /Users/conner/code/allod/crates/allod-substrate-git/src/lib.rs read_decisions/append_decision before implementing)
  // missing note → []
export async function appendDecision(repoDir: string, sha: string, record: unknown): Promise<void>;
export async function pushNotes(repoDir: string, remote = "origin"): Promise<void>;
  // git push <remote> refs/notes/allod-decisions
```

```ts
// manager.ts
export interface GraphEntry {
  id: string;            // registry slug, PK ("main" for the seeded default)
  name: string;          // display name
  path: string;          // graph dir (memory: <home>/graphs/<id>; repo: the checkout root)
  kind: "memory" | "repo";
  autoPushNotes: boolean;
  embedder: "hash" | "semantic";
  allodGraphId: string;  // graph_id from .allod/graph.yaml (for key lookups)
  originRemote: string | null;
}
export class GraphManager {
  static async open(home?: string): Promise<GraphManager>;
  list(): Promise<GraphEntry[]>;
  get(id: string): Promise<Freehold>;          // lazy-open + cache; throws on unknown id
  entry(id: string): Promise<GraphEntry>;
  defaultId(): string;                          // "main"
  registerRepo(path: string, opts?: { id?: string; name?: string }): Promise<GraphEntry>;
  updateSettings(id: string, patch: Partial<Pick<GraphEntry, "name" | "autoPushNotes" | "embedder">>): Promise<GraphEntry>;
  remove(id: string): Promise<void>;            // registry row only; never deletes the checkout
  readonly db: DbHandle;                        // the single shared PGlite
}
```

Semantics:
- `open()`: opens the shared PGlite (as `Freehold.open` does today), creates the `graphs` table (`id text PK, name, path, kind, auto_push_notes bool, embedder, allod_graph_id, origin_remote`), seeds `main` (kind memory, path `<home>/graphs/main`, embedder from config) if absent. The seeded default reuses the existing `Freehold.open` machinery so behavior is unchanged.
- `get(id)`: opens the graph dir with the existing `openGraph()`; the returned `Freehold` handle carries `graphId = id` so db calls scope correctly (Task 2). One instance per id, cached; all mutation through `withGraph`.
- `registerRepo(path)`: validate `path/.allod/graph.yaml` exists and parses (error `"not an allod graph: no .allod/graph.yaml at <path>"` otherwise); read `allodGraphId` from it; capture `originRemote(path)`; derive `id` from `opts.id ?? basename(path)` (reject duplicates); install the `review` ontology package if the graph's schema lacks it (check via the wasm `describe_schema`/state for a `review/Review` type; install through the same core function `POST /schema/install` uses — find it in the schema route/core and reuse; the review ontology YAML ships in the allod repo `ontologies/review/ontology.yaml` — vendor a copy under `packages/core/assets/review-ontology.yaml` so freehold does not depend on the allod checkout at runtime); then run the indexer for this graph with the hash embedder. All wasm access via `withGraph`.
- `Freehold` handles for repo graphs: same class, `kind: "repo"` — the graph store is the checkout's `.allod/` via `openGraph(path)`.
- Serialization: `get`/`registerRepo` must be safe under concurrent calls (a simple in-flight-promise map keyed by id, same pattern as lock.ts).

- [ ] **Step 1: Write failing git.ts tests** — `packages/core/tests/git.test.ts`: build a scratch git repo in a temp dir (`git init`, config user, two commits touching different files, one merge commit), then assert: `headSha` resolves; `commitMeta` fields; `diffTreeOps` on a normal commit lists `[["A","file.txt"]]`-style entries; on the merge commit uses first-parent two-tree form; on the root commit uses `--root`; `readDecisions` on a sha with no note → `[]`; `appendDecision` then `readDecisions` round-trips a record object. (No remote needed; skip `pushNotes` coverage here — assert only that it invokes git without throwing when a local bare remote is added, or leave it to SP3's e2e.)
- [ ] **Step 2: Implement git.ts; tests green.**
- [ ] **Step 3: Write failing manager tests** — `packages/core/tests/manager.test.ts`: temp home → `GraphManager.open` seeds `main` and `get("main")` behaves like today's `Freehold.open` (write a memory via the existing flow, recall it); `registerRepo` on a temp dir WITHOUT .allod errors with the exact message; `registerRepo` on a scratch allod graph (create one via `createGraph(tempRepoDir, "owner")` then move/copy so it looks like a repo checkout — or `git init` + `createGraph` in the same dir) succeeds, entry fields populated (kind repo, allodGraphId nonempty), review ontology present afterward (describe_schema contains `review/Review`), rows indexed under the new graph id and invisible to `main` queries; `updateSettings` persists; duplicate id rejected.
- [ ] **Step 4: Implement manager.ts + graphs.ts/db.ts touches; core suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(core): GraphManager registry + per-graph Freehold handles; git shell-out module"`

---

### Task 4: TypeScript KeyBackend mirror

**Files:**
- Create: `packages/core/src/keys.ts`
- Create: `packages/core/tests/keys.test.ts`

**Interfaces:**

```ts
export function graphDirComponent(graphId: string): string; // strip sha256: prefix, then /[^A-Za-z0-9._-]/g → "-"

export interface ResolvedKey {
  backend: "file" | "keychain";
  principal: string;
  location: string;      // path or "keychain:<service>/<account>"
}
export interface KeyBackendOptions {
  repoDir?: string;       // enables the legacy .allod/keys fallback
  keychainService?: string; // default "allod"; tests override
}
export async function resolveKey(allodGraphId: string, principal: string, opts?: KeyBackendOptions): Promise<ResolvedKey>;
  // order: keychain (darwin only) → XDG file → legacy repo file; throw listing what was searched
export async function signPayload(key: ResolvedKey, payload: string, allodGraphId: string, opts?: KeyBackendOptions): Promise<string>;
  // returns "sig:ed25519:<hex>"
export async function publicHex(key: ResolvedKey, allodGraphId: string, opts?: KeyBackendOptions): Promise<string>;
```

Implementation notes:
- File path resolution mirrors allod byte-for-byte: `$ALLOD_KEYS_DIR || $XDG_DATA_HOME/allod/keys || ~/.local/share/allod/keys`, then `/<graphDirComponent(id)>/<principal>.yaml`; legacy fallback `<repoDir>/.allod/keys/<principal>.yaml`. Key YAML fields: `name`, `key_id`, `algorithm: ed25519`, `public` (hex), `secret` (hex 64 chars).
- Keychain (darwin): `execFile("security", ["find-generic-password", "-s", service, "-a", `${graphDirComponent(id)}/${principal}`, "-w"])` → stdout is the YAML record (the `-w` output may be hex-encoded when the value contains newlines — `security` prints hex in that case; detect: if stdout matches `^[0-9a-f]+$` decode hex → utf8 first). Parse YAML, use the `secret` field. Missing item (exit 44) → not resolved, fall through.
- Signing: PKCS8-wrap the 32-byte secret (`302e020100300506032b657004220420` + secret) → `createPrivateKey` → `crypto.sign(null, Buffer.from(payload, "utf8"), key)` → `sig:ed25519:<hex>`.
- Never log the secret or the YAML; error messages name locations only.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/tests/keys.test.ts — real code, adapt imports only
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { graphDirComponent, resolveKey, signPayload, publicHex } from "../src/keys.js";

// RFC 8032 test vector secret — same one allod's parity suite uses.
const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

function writeKeyYaml(dir: string, principal: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${principal}.yaml`),
    `name: ${principal}\nkey_id: x\nalgorithm: ed25519\npublic: ${PUBLIC}\nsecret: ${SECRET}\n`);
}

describe("keys.ts", () => {
  it("graphDirComponent matches allod", () => {
    expect(graphDirComponent("sha256:ab/cd:ef")).toBe("ab-cd-ef");
    expect(graphDirComponent("plain-id_1.2")).toBe("plain-id_1.2");
  });

  it("resolves XDG path, signs verifiably, falls back to legacy", async () => {
    const keysDir = mkdtempSync(join(tmpdir(), "fh-keys-"));
    process.env.ALLOD_KEYS_DIR = keysDir;
    writeKeyYaml(join(keysDir, "feed"), "alice");
    const k = await resolveKey("sha256:feed", "alice");
    expect(k.backend).toBe("file");
    const sig = await signPayload(k, "sha256:00ff", "sha256:feed");
    expect(sig).toMatch(/^sig:ed25519:[0-9a-f]{128}$/);
    // verify against the known public key with node crypto
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(PUBLIC, "hex"),
    ]);
    const ok = nodeVerify(null, Buffer.from("sha256:00ff", "utf8"),
      createPublicKey({ key: spki, format: "der", type: "spki" }),
      Buffer.from(sig.slice("sig:ed25519:".length), "hex"));
    expect(ok).toBe(true);
    expect(await publicHex(k, "sha256:feed")).toBe(PUBLIC);

    // legacy fallback
    const repo = mkdtempSync(join(tmpdir(), "fh-repo-"));
    writeKeyYaml(join(repo, ".allod", "keys"), "bob");
    const k2 = await resolveKey("sha256:feed", "bob", { repoDir: repo });
    expect(k2.location).toContain(".allod/keys/bob.yaml");

    // miss
    await expect(resolveKey("sha256:feed", "nobody")).rejects.toThrow(/searched/);
  });

  it("keychain roundtrip (env-gated)", async () => {
    if (process.platform !== "darwin" || process.env.ALLOD_KEYCHAIN_TESTS !== "1") return;
    const service = `allod-test-fh-${process.pid}`;
    const account = `${graphDirComponent("sha256:beef")}/kc`;
    const yaml = `name: kc\nkey_id: x\nalgorithm: ed25519\npublic: ${PUBLIC}\nsecret: ${SECRET}\n`;
    const { execFileSync } = await import("node:child_process");
    execFileSync("security", ["add-generic-password", "-s", service, "-a", account, "-w", yaml]);
    try {
      const k = await resolveKey("sha256:beef", "kc", { keychainService: service });
      expect(k.backend).toBe("keychain");
      const sig = await signPayload(k, "sha256:11", "sha256:beef", { keychainService: service });
      expect(sig).toMatch(/^sig:ed25519:[0-9a-f]{128}$/);
    } finally {
      execFileSync("security", ["delete-generic-password", "-s", service, "-a", account]);
    }
  });
});
```

(Signature determinism against Rust: ed25519 is deterministic, so identical secret+payload → identical signature across implementations; the node-verify assertion plus allod's own parity suite establishes cross-impl parity without a cross-repo fixture. Note the env-var use: isolate `ALLOD_KEYS_DIR` per test and restore it.)

- [ ] **Step 2: Run failing → implement → green.** Full core suite green.
- [ ] **Step 3: Commit** — `git commit -m "feat(core): TypeScript KeyBackend mirror — XDG/legacy file + macOS Keychain, node ed25519"`

---

### Task 5: Graph-scoped API + MCP graph param + daemon boot

**Files:**
- Modify: `packages/api/src/types.ts` (AppVariables gains `manager: GraphManager`), `packages/api/src/app.ts`, `packages/api/src/serve.ts` + `cli/commands/serve.ts` (boot GraphManager), `packages/api/src/mcp.ts`, `packages/api/src/routes/session.ts`
- Create: `packages/api/src/routes/graphs.ts`
- Modify: `packages/api/tests/api.test.ts` helper if `createApp`'s signature changes
- Create: `packages/api/tests/graphs.test.ts`

**Interfaces:**
- `createApp(manager: GraphManager, embedder: Embedder, config: FreeholdConfig)` — the previous `freehold` param is replaced; a top-level middleware sets `manager` and resolves the DEFAULT graph's `Freehold` into `c.set("freehold", ...)` exactly as before (so every existing route file works unmodified). A second mount at `/api/v1/graphs/:graphId/*` reuses the SAME route sub-app behind a resolver middleware: look up `:graphId` via `manager.get`, 404 `{ error: "unknown graph" }` if absent, else `c.set("freehold", ...)` for that graph. Per-graph embedder: `hash` entries get the hash embedder; `semantic` entries get the shared embedder instance.
- New routes (in graphs.ts, mounted unscoped):
  - `GET /api/v1/graphs` → `{ graphs: GraphEntry[] }`
  - `POST /api/v1/graphs` body `{ path, id?, name? }` → registers a repo graph (registerRepo), 400 with the manager's error message on invalid path
  - `PATCH /api/v1/graphs/:id` body `{ name?, autoPushNotes?, embedder? }` → updated entry
  - `DELETE /api/v1/graphs/:id` → removes registry entry (409 for the default graph)
- MCP: `registerTools` gains the manager; every tool schema adds optional `graph` (string); resolution `graph ?? manager.defaultId()`; unknown graph → tool error result, not a throw.
- `GET /session` adds `graphs: [{id, name, kind}]` and `defaultGraph: "main"`.

- [ ] **Step 1: Write failing API tests** (`graphs.test.ts`, in-process `app.request()` style copied from api.test.ts): list contains `main`; register a scratch repo graph (reuse the manager-test fixture helper — export it from a shared test util if needed) → appears in list; `POST /api/v1/graphs` with a bogus path → 400; scoped route parity: `GET /api/v1/graphs/main/memories?scope=all` returns the same body as `GET /api/v1/memories?scope=all`; unknown graph id → 404; PATCH settings round-trips; DELETE on `main` → 409; MCP: call the `recall` tool with `graph: "main"` and without → same result shape.
- [ ] **Step 2: Implement; run `pnpm --filter @freehold/api test` (unit scope) green, plus the full unit suite.**
- [ ] **Step 3: Commit** — `git commit -m "feat(api): multi-graph daemon — /graphs registry routes, graph-scoped mounts, MCP graph param"`

---

### Task 6: Console graph switcher + graph-scoped client

**Files:**
- Modify: `packages/client/src/client.ts` (constructor option `graphId?: string` → when set, all `/api/v1/...` paths become `/api/v1/graphs/<id>/...`; add `listGraphs()`, `registerGraph()`, `updateGraph()` methods; regenerate types if the client's types are OpenAPI-generated — follow `packages/client/generate.ts`'s workflow, or hand-extend `types.ts` matching its conventions)
- Modify: `packages/web/src/components/AppShell.tsx` (switcher UI), `packages/web/src/lib/api.ts` (client instance derives graphId from persisted selection)
- Test: whatever pattern `packages/web` uses today (standalone vitest) — a client unit test for path prefixing at minimum (`packages/client` or web test dir)

**Behavior:**
- Switcher renders in the sidebar between the `Freehold` header and the NAV list: a select listing `session.graphs` (or `GET /graphs`), current selection persisted in `localStorage["freehold-graph"]`, default `main`. Changing it updates the shared client's graphId and invalidates queries (follow however the app refreshes after mutations today — TanStack Query invalidation or a full state reset; find the existing pattern and reuse).
- Memory-specific areas stay visible for the default graph exactly as today. For repo graphs, nav items other than Inbox/Policy/Verify/Settings hide (the Code area arrives in sub-project 2); pick the hiding mechanism by `kind` from the graphs list.
- No new visual design: reuse existing sidebar styles/components.

- [ ] **Step 1: Client test first** — path prefixing: a `FreeholdClient` with `graphId: "g1"` issues requests to `/api/v1/graphs/g1/memories...` (assert via injected fetch mock, matching how client tests are written today; if none exist, a minimal fetch-mock vitest in packages/client establishes it).
- [ ] **Step 2: Implement client changes; test green.**
- [ ] **Step 3: Implement the switcher + nav gating; run the web build (`pnpm --filter @freehold/web build` or the repo's script) to prove it compiles; run web tests if present.**
- [ ] **Step 4: Full repo unit suite green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web,client): graph switcher with persisted selection; graph-scoped client paths"`

---

### Task 7: Live smoke + notes

**Steps:**
- [ ] **Step 1:** Boot the daemon from source against a temp `FREEHOLD_HOME` (the pattern persist.test.ts uses), register the allod checkout `/Users/conner/code/allod` as a repo graph via `POST /api/v1/graphs`, and verify: `GET /api/v1/graphs` shows both graphs; `GET /api/v1/graphs/<id>/proposals` answers (empty is fine); the memory graph's `/api/v1/memories` unchanged. Kill the daemon (`lsof -ti :<port>`), remove the temp home. Record the transcript in the report. (Note: registration installs the review ontology INTO the allod repo's graph — that mutates `/Users/conner/code/allod/.allod`. AVOID mutating the real checkout: copy the checkout's `.allod` into a temp git repo for this smoke instead, or verify against a scratch graph fixture. Do NOT leave the real allod graph modified.)
- [ ] **Step 2:** Update `docs/specs/2026-08-04-governed-review-surface-design.md`: mark sub-project 1 shipped with a short Deviations note (link: dependency caveat included).
- [ ] **Step 3:** Full unit suite one final time.
- [ ] **Step 4: Commit** — `git commit -m "docs: M4 sub-project 1 shipped; link: dependency caveat"`

---

## Self-review notes (already applied)

- Spec coverage: GraphManager registry/fields (T3), per-graph index scoping (T2), review-ontology install at registration (T3), origin remote capture (T3), git shell-out isolation (T3), graphs API + scoped aliases + MCP param (T5), switcher + persisted selection (T6), KeyBackend mirror incl. keychain YAML-value parsing (T4), wasm bindings availability (T1). Decide-through-KeyBackend wiring lands in sub-project 3 (Inbox decide path) where it is exercised; T4 delivers the module it will call.
- Placeholders: T2's test block is intentionally shape-level because db.ts helper names must be read from the file; the step text mandates using the real helpers — implementer discretion is bounded to naming, not behavior.
- Type consistency: `GraphEntry`/`GraphManager` signatures used identically in T3/T5/T6; `ResolvedKey`/`signPayload` in T4 match what SP3 will consume; `DEFAULT_GRAPH_ID` in T2/T3.
