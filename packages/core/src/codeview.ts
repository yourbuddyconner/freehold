/**
 * @freehold/core — Code graph views.
 *
 * Queries over the PGlite index (objects/graph_edges/node_terms tables) to
 * expose the code sub-graph: file tree, per-file items, per-item call graph,
 * neighborhood, and policy region membership via git_checklist.
 *
 * All wasm calls go through withGraph. PGlite reads are lock-free.
 * No policy logic is implemented in TS — region membership comes exclusively
 * from git_checklist per path.
 */

import type { Freehold } from "./graphs.js";
import { withGraph } from "./lock.js";

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface CodeTreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  language?: string;
  terms: string[];
  children?: CodeTreeNode[];
}

export interface CodeItem {
  nodeId: string;
  type: string;
  name: string;
  signature?: string;
  span?: string;
  terms: string[];
}

export interface CodeFileView {
  path: string;
  language?: string;
  nodeId: string;
  blobRef?: string;
  terms: string[];
  items: CodeItem[];
}

export interface CodeItemView extends CodeItem {
  filePath?: string;
  callersIn: CodeItem[];
  callsOut: CodeItem[];
}

export interface CodeNeighborhood {
  nodes: Array<{ id: string; label: string; type: string; terms: string[] }>;
  edges: Array<{ id: string; from: string; to: string; type: string }>;
}

export interface RegionRule {
  rule: string;
  region?: string;
  reviewers: unknown;
  paths: string[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface SourceFileRow {
  id: string;
  type: string;
  content: { attributes?: { path?: string; language?: string; blob?: string } };
}

interface FunctionRow {
  id: string;
  type: string;
  content: {
    attributes?: { name?: string; signature?: string; span?: string };
  };
}

interface EdgeRow {
  id: string;
  type: string;
  from_id: string;
  to_id: string;
}

interface TermRow {
  subject_id: string;
  term: string;
}

async function querySourceFiles(fh: Freehold): Promise<SourceFileRow[]> {
  const result = await fh.db.pg.query<SourceFileRow>(
    `SELECT id, type, content FROM objects
     WHERE graph_id = $1 AND kind = 'node' AND type LIKE 'code/SourceFile%'`,
    [fh.graphId]
  );
  return result.rows;
}

async function queryTermsById(fh: Freehold): Promise<Map<string, string[]>> {
  const result = await fh.db.pg.query<TermRow>(
    "SELECT subject_id, term FROM node_terms WHERE graph_id = $1",
    [fh.graphId]
  );
  const map = new Map<string, string[]>();
  for (const row of result.rows) {
    const list = map.get(row.subject_id) ?? [];
    list.push(row.term);
    map.set(row.subject_id, list);
  }
  return map;
}

async function queryEdges(fh: Freehold): Promise<EdgeRow[]> {
  const result = await fh.db.pg.query<EdgeRow>(
    "SELECT id, type, from_id, to_id FROM graph_edges WHERE graph_id = $1",
    [fh.graphId]
  );
  return result.rows;
}

function edgeBaseType(type: string): string {
  // "code/declares@1" → "declares", "code/calls@1" → "calls"
  const slash = type.lastIndexOf("/");
  const at = type.indexOf("@");
  const base = type.slice(slash + 1, at > 0 ? at : undefined);
  return base;
}

// ── codeTree ─────────────────────────────────────────────────────────────────

/**
 * Build a nested directory tree from all admitted code/SourceFile nodes,
 * with per-file terms from node_terms and per-dir terms unioned from
 * all descendant files.
 */
export async function codeTree(fh: Freehold): Promise<CodeTreeNode[]> {
  const files = await querySourceFiles(fh);
  const termsById = await queryTermsById(fh);

  // Build flat list of file leaves
  const leaves: CodeTreeNode[] = files.map((row) => {
    const attrs = row.content?.attributes ?? {};
    const p = attrs.path ?? "";
    const parts = p.split("/");
    return {
      name: parts[parts.length - 1] ?? p,
      path: p,
      kind: "file",
      language: attrs.language,
      terms: termsById.get(row.id) ?? [],
    };
  });

  // Build tree by merging paths
  const root: CodeTreeNode[] = [];

  for (const leaf of leaves) {
    const parts = leaf.path.split("/");
    let current = root;
    let pathSoFar = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
      let dir = current.find((n) => n.kind === "dir" && n.name === segment);
      if (!dir) {
        dir = { name: segment, path: pathSoFar, kind: "dir", terms: [], children: [] };
        current.push(dir);
      }
      if (!dir.children) {
        dir.children = [];
      }
      current = dir.children;
    }
    current.push(leaf);
  }

  // Roll up dir terms = union of all descendant file terms
  function rollupTerms(nodes: CodeTreeNode[]): string[] {
    const termSet = new Set<string>();
    for (const node of nodes) {
      if (node.kind === "file") {
        for (const t of node.terms) termSet.add(t);
      } else {
        const childTerms = rollupTerms(node.children ?? []);
        for (const t of childTerms) termSet.add(t);
        node.terms = childTerms;
      }
    }
    return Array.from(termSet);
  }

  rollupTerms(root);
  return root;
}

// ── codeFile ─────────────────────────────────────────────────────────────────

/**
 * Return the file view for the given path, or null if the file is not indexed.
 * Items are all nodes connected to the file via code/declares edges.
 */
export async function codeFile(fh: Freehold, path: string): Promise<CodeFileView | null> {
  // Find the SourceFile node with matching path
  const result = await fh.db.pg.query<SourceFileRow>(
    `SELECT id, type, content FROM objects
     WHERE graph_id = $1 AND kind = 'node' AND type LIKE 'code/SourceFile%'`,
    [fh.graphId]
  );
  const fileRow = result.rows.find((r) => r.content?.attributes?.path === path);
  if (!fileRow) return null;

  const attrs = fileRow.content?.attributes ?? {};
  const termsById = await queryTermsById(fh);
  const edges = await queryEdges(fh);

  // Find all nodes declared by this file (code/declares edges from file → item)
  const declaredIds = edges
    .filter((e) => edgeBaseType(e.type) === "declares" && e.from_id === fileRow.id)
    .map((e) => e.to_id);

  // Load all declared item nodes
  const items: CodeItem[] = [];
  if (declaredIds.length > 0) {
    const placeholders = declaredIds.map((_, i) => `$${i + 2}`).join(", ");
    const itemResult = await fh.db.pg.query<FunctionRow>(
      `SELECT id, type, content FROM objects
       WHERE graph_id = $1 AND kind = 'node' AND id IN (${placeholders})`,
      [fh.graphId, ...declaredIds]
    );
    for (const row of itemResult.rows) {
      const a = row.content?.attributes ?? {};
      items.push({
        nodeId: row.id,
        type: row.type,
        name: a.name ?? row.id,
        signature: a.signature,
        span: a.span,
        terms: termsById.get(row.id) ?? [],
      });
    }
  }

  return {
    path,
    language: attrs.language,
    nodeId: fileRow.id,
    blobRef: attrs.blob,
    terms: termsById.get(fileRow.id) ?? [],
    items,
  };
}

// ── codeItem ─────────────────────────────────────────────────────────────────

/**
 * Return a single code item with its callers (code/calls edges pointing at it)
 * and callees (code/calls edges from it).
 */
export async function codeItem(fh: Freehold, nodeId: string): Promise<CodeItemView | null> {
  const result = await fh.db.pg.query<FunctionRow>(
    "SELECT id, type, content FROM objects WHERE graph_id = $1 AND kind = 'node' AND id = $2",
    [fh.graphId, nodeId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const termsById = await queryTermsById(fh);
  const edges = await queryEdges(fh);

  // Find the file that declares this item (reverse declares edge)
  const declaresEdge = edges.find((e) => edgeBaseType(e.type) === "declares" && e.to_id === nodeId);
  let filePath: string | undefined;
  if (declaresEdge) {
    const fileResult = await fh.db.pg.query<SourceFileRow>(
      "SELECT content FROM objects WHERE graph_id = $1 AND id = $2",
      [fh.graphId, declaresEdge.from_id]
    );
    filePath = fileResult.rows[0]?.content?.attributes?.path;
  }

  // callers: nodes with code/calls edges pointing at this node
  const callerIds = edges
    .filter((e) => edgeBaseType(e.type) === "calls" && e.to_id === nodeId)
    .map((e) => e.from_id);

  // callees: nodes this node calls
  const calleeIds = edges
    .filter((e) => edgeBaseType(e.type) === "calls" && e.from_id === nodeId)
    .map((e) => e.to_id);

  async function loadItems(ids: string[]): Promise<CodeItem[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
    const r = await fh.db.pg.query<FunctionRow>(
      `SELECT id, type, content FROM objects
       WHERE graph_id = $1 AND kind = 'node' AND id IN (${placeholders})`,
      [fh.graphId, ...ids]
    );
    return r.rows.map((item) => {
      const a = item.content?.attributes ?? {};
      return {
        nodeId: item.id,
        type: item.type,
        name: a.name ?? item.id,
        signature: a.signature,
        span: a.span,
        terms: termsById.get(item.id) ?? [],
      };
    });
  }

  const a = row.content?.attributes ?? {};
  return {
    nodeId: row.id,
    type: row.type,
    name: a.name ?? row.id,
    signature: a.signature,
    span: a.span,
    terms: termsById.get(row.id) ?? [],
    filePath,
    callersIn: await loadItems(callerIds),
    callsOut: await loadItems(calleeIds),
  };
}

// ── codeNeighborhood ──────────────────────────────────────────────────────────

/**
 * The file node + its declared items + one hop of code/calls edges in/out.
 */
export async function codeNeighborhood(fh: Freehold, path: string): Promise<CodeNeighborhood> {
  const fileView = await codeFile(fh, path);
  if (!fileView) return { nodes: [], edges: [] };

  const termsById = await queryTermsById(fh);
  const allEdges = await queryEdges(fh);

  // Collect node ids in the neighborhood
  const nodeIds = new Set<string>([fileView.nodeId]);
  for (const item of fileView.items) nodeIds.add(item.nodeId);

  // One hop of calls edges from/to declared items
  const neighborIds = new Set<string>();
  const includedEdges: EdgeRow[] = [];

  for (const e of allEdges) {
    const base = edgeBaseType(e.type);
    if (base === "declares" && e.from_id === fileView.nodeId) {
      includedEdges.push(e);
    } else if (base === "calls") {
      if (nodeIds.has(e.from_id)) {
        includedEdges.push(e);
        if (!nodeIds.has(e.to_id)) neighborIds.add(e.to_id);
      } else if (nodeIds.has(e.to_id)) {
        includedEdges.push(e);
        if (!nodeIds.has(e.from_id)) neighborIds.add(e.from_id);
      }
    }
  }

  // Load neighbor nodes
  const allNodeIds = new Set([...nodeIds, ...neighborIds]);
  const nodeMap = new Map<string, { id: string; label: string; type: string; terms: string[] }>();

  // File node
  nodeMap.set(fileView.nodeId, {
    id: fileView.nodeId,
    label: path,
    type: "code/SourceFile",
    terms: termsById.get(fileView.nodeId) ?? [],
  });

  // Declared items
  for (const item of fileView.items) {
    nodeMap.set(item.nodeId, {
      id: item.nodeId,
      label: item.name,
      type: item.type,
      terms: termsById.get(item.nodeId) ?? [],
    });
  }

  // Neighbor nodes not yet loaded
  const missingIds = [...neighborIds].filter((id) => !nodeMap.has(id));
  if (missingIds.length > 0) {
    const placeholders = missingIds.map((_, i) => `$${i + 2}`).join(", ");
    const r = await fh.db.pg.query<FunctionRow>(
      `SELECT id, type, content FROM objects
       WHERE graph_id = $1 AND kind = 'node' AND id IN (${placeholders})`,
      [fh.graphId, ...missingIds]
    );
    for (const row of r.rows) {
      const a = row.content?.attributes ?? {};
      nodeMap.set(row.id, {
        id: row.id,
        label: a.name ?? row.id,
        type: row.type,
        terms: termsById.get(row.id) ?? [],
      });
    }
  }

  return {
    nodes: Array.from(allNodeIds).flatMap((id) => {
      const node = nodeMap.get(id);
      return node ? [node] : [];
    }),
    edges: includedEdges.map((e) => ({
      id: e.id,
      from: e.from_id,
      to: e.to_id,
      type: e.type,
    })),
  };
}

// ── codeRegions ───────────────────────────────────────────────────────────────

// Module-level cache: one entry per graphId to prevent unbounded growth in long-running daemons.
// Each entry holds the last-seen (key, rules) pair; new keys (different logLength or repoName) overwrite.
const regionsCache = new Map<string, { key: string; rules: RegionRule[] }>();

/**
 * For each SourceFile path, call git_checklist via the wasm graph to determine
 * which policy rules match. Groups paths by rule and returns the result.
 *
 * Cached per (graphId, log length) so repeated calls for the same graph state
 * are free.
 *
 * @param repoName - The repository name passed to git_checklist (e.g. "allod").
 *   The API layer should resolve this from the graph entry basename or config.
 */
export async function codeRegions(fh: Freehold, repoName = "repo"): Promise<RegionRule[]> {
  // Determine the log head for cache key
  // log() exists on the wasm instance but is absent from the re-exported TS type
  const logLength = await withGraph(fh.graph, () => {
    const log = (fh.graph as unknown as { log(): unknown[] }).log();
    return Array.isArray(log) ? log.length : 0;
  });

  const cacheKey = `${fh.graphId}:${repoName}:${logLength}`;
  const cached = regionsCache.get(fh.graphId);
  if (cached && cached.key === cacheKey) return cached.rules;

  // Load all SourceFile paths
  const files = await querySourceFiles(fh);
  const paths = files
    .map((r) => r.content?.attributes?.path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  if (paths.length === 0) {
    regionsCache.set(fh.graphId, { key: cacheKey, rules: [] });
    return [];
  }

  // For each path call git_checklist and collect matched rules
  const ruleToInfo = new Map<string, { region?: string; reviewers: unknown; paths: string[] }>();

  for (const p of paths) {
    let matched: string[] = [];
    let checklistResult: unknown;
    try {
      checklistResult = await withGraph(fh.graph, () => {
        // git_checklist exists on the wasm instance but is missing from the re-exported TS type
        // NOTE: refs/heads/main is hardcoded; repos with a different default branch get incomplete regions.
        return (
          fh.graph as unknown as {
            git_checklist(
              repo: string,
              ref: string,
              ops: [string, string][]
            ): { matched: string[]; checklist: unknown[] };
          }
        ).git_checklist(repoName, "refs/heads/main", [["M", p]]);
      });
      const r = checklistResult as { matched?: unknown };
      if (Array.isArray(r?.matched)) {
        matched = r.matched.filter((x): x is string => typeof x === "string");
      }
    } catch (err: unknown) {
      // git_checklist throws "no policy" (or similar) when the graph has no
      // installed policy — that is expected and we skip silently. Any other
      // error indicates a broken policy or wasm fault and we surface it so
      // callers aren't silently handed an empty result.
      const msg = err instanceof Error ? err.message : String(err);
      if (/no.?policy/i.test(msg) || /not found/i.test(msg)) {
        continue;
      }
      throw err;
    }

    // Collect rule metadata from the checklist array
    const checklist: unknown[] = Array.isArray(
      (checklistResult as { checklist?: unknown })?.checklist
    )
      ? (checklistResult as { checklist: unknown[] }).checklist
      : [];

    for (const ruleName of matched) {
      if (!ruleToInfo.has(ruleName)) {
        // Find rule info from checklist entries
        const entry = checklist.find(
          (c) => c && typeof c === "object" && (c as Record<string, unknown>).name === ruleName
        ) as Record<string, unknown> | undefined;

        ruleToInfo.set(ruleName, {
          region: typeof entry?.region === "string" ? entry.region : undefined,
          reviewers: entry?.require ?? entry?.reviewers ?? null,
          paths: [],
        });
      }
      ruleToInfo.get(ruleName)?.paths.push(p);
    }
  }

  const result: RegionRule[] = Array.from(ruleToInfo.entries()).map(([rule, info]) => ({
    rule,
    region: info.region,
    reviewers: info.reviewers,
    paths: info.paths,
  }));

  regionsCache.set(fh.graphId, { key: cacheKey, rules: result });
  return result;
}
