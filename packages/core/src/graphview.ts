/**
 * @freehold/core — Workspace views over the memory graph.
 *
 * Flat index listing (backs the console's tree) and full graph export
 * (backs the graph canvas). Nodes, terms, and edges all come from the
 * PGlite index — no per-node wasm calls, so listings stay fast at any
 * size. Only pending proposals are read from the graph. System nodes
 * (meta/*, core/*) are not memories and are excluded.
 */

import type { Freehold } from "./graphs.js";
import { withGraph } from "./lock.js";

export interface MemoryIndexEntry {
  id: string;
  type: string;
  title: string;
  approval: string;
  author: string;
  updatedAt: string;
  terms: string[];
}

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  approval: string;
}

export interface GraphEdge {
  id: string;
  type: string;
  from: string;
  to: string;
}

export interface MemoryGraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

interface RawProposalSummary {
  hash?: string;
  author?: string;
  intent?: string;
}

interface RawProposalOp {
  create?: { kind?: string; id?: string; type?: string; attributes?: Record<string, unknown> };
  update?: { kind?: string; id?: string; type?: string; attributes?: Record<string, unknown> };
}

interface ProposalGraph {
  proposals(): RawProposalSummary[];
  proposal_get(hash: string): { operations?: RawProposalOp[] } | null;
}

interface IndexRow {
  id: string;
  type: string;
  content: unknown;
  author: string;
  approval: string;
  updated_at: string | Date;
}

/**
 * Derive a display title from an indexed node's content jsonb:
 * attributes.title, name, statement, then the first line of content,
 * falling back to `fallback` (usually the node id).
 */
export function deriveTitle(content: unknown, fallback: string): string {
  const c = (content ?? {}) as Record<string, unknown>;
  const attrs = (c.attributes ?? {}) as Record<string, unknown>;
  for (const key of ["title", "name", "statement"]) {
    const v = attrs[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const body = attrs.content;
  if (typeof body === "string" && body.trim()) {
    const first = body
      .trim()
      .split("\n")[0]
      .replace(/^#+\s*/, "")
      .trim();
    if (first) return first.length > 80 ? `${first.slice(0, 80)}…` : first;
  }
  return fallback;
}

async function indexRows(freehold: Freehold, cap: number): Promise<IndexRow[]> {
  const { pg } = freehold.db;
  const result = await pg.query<IndexRow>(
    `SELECT id, type, content, author, approval, updated_at FROM objects
     WHERE kind = 'node' AND type NOT LIKE 'meta/%' AND type NOT LIKE 'core/%'
     ORDER BY updated_at DESC
     LIMIT $1`,
    [cap]
  );
  return result.rows;
}

/**
 * Flat listing of every non-meta node for the workspace tree: id, type,
 * derived title, approval, author, updated time, and taxonomy terms —
 * all from the index.
 */
export async function memoryIndex(freehold: Freehold, cap = 5000): Promise<MemoryIndexEntry[]> {
  const rows = await indexRows(freehold, cap);
  const knownIds = new Set(rows.map((r) => r.id));

  // Terms come from the mirrored node_terms table — one query, no wasm calls
  const termsResult = await freehold.db.pg.query<{ subject_id: string; term: string }>(
    "SELECT subject_id, term FROM node_terms"
  );
  const termsById = new Map<string, string[]>();
  for (const row of termsResult.rows) {
    const list = termsById.get(row.subject_id) ?? [];
    list.push(row.term);
    termsById.set(row.subject_id, list);
  }

  const pendingEntries = await withGraph(freehold.graph, () => {
    // Pending proposals are not in the index; surface their node creates so
    // the tree shows a proposed note in place before it is decided.
    const fromProposals: MemoryIndexEntry[] = [];
    try {
      const g = freehold.graph as unknown as ProposalGraph;
      for (const p of g.proposals() ?? []) {
        if (!p.hash) continue;
        let ops: RawProposalOp[] = [];
        try {
          ops = g.proposal_get(p.hash)?.operations ?? [];
        } catch {
          continue;
        }
        for (const op of ops) {
          const inner = op.create ?? op.update;
          if (!inner || inner.kind !== "node" || !inner.id || !inner.type) continue;
          if (inner.type.split("@")[0].startsWith("meta/")) continue;
          if (knownIds.has(inner.id)) continue;
          knownIds.add(inner.id);
          fromProposals.push({
            id: inner.id,
            type: inner.type,
            title: deriveTitle({ attributes: inner.attributes }, inner.id),
            approval: "pending",
            author: (p.author ?? "").replace(/^principal:/, ""),
            updatedAt: new Date().toISOString(),
            terms: [],
          });
        }
      }
    } catch {
      // proposals() unavailable — index rows alone are still a correct listing
    }
    return fromProposals;
  });

  return [
    ...pendingEntries,
    ...rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: deriveTitle(row.content, row.id),
      approval: row.approval,
      author: row.author,
      updatedAt: new Date(row.updated_at).toISOString(),
      terms: termsById.get(row.id) ?? [],
    })),
  ];
}

/**
 * Nodes and edges for the graph canvas, all from the index. Edges whose
 * endpoints fall outside the (capped) node set are dropped. `truncated`
 * reports whether the node cap cut the listing short.
 */
export async function memoryGraph(freehold: Freehold, nodeCap = 2000): Promise<MemoryGraphView> {
  const rows = await indexRows(freehold, nodeCap);
  const truncated = rows.length >= nodeCap;
  const nodeIds = new Set(rows.map((r) => r.id));

  // Edges come from the mirrored graph_edges table — one query, no wasm calls
  const edgeResult = await freehold.db.pg.query<{
    id: string;
    type: string;
    from_id: string;
    to_id: string;
  }>("SELECT id, type, from_id, to_id FROM graph_edges");
  const edges: GraphEdge[] = edgeResult.rows
    .filter((e) => nodeIds.has(e.from_id) && nodeIds.has(e.to_id))
    .map((e) => ({ id: e.id, type: e.type, from: e.from_id, to: e.to_id }));

  return {
    nodes: rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: deriveTitle(row.content, row.id),
      approval: row.approval,
    })),
    edges,
    truncated,
  };
}
