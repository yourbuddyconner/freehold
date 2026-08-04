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
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { fmtVec } from "./db.js";
import type { Embedder } from "./embed.js";
import type { Freehold } from "./graphs.js";

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

/**
 * Get the changeset directory for a Freehold instance.
 */
function changesetDir(freehold: Freehold): string {
  return join(freehold.home, "graphs", freehold.graphName, ".allod", "changesets");
}

/**
 * Read all node operations from admitted changesets.
 * Returns a map from node UUID → { type, author, changesetHash }.
 *
 * Non-UUID node ids (meta/schema nodes) are also included; callers can
 * distinguish them by checking UUID_RE against the key if needed.
 */
function collectNodeOps(
  freehold: Freehold,
  log: RawLogEntry[]
): Map<string, { type: string; author: string; changesetHash: string }> {
  const csDir = changesetDir(freehold);
  const nodeMap = new Map<string, { type: string; author: string; changesetHash: string }>();

  for (const entry of log) {
    const bareHash = entry.hash.replace("sha256:", "");
    const yamlPath = join(csDir, `${bareHash}.yaml`);

    if (!existsSync(yamlPath)) continue;

    let yaml: string;
    try {
      yaml = readFileSync(yamlPath, "utf-8");
    } catch {
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
  }

  return nodeMap;
}

/**
 * Incrementally sync the PGlite index with admitted changesets from the graph.
 *
 * Idempotent: calling this twice in a row is safe (the second call is a no-op
 * if no new changesets were admitted between calls).
 */
export async function syncIndex(freehold: Freehold, embedder: Embedder): Promise<void> {
  const { pg } = freehold.db;

  // Step 1: get the admitted log
  const log = freehold.graph.log() as RawLogEntry[];
  if (!Array.isArray(log)) return;

  // Step 2: check indexed_head
  const metaResult = await pg.query<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'indexed_head'"
  );
  const indexedHead =
    metaResult.rows.length > 0 ? Number.parseInt(metaResult.rows[0].value, 10) : 0;

  // Step 3: if up-to-date, nothing to do
  if (indexedHead >= log.length) return;

  // Only process new log entries
  const newEntries = log.slice(indexedHead);

  // Step 4: collect node operations from new changeset files (structural YAML parse)
  const nodeOps = collectNodeOps(freehold, newEntries);

  // Step 5+6: for each node, fetch content via object_get and upsert into objects.
  // Non-UUID node ids (meta schema nodes like "memory/Note@1") are skipped here
  // because object_get("node", non-uuid) returns null; they are not user-facing
  // objects and carry no search_text per the F3 decision.
  for (const [nodeId, { type: typeRef, author, changesetHash }] of nodeOps) {
    // Skip non-UUID ids: meta/schema nodes use path-style ids, not UUIDs
    if (!UUID_RE.test(nodeId)) continue;

    let objContent: Record<string, unknown> = {};

    try {
      const obj = freehold.graph.object_get("node", nodeId) as RawObject | null;
      if (!obj || obj.deleted) continue;
      objContent = obj.content ?? {};
    } catch {
      continue;
    }

    const isMeta = typeRef.split("@")[0].startsWith("meta/");
    const searchText = isMeta ? "" : extractSearchText(objContent);

    // Extract method from provenance, with fallback to null for owner-authored objects
    // (they carry no provenance stamp). Log entries' ops carry provenance for agent writes;
    // only admitted changesets are indexed, so approval is always "admitted".
    const provenance = objContent.provenance as Record<string, unknown> | undefined;
    const method = (provenance?.method as string) ?? null;

    // Upsert into objects table
    await pg.query(
      `INSERT INTO objects (id, kind, type, content, author, method, approval, changeset, search_text, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         type = EXCLUDED.type,
         content = EXCLUDED.content,
         author = EXCLUDED.author,
         method = EXCLUDED.method,
         approval = EXCLUDED.approval,
         changeset = EXCLUDED.changeset,
         search_text = EXCLUDED.search_text,
         updated_at = now()`,
      [
        nodeId,
        "node",
        typeRef,
        JSON.stringify(objContent),
        author,
        method,
        "admitted",
        changesetHash,
        searchText,
      ]
    );

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

  // Step 8: update indexed_head.
  // NOTE: indexed_head stores the log *length* (not a hash), so it is a position
  // cursor, not a content fingerprint. If the allod log were ever compacted or
  // re-written (not possible in the current allod version), a stale length could
  // cause syncIndex to skip entries. For a future hardening pass, also persist
  // the hash of the last processed entry and validate on resume.
  await pg.query(
    "INSERT INTO meta (key, value) VALUES ('indexed_head', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [log.length.toString()]
  );
}

/**
 * Wipe the PGlite index and rebuild it from scratch.
 *
 * Equivalent to: truncate → delete indexed_head → syncIndex.
 */
export async function reindex(freehold: Freehold, embedder: Embedder): Promise<void> {
  const { pg } = freehold.db;
  // Truncate objects (CASCADE removes embeddings via FK)
  await pg.exec("TRUNCATE TABLE objects CASCADE");
  await pg.query("DELETE FROM meta WHERE key = 'indexed_head'");
  await syncIndex(freehold, embedder);
}
