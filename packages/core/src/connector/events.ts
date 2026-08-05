/**
 * @freehold/core/connector — Event handler core.
 *
 * Single handler for all connector events. All graph writes are committed as
 * the "owner" principal (graph root) so they are auto-admitted under the
 * default memory policy. Attribution is preserved via external_source and
 * claimed_author attributes on each ReviewComment node.
 *
 * Dedup strategy: scan admitted log + pending proposals for matching external_id
 * without relying on syncIndex (robust against index lag).
 *
 * Never logs secrets or tokens.
 */

import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { withGraph } from "../lock.js";
import type { Freehold } from "../graphs.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type ConnectorEvent =
  | { kind: "push"; ref: string; headSha: string }
  | { kind: "pr"; action: string; number: number; headSha: string }
  | { kind: "comment"; action: "created" | "edited" | "deleted"; id: string; body: string;
      author: string; path?: string; commitSha?: string; prNumber?: number; inReplyTo?: string }
  | { kind: "check"; sha: string; name: string; status: string; conclusion?: string };

export interface IngestResult {
  written: "created" | "updated" | "tombstoned" | "unchanged";
  nodeId?: string;
}

// ── Internal types ────────────────────────────────────────────────────────────

// Connector commits as "owner" — the graph root — so they are admitted
// immediately under the default memory policy (restricted posture, root_required
// for unmatched operations). Attribution is preserved via the external_source and
// claimed_author attributes on each ReviewComment node.
const CONNECTOR_PRINCIPAL = "owner";

interface ParsedNode {
  nodeId: string;
  type: string;
  attributes: Record<string, unknown>;
  changeset: string; // the admitted hash or proposal hash
  status: "saved" | "pending";
  nodeRev: string | null;
}


// ── Dedup: find existing comment node by external_id ─────────────────────────

/** Public shape returned by getCommentNodeByExternalId. */
export interface CommentNodeInfo {
  nodeId: string;
  attributes: Record<string, unknown>;
}

/**
 * Look up a ReviewComment node by its external_id (e.g. GitHub comment id).
 * Returns the node id and its current live attributes (from fold state),
 * or null if no node with that external_id exists in this graph.
 *
 * Useful for test assertions and external tooling — does not require
 * scanning changeset YAML files manually.
 */
export async function getCommentNodeByExternalId(
  fh: Freehold,
  externalId: string
): Promise<CommentNodeInfo | null> {
  const found = await findCommentByExternalId(fh, externalId);
  if (!found) return null;
  return { nodeId: found.nodeId, attributes: found.attributes };
}

/**
 * Scan admitted log + pending proposals for a ReviewComment node with the given external_id.
 * Returns the found node or null. Robust without syncIndex.
 */
async function findCommentByExternalId(
  fh: Freehold,
  externalId: string
): Promise<ParsedNode | null> {
  return withGraph(fh.graph, () => {
    return _findCommentByExternalIdSync(fh, externalId);
  });
}

function _findCommentByExternalIdSync(
  fh: Freehold,
  externalId: string
): ParsedNode | null {
  // ── 1. Admitted log ────────────────────────────────────────────────────────
  let log: Array<{ hash: string }> = [];
  try {
    log = (fh.graph as unknown as { log(): Array<{ hash: string }> }).log();
  } catch {
    // ignore
  }

  if (Array.isArray(log)) {
    const csDir = join(fh.graphDir, ".allod", "changesets");
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

      let doc: unknown;
      try {
        doc = yamlLoad(yaml);
      } catch {
        continue;
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
      const cs = doc as Record<string, unknown>;
      const operations = cs.operations;
      if (!Array.isArray(operations)) continue;

      const found = _findInOps(operations as Array<Record<string, unknown>>, externalId, "saved");
      if (found) {
        // Fetch current node rev
        let nodeRev: string | null = null;
        try {
          nodeRev = (fh.graph as unknown as { node_rev(id: string): string | null }).node_rev(found.nodeId);
        } catch { /* ignore */ }

        // Fetch current attributes from fold state (admitted nodes are always in fold state).
        // The changeset YAML only reflects the op that wrote the entry; fold state has the
        // latest merged attributes (e.g. a subsequent tombstone update).
        let currentAttrs: Record<string, unknown> | undefined;
        try {
          const currentObj = (fh.graph as unknown as {
            object_get(kind: string, id: string): { content?: { attributes?: Record<string, unknown> } } | null
          }).object_get("node", found.nodeId);
          if (currentObj?.content?.attributes) {
            currentAttrs = currentObj.content.attributes;
          }
        } catch { /* ignore — fall back to changeset attrs */ }

        return { ...found, attributes: currentAttrs ?? found.attributes, nodeRev };
      }
    }
  }

  // ── 2. Pending proposals ──────────────────────────────────────────────────
  let proposals: Array<{ hash: string }> = [];
  try {
    proposals = (fh.graph as unknown as { proposals(): Array<{ hash: string }> }).proposals();
  } catch {
    // ignore
  }

  if (Array.isArray(proposals)) {
    for (const p of proposals) {
      let cs: { operations?: Array<Record<string, unknown>> } | null = null;
      try {
        cs = (fh.graph as unknown as {
          proposal_get(hash: string): { operations?: Array<Record<string, unknown>> }
        }).proposal_get(p.hash);
      } catch {
        continue;
      }
      if (!cs || !Array.isArray(cs.operations)) continue;

      const found = _findInOps(cs.operations, externalId, "pending");
      if (found) {
        let nodeRev: string | null = null;
        try {
          nodeRev = (fh.graph as unknown as { node_rev(id: string): string | null }).node_rev(found.nodeId);
        } catch { /* ignore */ }
        return { ...found, nodeRev };
      }
    }
  }

  return null;
}

function _findInOps(
  operations: Array<Record<string, unknown>>,
  externalId: string,
  status: "saved" | "pending"
): Omit<ParsedNode, "nodeRev"> | null {
  for (const op of operations) {
    if (!op || typeof op !== "object") continue;

    // Check create ops
    const inner = (op.create ?? op.update) as Record<string, unknown> | undefined;
    if (!inner || typeof inner !== "object") continue;
    if (inner.kind !== "node") continue;
    if (typeof inner.type !== "string" || !inner.type.startsWith("review/ReviewComment")) continue;

    const attrs = (inner.attributes as Record<string, unknown> | undefined) ?? {};
    if (attrs.external_id === externalId) {
      return {
        nodeId: inner.id as string,
        type: inner.type as string,
        attributes: attrs,
        changeset: "", // not needed for dedup
        status,
      };
    }
  }
  return null;
}

// ── check_status upsert ───────────────────────────────────────────────────────

async function upsertCheckStatus(
  fh: Freehold,
  graphId: string,
  sha: string,
  name: string,
  status: string,
  conclusion?: string
): Promise<void> {
  await fh.db.pg.query(
    `INSERT INTO check_status (graph_id, sha, name, status, conclusion)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (graph_id, sha, name) DO UPDATE SET
       status     = EXCLUDED.status,
       conclusion = EXCLUDED.conclusion`,
    [graphId, sha, name, status, conclusion ?? null]
  );
}

// ── handleConnectorEvent ──────────────────────────────────────────────────────

/**
 * Handle a connector event.
 *
 * push/pr → null (computed on demand, no graph write)
 * check   → upserted to check_status; returns null
 * comment → ReviewComment node upserted to the graph; returns IngestResult
 */
export async function handleConnectorEvent(
  fh: Freehold,
  ev: ConnectorEvent
): Promise<IngestResult | null> {
  if (ev.kind === "push" || ev.kind === "pr") {
    return null;
  }

  if (ev.kind === "check") {
    await upsertCheckStatus(
      fh,
      fh.graphId,
      ev.sha,
      ev.name,
      ev.status,
      ev.conclusion
    );
    return null;
  }

  // ev.kind === "comment"
  // No principal setup needed: connector commits as "owner" (the graph root),
  // which is always present in an initialised allod graph.

  const repoName = basename(fh.graphDir);
  const commitRef = ev.commitSha ? `git:${repoName}#${ev.commitSha}` : undefined;

  // Build the attributes for a created/open comment.
  // status "open" = ingested and active; "tombstoned" = deleted from source system.
  const activeAttrs: Record<string, unknown> = {
    body: ev.body,
    status: "open",
    external_source: "github",
    external_id: ev.id,
    claimed_author: ev.author,
  };
  if (ev.path) {
    activeAttrs.anchor = commitRef ? `${commitRef}:${ev.path}` : ev.path;
  }
  if (ev.inReplyTo) {
    activeAttrs.inReplyTo = ev.inReplyTo;
  }

  // Dedup: check if we've seen this external_id before
  const existing = await findCommentByExternalId(fh, ev.id);

  if (ev.action === "deleted") {
    if (!existing) {
      // Nothing to tombstone — idempotent
      return { written: "tombstoned" };
    }

    // Tombstone: update status to "tombstoned"
    const tombstoneAttrs: Record<string, unknown> = {
      ...existing.attributes,
      status: "tombstoned",
    };

    await withGraph(fh.graph, async () => {
      const rev = (fh.graph as unknown as { node_rev(id: string): string | null }).node_rev(existing.nodeId);
      if (!rev) {
        // Node is pending (not yet in fold state). We can't update it via WASM.
        // Record a soft tombstone in PGlite so resurrection knows the node was deleted.
        await fh.db.pg.query(
          `INSERT INTO connector_soft_tombstone (graph_id, external_id, node_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (graph_id, external_id) DO NOTHING`,
          [fh.graphId, ev.id, existing.nodeId]
        );
        return;
      }

      const updateOp = {
        update: {
          kind: "node",
          id: existing.nodeId,
          type: existing.type,
          prior: rev,
          attributes: tombstoneAttrs,
        },
      };
      await (fh.graph as unknown as {
        commit(author: string, intent: string, ops: unknown[], envelopes: unknown[], sign: boolean): Promise<unknown>
      }).commit(CONNECTOR_PRINCIPAL, `Tombstone ReviewComment ${ev.id}`, [updateOp], [], true);
      // Clear any soft tombstone — the WASM update supersedes it
      await fh.db.pg.query(
        `DELETE FROM connector_soft_tombstone WHERE graph_id = $1 AND external_id = $2`,
        [fh.graphId, ev.id]
      );
    });

    return { written: "tombstoned", nodeId: existing.nodeId };
  }

  // created or edited
  if (existing) {
    // Check whether the node has been soft-tombstoned (pending node that was deleted
    // but whose WASM update was skipped because it wasn't in fold state yet).
    let isSoftTombstoned = false;
    try {
      const tombRows = await fh.db.pg.query<{ node_id: string }>(
        `SELECT node_id FROM connector_soft_tombstone WHERE graph_id = $1 AND external_id = $2`,
        [fh.graphId, ev.id]
      );
      isSoftTombstoned = tombRows.rows.length > 0;
    } catch { /* table may not exist in edge cases — treat as not tombstoned */ }

    // Get current attributes from fold state if available; fall back to changeset attrs.
    // For nodes in fold state, object_get returns the latest merged attributes (e.g. post-tombstone).
    let liveAttrs = existing.attributes;
    try {
      const liveObj = await withGraph(fh.graph, () =>
        (fh.graph as unknown as {
          object_get(kind: string, id: string): { content?: { attributes?: Record<string, unknown> } } | null
        }).object_get("node", existing.nodeId)
      );
      if (liveObj?.content?.attributes) {
        liveAttrs = liveObj.content.attributes;
      }
    } catch { /* ignore — use changeset-derived attrs */ }

    // Check if the body and status are unchanged (idempotent re-delivery).
    // A soft-tombstoned node is never "unchanged" — it needs resurrection.
    const existingBody = liveAttrs.body as string | undefined;
    const existingStatus = liveAttrs.status as string | undefined;

    if (
      !isSoftTombstoned &&
      existingBody === ev.body &&
      existingStatus === "open"
    ) {
      return { written: "unchanged", nodeId: existing.nodeId };
    }

    // Body or status changed — update the node
    await withGraph(fh.graph, async () => {
      const rev = (fh.graph as unknown as { node_rev(id: string): string | null }).node_rev(existing.nodeId);
      if (!rev) {
        // Node is pending and not in fold state — skip the WASM update.
        // (The pending proposal has the old body; we can't update it via WASM.)
        return;
      }

      const updateOp = {
        update: {
          kind: "node",
          id: existing.nodeId,
          type: existing.type,
          prior: rev,
          attributes: activeAttrs,
        },
      };
      await (fh.graph as unknown as {
        commit(author: string, intent: string, ops: unknown[], envelopes: unknown[], sign: boolean): Promise<unknown>
      }).commit(CONNECTOR_PRINCIPAL, `Update ReviewComment ${ev.id}`, [updateOp], [], true);
    });

    // Clear any soft tombstone — the node has been resurrected/updated.
    try {
      await fh.db.pg.query(
        `DELETE FROM connector_soft_tombstone WHERE graph_id = $1 AND external_id = $2`,
        [fh.graphId, ev.id]
      );
    } catch { /* ignore */ }

    return { written: "updated", nodeId: existing.nodeId };
  }

  // New comment — create the node
  const nodeId = crypto.randomUUID();
  const createOp = {
    create: {
      kind: "node",
      id: nodeId,
      type: "review/ReviewComment@1",
      attributes: activeAttrs,
    },
  };

  await withGraph(fh.graph, async () => {
    await (fh.graph as unknown as {
      commit(author: string, intent: string, ops: unknown[], envelopes: unknown[], sign: boolean): Promise<unknown>
    }).commit(CONNECTOR_PRINCIPAL, `Ingest ReviewComment ${ev.id}`, [createOp], [], true);
  });

  return { written: "created", nodeId };
}
