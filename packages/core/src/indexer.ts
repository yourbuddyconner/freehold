/**
 * @freehold/core — Index synchronization
 *
 * Reads admitted changesets from the allod graph and upserts rows into PGlite
 * so that recall() can search them.
 *
 * The allod WASM API exposes log() (ChangesetSummary[]) but not full changeset
 * contents for admitted entries. We bridge the gap by reading the raw YAML
 * changeset files from the graph's .allod/changesets/ directory.
 *
 * syncIndex  — incremental: only processes new log entries
 * reindex    — destructive: wipes PGlite and calls syncIndex
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmtVec } from "./db.js";
import type { Embedder } from "./embed.js";
import type { Freehold } from "./graphs.js";

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
 * Parse node UUIDs from a YAML changeset file using line-by-line scanning.
 * Returns { id, type }[] for each create/update node operation.
 *
 * We use a line scanner rather than a full YAML parser since we only need
 * the id and type fields from node operation blocks.
 */
function parseNodeOpsLineByLine(yaml: string): Array<{ id: string; type: string }> {
  const lines = yaml.split("\n");
  const results: Array<{ id: string; type: string }> = [];
  let inNodeBlock = false;
  let currentId = "";
  let currentType = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "kind: node") {
      inNodeBlock = true;
      currentId = "";
      currentType = "";
      continue;
    }

    if (inNodeBlock) {
      if (trimmed.startsWith("id: ")) {
        const val = trimmed.slice("id: ".length).trim();
        // UUID pattern check: schema/classification nodes have non-UUID ids like
        // "memory/Note@1"; setting inNodeBlock=false skips the rest of that block.
        // The next "kind: node" line will correctly open a fresh block, so nodes
        // that appear later in the same file are still processed.
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(val)) {
          currentId = val;
        } else {
          inNodeBlock = false;
        }
        continue;
      }

      if (trimmed.startsWith("type: ") && currentId) {
        currentType = trimmed.slice("type: ".length).trim();
        results.push({ id: currentId, type: currentType });
        inNodeBlock = false;
        continue;
      }

      // Any unrelated kind: line resets the block (e.g. kind: edge, kind: schema)
      if (trimmed.startsWith("kind: ") && trimmed !== "kind: node") {
        inNodeBlock = false;
        currentId = "";
        currentType = "";
      }
    }
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

    const ops = parseNodeOpsLineByLine(yaml);
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

  // Step 4: collect node operations from new changeset files
  const nodeOps = collectNodeOps(freehold, newEntries);

  // Step 5+6: for each node, fetch content and upsert into objects
  for (const [nodeId, { type: typeRef, author, changesetHash }] of nodeOps) {
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
        "model-assisted",
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
