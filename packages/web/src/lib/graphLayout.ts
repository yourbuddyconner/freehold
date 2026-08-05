/**
 * Deterministic force layout for the memory graph, with drill-down that
 * walks the taxonomy.
 *
 * Every node has a filing path: its type group, then its folder-term
 * segments — a note classified `projects/valet` lives at
 * Notes/projects/valet. Collapsed folders render as one node sized by
 * member count; expanding a folder replaces it with an anchor plus its
 * immediate children (subfolders or members). Edges re-attach to whichever
 * representative is visible; edges entirely inside one collapsed folder
 * disappear.
 *
 * Positions are computed synchronously with d3-force: seeded initial
 * positions derived from node ids (no randomness), a fixed tick count,
 * then the simulation is discarded. Same input, same layout.
 */

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { displayTypeName, folderTermFromTerms } from "./memoryTree";

export interface GraphNodeInput {
  id: string;
  type: string;
  title: string;
  approval: string;
  terms?: string[];
}

export interface GraphEdgeInput {
  id: string;
  type: string;
  from: string;
  to: string;
}

export interface PositionedNode {
  id: string;
  type: string;
  title: string;
  approval: string;
  x: number;
  y: number;
  /** Icon diameter in px */
  size: number;
  /** "group" folders toggle expansion; "member" nodes navigate */
  kind: "group" | "member";
  /** Top path segment (the type group) — drives color */
  group: string;
  /** Full filing path for group nodes ("Notes/projects"); member path prefix */
  path: string;
  /** True for the anchor of an expanded folder */
  expandedAnchor: boolean;
  /** Truncated title rendered under the icon */
  label: string;
  /** Half-width in px of the icon + label footprint — what collision reserved */
  footprint: number;
  /** Member count, set on group nodes */
  count?: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: GraphEdgeInput[];
}

/** DJB2 — stable numeric hash for seeding positions from ids. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

const TICKS = 250;
const LABEL_MAX_CHARS = 22;
/** Approximate px per character at the node label's 10px size. */
const LABEL_CHAR_W = 6.1;

/** Short label under the icon; the hover card carries the full title. */
export function nodeLabel(title: string): string {
  const flat = title.trim().split("\n")[0];
  return flat.length > LABEL_MAX_CHARS ? `${flat.slice(0, LABEL_MAX_CHARS - 1)}…` : flat;
}

/**
 * Half-width of a node's rendered footprint: the label extends horizontally
 * under the icon, so collision must reserve label width, not icon width.
 */
export function nodeFootprint(label: string, iconSize: number): number {
  return Math.max(iconSize / 2, (label.length * LABEL_CHAR_W) / 2) + 10;
}

function seededPosition(id: string, width: number, height: number, spread: number) {
  const seed = hash(id);
  const angle = ((seed % 3600) / 3600) * 2 * Math.PI;
  const radius = 60 + (seed % spread);
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
  };
}

export function groupNodeId(path: string): string {
  return `group:${path}`;
}

/** The filing path segments for a node: type group, then folder-term segments. */
export function pathOf(node: GraphNodeInput): string[] {
  const segments = [displayTypeName(node.type)];
  const term = folderTermFromTerms(node.terms ?? []);
  if (term) segments.push(...term.split("/"));
  return segments;
}

interface SimNode extends PositionedNode {
  index?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

/**
 * Compute the visible graph for the given expansion state and lay it out.
 * `expanded` holds folder paths ("Notes", "Notes/projects"); a node is
 * visible when every prefix of its path is expanded, otherwise its first
 * collapsed prefix stands in for it.
 */
export function layoutGraph(
  nodes: GraphNodeInput[],
  edges: GraphEdgeInput[],
  opts: { expanded?: Set<string>; width?: number; height?: number } = {}
): LayoutResult {
  const { expanded = new Set<string>(), width = 900, height = 620 } = opts;

  const inDegree = new Map<string, number>();
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  // Collapsed folder path → member count; member id → its full path
  const collapsedCounts = new Map<string, number>();
  const collapsedGroup = new Map<string, string>();
  /** Node id → visible representative id */
  const rep = new Map<string, string>();
  const visibleMembers: GraphNodeInput[] = [];
  const memberPath = new Map<string, string>();

  for (const n of nodes) {
    const segments = pathOf(n);
    let repPath: string | null = null;
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      if (!expanded.has(prefix)) {
        repPath = prefix;
        break;
      }
    }
    if (repPath) {
      rep.set(n.id, groupNodeId(repPath));
      collapsedCounts.set(repPath, (collapsedCounts.get(repPath) ?? 0) + 1);
      collapsedGroup.set(repPath, segments[0]);
    } else {
      rep.set(n.id, n.id);
      visibleMembers.push(n);
      memberPath.set(n.id, segments.join("/"));
    }
  }

  const simNodes: SimNode[] = [];
  const visibleEdges: GraphEdgeInput[] = [];
  const anchorPaths = new Set<string>();

  function parentOf(path: string): string | null {
    const idx = path.lastIndexOf("/");
    return idx >= 0 ? path.slice(0, idx) : null;
  }

  // Collapsed folder nodes
  for (const [path, count] of [...collapsedCounts.entries()].sort()) {
    const label = path.split("/").pop() ?? path;
    const size = Math.min(48, 30 + count * 2);
    simNodes.push({
      id: groupNodeId(path),
      type: "group",
      title: `${label} — ${count} item${count === 1 ? "" : "s"}`,
      approval: "saved",
      group: collapsedGroup.get(path) ?? label,
      path,
      kind: "group",
      expandedAnchor: false,
      count,
      size,
      label,
      footprint: nodeFootprint(label, size),
      ...seededPosition(path, width, height, 200),
    });
    const parent = parentOf(path);
    if (parent) anchorPaths.add(parent);
  }

  // Visible member nodes
  for (const m of visibleMembers) {
    const size = Math.min(40, Math.round(22 + 4 * Math.sqrt(inDegree.get(m.id) ?? 0)));
    const label = nodeLabel(m.title);
    simNodes.push({
      id: m.id,
      type: m.type,
      title: m.title,
      approval: m.approval,
      group: pathOf(m)[0],
      path: memberPath.get(m.id) ?? "",
      kind: "member",
      expandedAnchor: false,
      size,
      label,
      footprint: nodeFootprint(label, size),
      ...seededPosition(m.id, width, height, 240),
    });
    anchorPaths.add(memberPath.get(m.id) ?? "");
  }

  // Anchors for expanded folders that have visible children; walk parents up
  for (const p of [...anchorPaths]) {
    let cur: string | null = p;
    while (cur) {
      anchorPaths.add(cur);
      cur = parentOf(cur);
    }
  }
  for (const path of [...anchorPaths].sort()) {
    if (!expanded.has(path)) continue;
    const label = path.split("/").pop() ?? path;
    simNodes.push({
      id: groupNodeId(path),
      type: "group",
      title: label,
      approval: "saved",
      group: path.split("/")[0],
      path,
      kind: "group",
      expandedAnchor: true,
      size: 26,
      label,
      footprint: nodeFootprint(label, 26),
      ...seededPosition(path, width, height, 160),
    });
  }
  const simIds = new Set(simNodes.map((n) => n.id));

  // Containment: parent anchor → child folder/anchor/member
  for (const n of simNodes) {
    const parent = n.kind === "member" ? n.path : parentOf(n.path);
    if (!parent) continue;
    const parentId = groupNodeId(parent);
    if (parentId === n.id || !simIds.has(parentId)) continue;
    visibleEdges.push({
      id: `${parentId}->${n.id}`,
      type: "containment",
      from: parentId,
      to: n.id,
    });
  }

  // Real edges re-attached to visible representatives
  const seen = new Set<string>();
  for (const e of edges) {
    const from = rep.get(e.from);
    const to = rep.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}:${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    visibleEdges.push({ id: e.id, type: e.type, from, to });
  }

  const simEdges = visibleEdges
    .filter((e) => simIds.has(e.from) && simIds.has(e.to))
    .map((e) => ({ source: e.from, target: e.to }));

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simEdges)
        .id((d) => (d as SimNode).id)
        .distance((l) => {
          const t = l as unknown as { source: SimNode; target: SimNode };
          return t.source.kind === "group" || t.target.kind === "group" ? 90 : 130;
        })
        .strength(0.5)
    )
    .force("charge", forceManyBody().strength(-260))
    .force("x", forceX(width / 2).strength(0.06))
    .force("y", forceY(height / 2).strength(0.06))
    .force(
      "collide",
      forceCollide<SimNode>()
        .radius((d) => d.footprint + 12)
        .strength(0.9)
        .iterations(2)
    )
    .stop();

  for (let i = 0; i < TICKS; i++) {
    sim.tick();
  }

  return {
    nodes: simNodes.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      approval: n.approval,
      group: n.group,
      path: n.path,
      kind: n.kind,
      expandedAnchor: n.expandedAnchor,
      count: n.count,
      size: n.size,
      label: n.label,
      footprint: n.footprint,
      x: Math.round(n.x * 100) / 100,
      y: Math.round(n.y * 100) / 100,
    })),
    edges: visibleEdges.filter((e) => simIds.has(e.from) && simIds.has(e.to)),
  };
}
