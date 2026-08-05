/**
 * @freehold/core — Index synchronization
 *
 * Reads admitted changesets from the allod graph and upserts rows into PGlite
 * so that recall() can search them.
 *
 * The allod WASM API exposes log() (ChangesetSummary[]) and object_get(kind,id)
 * (full content+rev for any live object). We bridge from log hash → node IDs by
 * parsing each admitted changeset file as structured YAML (via js-yaml) and
 * reading the operations array — no line-scanning heuristics.
 *
 * syncIndex  — incremental: only processes new log entries
 * reindex    — destructive: wipes PGlite and calls syncIndex
 *
 * Graph access is serialized through withGraph to prevent wasm-bindgen aliasing
 * errors (AllodGraph holds a Rust &mut borrow across async persists). All graph
 * reads are batched inside a single withGraph call; PGlite writes happen outside
 * the lock to avoid holding it during unrelated I/O.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import {
  deleteIndexedHead,
  fmtVec,
  getIndexedHead,
  setIndexedHead,
  upsertEdge,
  upsertNodeTerm,
  upsertObject,
} from "./db.js";
import type { Embedder } from "./embed.js";
import type { Freehold } from "./graphs.js";
import { withGraph } from "./lock.js";

// UUID v4 pattern (lowercase hex with hyphens)
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

interface RawLogEntry {
  hash: string;
  author: string;
  op_count: number;
  intent: string;
}

interface RawObject {
  content: Record<string, unknown>;
  rev: string;
  deleted: boolean;
}

/**
 * A parsed node operation from a changeset's operations array.
 */
interface NodeOp {
  id: string;
  type: string;
}

/**
 * Extract human-readable search text from a node's content object.
 */
function extractSearchText(content: Record<string, unknown>): string {
  const attrs = (content.attributes as Record<string, unknown>) ?? {};
  return (
    (attrs.content as string) ??
    (attrs.statement as string) ??
    (attrs.name as string) ??
    (attrs.display_name as string) ??
    ""
  );
}

/**
 * Parse node operations from a changeset YAML file using js-yaml.
 *
 * Allod changeset operations are wrapped in an action envelope:
 *   { create: { kind: node, id: "...", type: "...", ... } }
 *   { update: { kind: node, id: "...", type: "...", ... } }
 *
 * Returns { id, type }[] for each create/update node operation.
 */
function parseNodeOps(yaml: string): NodeOp[] {
  let doc: unknown;
  try {
    doc = yamlLoad(yaml);
  } catch {
    return [];
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return [];
  }

  const cs = doc as Record<string, unknown>;
  const operations = cs.operations;
  if (!Array.isArray(operations)) {
    return [];
  }

  const results: NodeOp[] = [];
  for (const op of operations) {
    if (!op || typeof op !== "object" || Array.isArray(op)) continue;
    const o = op as Record<string, unknown>;

    // Each op is { create: { kind, id, type, ... } } or { update: { kind, id, type, ... } }
    const inner =
      (o.create as Record<string, unknown> | undefined) ??
      (o.update as Record<string, unknown> | undefined);
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) continue;

    if (inner.kind !== "node") continue;

    const id = typeof inner.id === "string" ? inner.id : null;
    const type = typeof inner.type === "string" ? inner.type : null;
    if (!id || !type) continue;

    results.push({ id, type });
  }

  return results;
}

interface EdgeOp {
  id: string;
  type: string;
  from: string;
  to: string;
}

interface TermOp {
  subjectId: string;
  term: string;
}

function stripRef(ref: string): string {
  const colon = ref.indexOf(":");
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/**
 * Parse edge creations and node classifications from a changeset YAML.
 * These mirror into PGlite so listings never need per-node wasm calls.
 */
function parseRelationOps(yaml: string): { edges: EdgeOp[]; terms: TermOp[] } {
  let doc: unknown;
  try {
    doc = yamlLoad(yaml);
  } catch {
    return { edges: [], terms: [] };
  }
  const operations = (doc as Record<string, unknown> | null)?.operations;
  if (!Array.isArray(operations)) return { edges: [], terms: [] };

  const edges: EdgeOp[] = [];
  const terms: TermOp[] = [];
  for (const op of operations) {
    if (!op || typeof op !== "object" || Array.isArray(op)) continue;
    const inner = (op as Record<string, unknown>).create as Record<string, unknown> | undefined;
    if (!inner || typeof inner !== "object") continue;

    if (
      inner.kind === "edge" &&
      typeof inner.id === "string" &&
      typeof inner.type === "string" &&
      typeof inner.from === "string" &&
      typeof inner.to === "string"
    ) {
      edges.push({
        id: inner.id,
        type: inner.type,
        from: stripRef(inner.from),
        to: stripRef(inner.to),
      });
    }

    if (
      inner.kind === "classification" &&
      typeof inner.subject === "string" &&
      inner.subject.startsWith("node:") &&
      typeof inner.term === "string"
    ) {
      terms.push({ subjectId: stripRef(inner.subject), term: inner.term });
    }
  }
  return { edges, terms };
}

/**
 * Get the changeset directory for a Freehold instance.
 * Uses freehold.graphDir (the allod graph root) so that repo-kind graphs
 * (where the checkout root IS the graph dir) resolve correctly.
 */
function changesetDir(freehold: Freehold): string {
  return join(freehold.graphDir, ".allod", "changesets");
}

/**
 * Read all node operations from admitted changesets.
 * Returns a map from node UUID → { type, author, changesetHash }.
 *
 * Non-UUID node ids (meta/schema nodes) are also included; callers can
 * distinguish them by checking UUID_RE against the key if needed.
 *
 * Warnings are collected and returned so callers can surface them rather
 * than silently dropping changesets. A missing changeset file is always
 * reported — silent skips during indexing are a data-loss class of bug.
 */
function collectNodeOps(
  freehold: Freehold,
  log: RawLogEntry[]
): {
  nodeMap: Map<string, { type: string; author: string; changesetHash: string }>;
  edgeOps: EdgeOp[];
  termOps: TermOp[];
  warnings: string[];
} {
  const csDir = changesetDir(freehold);
  const nodeMap = new Map<string, { type: string; author: string; changesetHash: string }>();
  const edgeOps: EdgeOp[] = [];
  const termOps: TermOp[] = [];
  const warnings: string[] = [];

  for (const entry of log) {
    const bareHash = entry.hash.replace("sha256:", "");
    const yamlPath = join(csDir, `${bareHash}.yaml`);

    if (!existsSync(yamlPath)) {
      warnings.push(
        `[indexer] changeset file missing for admitted entry ${entry.hash} (intent: "${entry.intent}") — skipping`
      );
      continue;
    }

    let yaml: string;
    try {
      yaml = readFileSync(yamlPath, "utf-8");
    } catch (err) {
      warnings.push(
        `[indexer] failed to read changeset file ${yamlPath}: ${err instanceof Error ? err.message : String(err)} — skipping`
      );
      continue;
    }

    // Extract author from log entry (format: "principal:name")
    const authorRef = entry.author ?? "";
    const author = authorRef.startsWith("principal:")
      ? authorRef.slice("principal:".length)
      : authorRef;

    const ops = parseNodeOps(yaml);
    for (const { id, type } of ops) {
      // Later entries (higher index in log) take precedence for updated nodes
      nodeMap.set(id, { type, author, changesetHash: entry.hash });
    }

    const rel = parseRelationOps(yaml);
    edgeOps.push(...rel.edges);
    termOps.push(...rel.terms);
  }

  return { nodeMap, edgeOps, termOps, warnings };
}

/**
 * Incrementally sync the PGlite index with admitted changesets from the graph.
 *
 * Idempotent: calling this twice in a row is safe (the second call is a no-op
 * if no new changesets were admitted between calls).
 *
 * Graph reads (log + object_get calls) are serialized through withGraph.
 * PGlite writes happen outside the lock to avoid holding it during unrelated I/O.
 */
export async function syncIndex(freehold: Freehold, embedder: Embedder): Promise<void> {
  const { pg } = freehold.db;
  const graphId = freehold.graphId;

  // Step 1: get the admitted log — serialized through the graph lock
  const log = await withGraph(freehold.graph, () => {
    return freehold.graph.log() as RawLogEntry[];
  });
  if (!Array.isArray(log)) return;

  // Step 2: check indexed_head (PGlite — no graph lock needed)
  const indexedHead = await getIndexedHead(graphId, pg);

  // Step 3: if up-to-date, nothing to do
  if (indexedHead >= log.length) return;

  // Only process new log entries
  const newEntries = log.slice(indexedHead);

  // Step 4: collect node operations from new changeset files (structural YAML parse)
  // collectNodeOps reads the filesystem only — no graph lock needed
  const { nodeMap: nodeOps, edgeOps, termOps, warnings } = collectNodeOps(freehold, newEntries);

  // Surface any file-read warnings. A missing changeset during indexing is not
  // expected in normal operation and indicates a data-integrity issue worth logging.
  for (const w of warnings) {
    console.warn(w);
  }

  // Step 5+6: for each node, fetch content via object_get (inside lock) then
  // upsert into PGlite (outside lock). We batch the graph reads so we hold
  // the lock for one acquisition per node, not one giant critical section that
  // includes all the async PGlite work.
  //
  // Non-UUID node ids (meta schema nodes like "memory/Note@1") are skipped here
  // because object_get("node", non-uuid) returns null; they are not user-facing
  // objects and carry no search_text per the F3 decision.
  for (const [nodeId, { type: typeRef, author, changesetHash }] of nodeOps) {
    // Skip non-UUID ids: meta/schema nodes use path-style ids, not UUIDs
    if (!UUID_RE.test(nodeId)) continue;

    // Fetch object content under the graph lock
    let objContent: Record<string, unknown> | null = null;
    try {
      objContent = await withGraph(freehold.graph, () => {
        const obj = (
          freehold.graph as unknown as {
            object_get(kind: string, id: string): RawObject | null;
          }
        ).object_get("node", nodeId);
        if (!obj || obj.deleted) return null;
        return obj.content ?? {};
      });
    } catch (err) {
      console.warn(
        `[indexer] object_get("node", ${nodeId}) threw for changeset ${changesetHash}: ${err instanceof Error ? err.message : String(err)} — skipping node`
      );
      continue;
    }

    if (objContent === null) continue;

    const isMeta = typeRef.split("@")[0].startsWith("meta/");
    const searchText = isMeta ? "" : extractSearchText(objContent);

    // Extract method from provenance, with fallback to null for owner-authored objects
    // (they carry no provenance stamp). Log entries' ops carry provenance for agent writes;
    // only saved (approved) changesets are indexed, so approval is always "saved".
    const provenance = objContent.provenance as Record<string, unknown> | undefined;
    const method = (provenance?.method as string) ?? null;

    // Upsert into objects table (PGlite — no graph lock needed)
    await upsertObject(graphId, pg, {
      id: nodeId,
      kind: "node",
      type: typeRef,
      content: objContent,
      author,
      method,
      approval: "saved",
      changeset: changesetHash,
      searchText,
    });

    // Step 7: embed non-meta nodes that have search text
    if (!isMeta && searchText.length > 0) {
      const [vec] = await embedder.embed([searchText]);
      await pg.query(
        `INSERT INTO embeddings (object_id, vec)
         VALUES ($1, $2::vector)
         ON CONFLICT (object_id) DO UPDATE SET vec = EXCLUDED.vec`,
        [nodeId, fmtVec(vec)]
      );
    }
  }

  // Step 7.5: mirror edges and node classifications
  for (const e of edgeOps) {
    await upsertEdge(graphId, pg, { id: e.id, type: e.type, from: e.from, to: e.to });
  }
  for (const t of termOps) {
    await upsertNodeTerm(graphId, pg, { subjectId: t.subjectId, term: t.term });
  }

  // Step 8: update indexed_head.
  // NOTE: indexed_head stores the log *length* (not a hash), so it is a position
  // cursor, not a content fingerprint. If the allod log were ever compacted or
  // re-written (not possible in the current allod version), a stale length could
  // cause syncIndex to skip entries. For a future hardening pass, also persist
  // the hash of the last processed entry and validate on resume.
  await setIndexedHead(graphId, pg, log.length);
}

/**
 * Wipe the PGlite index for a single graph and rebuild it from scratch.
 *
 * Equivalent to: delete graph rows → delete indexed_head → syncIndex.
 *
 * Uses graph-scoped DELETEs rather than TRUNCATE so that only the target
 * graph's rows are removed; other graphs' data is unaffected.
 * Deleting from objects cascades to embeddings via the FK ON DELETE CASCADE.
 */
export async function reindex(freehold: Freehold, embedder: Embedder): Promise<void> {
  const { pg } = freehold.db;
  const graphId = freehold.graphId;
  // DELETE … WHERE graph_id = $1 is graph-scoped; other graphs are untouched.
  // The FK on embeddings.object_id has ON DELETE CASCADE, so embeddings rows
  // for deleted objects are removed automatically.
  await pg.query("DELETE FROM objects WHERE graph_id = $1", [graphId]);
  await pg.query("DELETE FROM graph_edges WHERE graph_id = $1", [graphId]);
  await pg.query("DELETE FROM node_terms WHERE graph_id = $1", [graphId]);
  await deleteIndexedHead(graphId, pg);
  await syncIndex(freehold, embedder);
}
