/**
 * Deterministic force layout for the memory graph, with drill-down groups.
 *
 * Every type group renders as a folder node. Expanding a group replaces the
 * folder with an anchor plus its member nodes; edges re-attach to whichever
 * representative is visible (the member when expanded, the folder when not).
 *
 * Positions are computed synchronously with d3-force: seeded initial
 * positions derived from node ids (no randomness), a fixed tick count,
 * then the simulation is discarded. Same input, same layout.
 */

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { displayTypeName } from "./memoryTree";

export interface GraphNodeInput {
  id: string;
  type: string;
  title: string;
  approval: string;
}

export interface GraphEdgeInput {
  id: string;
  type: string;
  from: string;
  to: string;
}

export interface PositionedNode extends GraphNodeInput {
  x: number;
  y: number;
  /** Icon diameter in px */
  size: number;
  /** "group" folders toggle expansion; "member" nodes navigate */
  kind: "group" | "member";
  /** Display group (the tree folder name), drives color */
  group: string;
  /** Truncated title rendered under the icon; the full title lives in the hover card */
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

interface SimNode extends PositionedNode {
  index?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
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

export function groupNodeId(group: string): string {
  return `group:${group}`;
}

/**
 * Compute the visible graph for the given expansion state and lay it out.
 * Collapsed groups appear as one folder node sized by member count; edges
 * into a collapsed group attach to the folder.
 */
export function layoutGraph(
  nodes: GraphNodeInput[],
  edges: GraphEdgeInput[],
  opts: { expanded?: Set<string>; width?: number; height?: number } = {}
): LayoutResult {
  const { expanded = new Set<string>(), width = 900, height = 620 } = opts;

  const groups = new Map<string, GraphNodeInput[]>();
  for (const n of nodes) {
    const group = displayTypeName(n.type);
    const list = groups.get(group) ?? [];
    list.push(n);
    groups.set(group, list);
  }

  const inDegree = new Map<string, number>();
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const simNodes: SimNode[] = [];
  const visibleEdges: GraphEdgeInput[] = [];
  /** Node id → the id that represents it on screen. */
  const rep = new Map<string, string>();

  for (const [group, members] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const gid = groupNodeId(group);
    if (expanded.has(group)) {
      // Anchor folder + members around it
      const anchorSize = 26;
      simNodes.push({
        id: gid,
        type: "group",
        title: group,
        approval: "saved",
        group,
        kind: "group",
        count: members.length,
        size: anchorSize,
        label: group,
        footprint: nodeFootprint(group, anchorSize),
        ...seededPosition(gid, width, height, 180),
      });
      for (const m of members) {
        rep.set(m.id, m.id);
        const size = Math.min(40, Math.round(22 + 4 * Math.sqrt(inDegree.get(m.id) ?? 0)));
        const label = nodeLabel(m.title);
        simNodes.push({
          ...m,
          group,
          kind: "member",
          size,
          label,
          footprint: nodeFootprint(label, size),
          ...seededPosition(m.id, width, height, 240),
        });
        visibleEdges.push({ id: `${gid}->${m.id}`, type: "containment", from: gid, to: m.id });
      }
    } else {
      const size = Math.min(48, 30 + members.length * 2);
      simNodes.push({
        id: gid,
        type: "group",
        title: `${group} — ${members.length} item${members.length === 1 ? "" : "s"}`,
        approval: "saved",
        group,
        kind: "group",
        count: members.length,
        size,
        label: group,
        footprint: nodeFootprint(group, size),
        ...seededPosition(gid, width, height, 180),
      });
      for (const m of members) {
        rep.set(m.id, gid);
      }
    }
  }

  // Real edges re-attached to visible representatives; edges collapsing into
  // the same node disappear (they are inside a folder).
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

  const simEdges = visibleEdges.map((e) => ({ source: e.from, target: e.to }));

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simEdges)
        .id((d) => (d as SimNode).id)
        .distance((l) => {
          const t = l as unknown as { source: SimNode; target: SimNode };
          // Containment links stay tight; cross links stretch
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
      kind: n.kind,
      count: n.count,
      size: n.size,
      label: n.label,
      footprint: n.footprint,
      x: Math.round(n.x * 100) / 100,
      y: Math.round(n.y * 100) / 100,
    })),
    edges: visibleEdges,
  };
}
