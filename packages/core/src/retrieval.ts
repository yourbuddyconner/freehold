/**
 * @freehold/core — Retrieval operations layer.
 *
 * Entity lookup and graph traversal helpers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AllodGraph } from "@allod/core";
import { withGraph } from "./lock.js";
import type { EdgeView, EntityView, RevisionView } from "./types.js";

// ---- Raw Allod shapes from object_get ----

interface RawObjectContent {
  kind?: string;
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  from?: string;
  to?: string;
  subject?: string;
  term?: string;
  provenance?: unknown;
}

interface RawObject {
  content: RawObjectContent;
  rev: string;
  deleted: boolean;
}

// ---- Raw shape from entity_context() ----

interface RawEntityContext {
  classifications: Array<{ term: string; asserted_by: string; basis: string }>;
  edges_out: Array<{ id: string; type: string; to: string; attributes: Record<string, unknown> }>;
  edges_in: Array<{ id: string; type: string; from: string; attributes: Record<string, unknown> }>;
}

// ---- Raw shapes from log() ----

export interface RawLogEntry {
  hash: string;
  author: string;
  op_count: number;
  intent: string;
}

// ---- Raw shapes from state() ----

interface RawStateNode {
  type_ref: string;
  label: string;
  derived_by: string | null;
}

interface RawStateView {
  state_hash: string;
  nodes: RawStateNode[];
}

// ---- Raw shapes from proposal_get / changeset ops ----

interface RawOpPayload {
  kind?: string;
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  from?: string;
  to?: string;
  subject?: string;
  term?: string;
  provenance?: unknown;
}

interface RawOp {
  create?: RawOpPayload;
  update?: RawOpPayload;
}

interface RawChangeset {
  hash?: string;
  intent?: string;
  author?: { principal?: string };
  operations?: RawOp[];
}

// ---- Typed AllodGraph extensions ----

interface ExtendedGraph {
  object_get(kind: string, id: string): RawObject | null;
  log(): RawLogEntry[];
  state(): RawStateView;
  entity_context(nodeId: string): RawEntityContext | null;
  // The log() entries don't expose individual op details, so we need to use
  // the allod store chain. allod-wasm's log() only returns ChangesetSummary,
  // not full changesets. We derive revisions from log entries + pattern matching.
}

/**
 * Narrow interface for AllodGraph that exposes the log() method with
 * proper typing. Use this instead of casting to `any` in route handlers.
 */
export interface LoggableGraph {
  log(): RawLogEntry[];
}

// ---- Internal helpers (all called from within withGraph critical sections) ----

/**
 * Strip the `node:` / `edge:` prefix from a reference, returning the bare UUID.
 */
function bareId(ref: string | undefined): string {
  if (!ref) return "";
  const colon = ref.indexOf(":");
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/**
 * Fetch the live object from fold state via object_get.
 * Must be called from within a withGraph critical section.
 */
function getObject(graph: AllodGraph, kind: string, id: string): RawObject | null {
  try {
    return (graph as unknown as ExtendedGraph).object_get(kind, id);
  } catch {
    return null;
  }
}

/**
 * Walk the saved changeset log to find the changesets that mutated this
 * node — ops whose payload id IS the node (create/update), not edges or
 * classifications that merely reference it.
 *
 * With `changesetDir`, each changeset file is scanned for a payload-id line;
 * without it (no disk access), the fallback matches intents that name the
 * node id (update intents do; create intents do not).
 *
 * Returns newest first. Must be called from within a withGraph critical
 * section.
 */
function revisionsForNode(
  graph: AllodGraph,
  nodeId: string,
  changesetDir?: string
): RevisionView[] {
  try {
    const log = (graph as unknown as ExtendedGraph).log();
    const touched: RevisionView[] = [];
    // In op payloads the node's own id appears as `id: <uuid>`; references
    // from edges and classifications carry the `node:` prefix and never match.
    const idLine = new RegExp(`^\\s+id: ${nodeId}$`, "m");

    for (const entry of log) {
      let mutates = false;
      if (changesetDir) {
        const file = join(changesetDir, `${entry.hash.replace("sha256:", "")}.yaml`);
        if (existsSync(file)) {
          try {
            mutates = idLine.test(readFileSync(file, "utf-8"));
          } catch {
            mutates = false;
          }
        }
      } else {
        mutates = entry.intent.includes(nodeId);
      }
      if (mutates) {
        touched.push({ hash: entry.hash, author: entry.author });
      }
    }
    return touched.reverse();
  } catch {
    return [];
  }
}

/**
 * Fetch classifications and edges for a node from fold state via entity_context.
 * Returns null if entity_context is not available or the node doesn't exist.
 *
 * Must be called from within a withGraph critical section.
 */
function entityContext(graph: AllodGraph, nodeId: string): RawEntityContext | null {
  try {
    return (graph as unknown as ExtendedGraph).entity_context(nodeId);
  } catch {
    return null;
  }
}

/**
 * Build an EntityView from fold state. Must be called from within a withGraph
 * critical section — does NOT acquire the lock itself.
 */
function buildEntityView(
  graph: AllodGraph,
  nodeId: string,
  changesetDir?: string
): EntityView | null {
  const obj = getObject(graph, "node", nodeId);
  if (!obj || obj.deleted) return null;

  const content = obj.content;
  const attributes = content.attributes ?? {};
  const typeRef = content.type ?? "";
  const provenance = content.provenance;

  // Use entity_context to get real classifications and edges from fold state
  const ctx = entityContext(graph, nodeId);

  const classifications: string[] = ctx ? ctx.classifications.map((c) => c.term) : [];

  const edges: EdgeView[] = ctx
    ? [
        ...ctx.edges_out.map((e) => ({
          id: e.id,
          type: e.type,
          from: `node:${nodeId}`,
          to: e.to,
          direction: "outgoing" as const,
          attributes: e.attributes,
        })),
        ...ctx.edges_in.map((e) => ({
          id: e.id,
          type: e.type,
          from: e.from,
          to: `node:${nodeId}`,
          direction: "incoming" as const,
          attributes: e.attributes,
        })),
      ]
    : [];

  // Revisions: the changesets that mutated this node
  const revisions: RevisionView[] = revisionsForNode(graph, nodeId, changesetDir);

  return {
    id: nodeId,
    type: typeRef,
    rev: obj.rev,
    attributes,
    classifications,
    edges,
    provenance,
    revisions,
  };
}

// ---- Public API ----

/**
 * Get a rich view of a single entity by its node ID (bare UUID).
 *
 * Uses `object_get("node", id)` for content and rev, derives edges from
 * the fold state (all live edge objects whose from/to reference this node),
 * and derives revisions from the log.
 *
 * Returns null if the node is not found in the current fold state.
 */
export async function getEntity(
  graph: AllodGraph,
  nodeId: string,
  opts?: { changesetDir?: string }
): Promise<EntityView | null> {
  return withGraph(graph, () => buildEntityView(graph, nodeId, opts?.changesetDir));
}

/** The on-disk changeset directory for a graph home. */
export function changesetDirFor(home: string, graphName: string): string {
  return join(home, "graphs", graphName, ".allod", "changesets");
}

/**
 * BFS traversal starting from `fromId`, following edges of `edgeTypes`
 * (all edge types if omitted) in `direction` ("out" | "in" | "both", default "out")
 * up to `depth` hops (default 1). Returns an `EntityView[]` of reached nodes
 * (excluding the starting node itself).
 *
 * Implementation note: allod-wasm's wasm surface does not expose a way to
 * enumerate all live edge objects by from/to. We derive the adjacency from
 * the changeset log by scanning op intents and known patterns. For the
 * initial implementation, we look for edges by checking `object_get` on
 * edge IDs harvested from the log intents.
 *
 * For a complete traversal, a future `edges_for(nodeRef)` wasm method would
 * be needed. The current implementation finds edges that were created via
 * `relate()` (which writes the edge ID into the log intent as
 * "Relate <edgeType>") and tries `object_get("edge", ...)` on IDs found in
 * the log, which is impractical without edge ID knowledge.
 *
 * Pragmatic approach: use `log()` changeset summaries to find relate-style
 * changesets, then `object_get` with the involved node IDs.
 *
 * @param graph - The open graph.
 * @param fromId - The starting node's bare UUID.
 * @param edgeTypes - Optional filter on edge type refs (e.g. "memory/relates_to@1").
 * @param direction - "out" (default), "in", or "both".
 * @param depth - Maximum hops (default 1).
 */
export async function traverse(
  graph: AllodGraph,
  fromId: string,
  edgeTypes?: string[],
  direction: "out" | "in" | "both" = "out",
  depth = 1
): Promise<EntityView[]> {
  if (depth <= 0) return [];

  return withGraph(graph, () => {
    const visited = new Set<string>([fromId]);
    const results: EntityView[] = [];
    let frontier: string[] = [fromId];

    for (let hop = 0; hop < depth; hop++) {
      const nextFrontier: string[] = [];

      for (const currentId of frontier) {
        const ctx = entityContext(graph, currentId);
        if (!ctx) continue;

        const candidates: string[] = [];

        if (direction === "out" || direction === "both") {
          for (const edge of ctx.edges_out) {
            if (!edgeTypes || edgeTypes.length === 0 || edgeTypes.includes(edge.type)) {
              candidates.push(bareId(edge.to));
            }
          }
        }

        if (direction === "in" || direction === "both") {
          for (const edge of ctx.edges_in) {
            if (!edgeTypes || edgeTypes.length === 0 || edgeTypes.includes(edge.type)) {
              candidates.push(bareId(edge.from));
            }
          }
        }

        for (const candidateId of candidates) {
          if (!visited.has(candidateId)) {
            visited.add(candidateId);
            nextFrontier.push(candidateId);
            const ev = buildEntityView(graph, candidateId);
            if (ev) results.push(ev);
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return results;
  });
}

/**
 * Return all entities of a given type currently live in the graph.
 */
export async function entitiesOfType(graph: AllodGraph, typeRef: string): Promise<EntityView[]> {
  return withGraph(graph, () => {
    const raw = (graph as unknown as ExtendedGraph).state();
    if (!raw?.nodes) return [];
    const bare = typeRef.split("@")[0];
    return raw.nodes
      .filter((n) => {
        const nBare = (n.type_ref ?? "").split("@")[0];
        return nBare === bare || n.type_ref === typeRef;
      })
      .map((n) => ({
        id: n.label ?? "",
        type: n.type_ref ?? "",
        rev: "",
        attributes: { label: n.label },
        classifications: [],
        edges: [],
        provenance: n.derived_by ? { derived_by: n.derived_by } : undefined,
        revisions: [],
      }));
  });
}
