/**
 * @freehold/core — Workspace views over the memory graph.
 *
 * Flat index listing (backs the console's tree) and full graph export
 * (backs the graph canvas). Nodes come from the PGlite index; taxonomy
 * terms and edges come from fold state via entity_context, read inside
 * one withGraph critical section. System nodes (meta/*, core/*) are not
 * memories and are excluded.
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

interface RawEntityContext {
  classifications: Array<{ term: string; asserted_by: string; basis: string }>;
  edges_out: Array<{ id: string; type: string; to: string; attributes: Record<string, unknown> }>;
  edges_in: Array<{ id: string; type: string; from: string; attributes: Record<string, unknown> }>;
}

interface CtxGraph {
  entity_context(nodeId: string): RawEntityContext | null;
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

function bareId(ref: string): string {
  const colon = ref.indexOf(":");
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/** entity_context, null when the node is not in fold state (pending/rejected/unknown). */
function contextOf(graph: unknown, nodeId: string): RawEntityContext | null {
  try {
    return (graph as CtxGraph).entity_context(nodeId);
  } catch {
    return null;
  }
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
 * derived title, approval, author, updated time, and taxonomy terms.
 * Terms come from fold state, so pending and rejected nodes carry [].
 */
export async function memoryIndex(freehold: Freehold, cap = 5000): Promise<MemoryIndexEntry[]> {
  const rows = await indexRows(freehold, cap);
  const knownIds = new Set(rows.map((r) => r.id));

  const { termsById, pendingEntries } = await withGraph(freehold.graph, () => {
    const map = new Map<string, string[]>();
    for (const row of rows) {
      if (row.approval !== "saved") continue;
      const ctx = contextOf(freehold.graph, row.id);
      if (ctx)
        map.set(
          row.id,
          ctx.classifications.map((c) => c.term)
        );
    }

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
    return { termsById: map, pendingEntries: fromProposals };
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
 * Nodes and edges for the graph canvas. Edges come from each saved node's
 * edges_out in fold state, so every edge appears once. Edges pointing at
 * nodes outside the (capped) node set are dropped. `truncated` reports
 * whether the node cap cut the listing short.
 */
export async function memoryGraph(freehold: Freehold, nodeCap = 2000): Promise<MemoryGraphView> {
  const rows = await indexRows(freehold, nodeCap);
  const truncated = rows.length >= nodeCap;
  const nodeIds = new Set(rows.map((r) => r.id));

  const edges = await withGraph(freehold.graph, () => {
    const out: GraphEdge[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.approval !== "saved") continue;
      const ctx = contextOf(freehold.graph, row.id);
      if (!ctx) continue;
      for (const e of ctx.edges_out) {
        const to = bareId(e.to);
        if (!nodeIds.has(to) || seen.has(e.id)) continue;
        seen.add(e.id);
        out.push({ id: e.id, type: e.type, from: row.id, to });
      }
    }
    return out;
  });

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
