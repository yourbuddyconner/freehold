/**
 * Deterministic force layout for the memory graph.
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
  /** Diameter in px, scaled by incoming degree */
  size: number;
  /** True for synthetic type-hub nodes */
  hub: boolean;
  /** Display group (the tree folder name), drives color */
  group: string;
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

const TICKS = 200;

interface SimNode extends PositionedNode {
  index?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

/**
 * Compute positions for the graph. With `hubs`, a synthetic node per type
 * group is added with containment edges so sparse graphs still cluster.
 */
export function layoutGraph(
  nodes: GraphNodeInput[],
  edges: GraphEdgeInput[],
  opts: { hubs?: boolean; width?: number; height?: number } = {}
): LayoutResult {
  const { hubs = true, width = 900, height = 620 } = opts;

  const inDegree = new Map<string, number>();
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    inDegree.set(e.from, inDegree.get(e.from) ?? 0);
  }

  const simNodes: SimNode[] = nodes.map((n) => {
    const deg = inDegree.get(n.id) ?? 0;
    const seed = hash(n.id);
    const angle = ((seed % 3600) / 3600) * 2 * Math.PI;
    const radius = 60 + (seed % 240);
    return {
      ...n,
      group: displayTypeName(n.type),
      hub: false,
      size: Math.min(26, Math.round(9 + 3.4 * Math.sqrt(deg))),
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    };
  });

  const simEdges: Array<{ source: string; target: string }> = edges.map((e) => ({
    source: e.from,
    target: e.to,
  }));
  const allEdges: GraphEdgeInput[] = [...edges];

  if (hubs) {
    const groups = new Map<string, SimNode[]>();
    for (const n of simNodes) {
      const list = groups.get(n.group) ?? [];
      list.push(n);
      groups.set(n.group, list);
    }
    for (const [group, members] of groups) {
      if (members.length < 2) continue;
      const hubId = `hub:${group}`;
      const seed = hash(hubId);
      const angle = ((seed % 3600) / 3600) * 2 * Math.PI;
      simNodes.push({
        id: hubId,
        type: "hub",
        title: group,
        approval: "saved",
        group,
        hub: true,
        size: 18,
        x: width / 2 + Math.cos(angle) * 150,
        y: height / 2 + Math.sin(angle) * 150,
      });
      for (const member of members) {
        simEdges.push({ source: hubId, target: member.id });
        allEdges.push({
          id: `${hubId}->${member.id}`,
          type: "containment",
          from: hubId,
          to: member.id,
        });
      }
    }
  }

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simEdges)
        .id((d) => (d as SimNode).id)
        .distance(70)
        .strength(0.4)
    )
    .force("charge", forceManyBody().strength(-120))
    .force("x", forceX(width / 2).strength(0.05))
    .force("y", forceY(height / 2).strength(0.05))
    .force(
      "collide",
      forceCollide<SimNode>().radius((d) => d.size / 2 + 18)
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
      hub: n.hub,
      size: n.size,
      x: Math.round(n.x * 100) / 100,
      y: Math.round(n.y * 100) / 100,
    })),
    edges: allEdges,
  };
}
