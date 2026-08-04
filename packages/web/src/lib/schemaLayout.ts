/**
 * Layered tree layout for the ontology map.
 *
 * Entity types form an inheritance forest via `extends`; each type sits one
 * row below its parent, children centered under it. Edge types draw as
 * labeled relation edges between their domain and range types. Pure and
 * deterministic — no simulation.
 */

export interface SchemaTypeInput {
  name: string;
  package?: string;
  extends?: string;
  attributes?: Record<string, unknown>;
}

export interface SchemaEdgeTypeInput {
  name: string;
  domain?: string;
  range?: string;
}

export interface SchemaNode {
  id: string;
  name: string;
  /** Leaf name without the package prefix */
  shortName: string;
  package: string;
  extends?: string;
  attrCount: number;
  pending: boolean;
  x: number;
  y: number;
  width: number;
}

export interface SchemaEdge {
  id: string;
  kind: "extends" | "relation";
  label?: string;
  from: string;
  to: string;
}

export interface SchemaLayout {
  nodes: SchemaNode[];
  edges: SchemaEdge[];
}

const NODE_H = 46;
const ROW_GAP = 70;
const COL_GAP = 24;

function nodeWidth(shortName: string): number {
  return Math.max(110, shortName.length * 7.5 + 36);
}

function shortName(typeRef: string): string {
  return typeRef.split("/").pop() ?? typeRef;
}

/**
 * Compute positions for the ontology map. Roots (types whose parent is
 * absent from the set) sort alphabetically; each subtree is centered over
 * the space its descendants need.
 */
export function layoutSchema(
  types: SchemaTypeInput[],
  edgeTypes: SchemaEdgeTypeInput[],
  pendingNames: Set<string> = new Set()
): SchemaLayout {
  const byName = new Map(types.map((t) => [t.name, t]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const t of [...types].sort((a, b) => a.name.localeCompare(b.name))) {
    if (t.extends && byName.has(t.extends)) {
      const list = children.get(t.extends) ?? [];
      list.push(t.name);
      children.set(t.extends, list);
    } else {
      roots.push(t.name);
    }
  }

  // Width of the subtree rooted at each node
  const subtreeWidth = new Map<string, number>();
  function measure(name: string): number {
    const own = nodeWidth(shortName(name));
    const kids = children.get(name) ?? [];
    const kidsWidth =
      kids.reduce((sum, k) => sum + measure(k), 0) + COL_GAP * Math.max(0, kids.length - 1);
    const w = Math.max(own, kidsWidth);
    subtreeWidth.set(name, w);
    return w;
  }
  for (const r of roots) measure(r);

  const nodes: SchemaNode[] = [];
  function place(name: string, left: number, depth: number) {
    const t = byName.get(name);
    if (!t) return;
    const w = subtreeWidth.get(name) ?? nodeWidth(shortName(name));
    const own = nodeWidth(shortName(name));
    nodes.push({
      id: name,
      name,
      shortName: shortName(name),
      package: t.package ?? name.split("/")[0],
      extends: t.extends,
      attrCount: Object.keys(t.attributes ?? {}).length,
      pending: pendingNames.has(name),
      x: left + w / 2 - own / 2,
      y: depth * (NODE_H + ROW_GAP),
      width: own,
    });
    let childLeft = left;
    for (const kid of children.get(name) ?? []) {
      place(kid, childLeft, depth + 1);
      childLeft += (subtreeWidth.get(kid) ?? 0) + COL_GAP;
    }
  }

  let rootLeft = 0;
  for (const r of roots) {
    place(r, rootLeft, 0);
    rootLeft += (subtreeWidth.get(r) ?? 0) + COL_GAP * 2;
  }

  const edges: SchemaEdge[] = [];
  for (const t of types) {
    if (t.extends && byName.has(t.extends)) {
      edges.push({ id: `x:${t.name}`, kind: "extends", from: t.name, to: t.extends });
    }
  }
  for (const e of edgeTypes) {
    if (e.domain && e.range && byName.has(e.domain) && byName.has(e.range)) {
      edges.push({
        id: `r:${e.name}`,
        kind: "relation",
        label: shortName(e.name),
        from: e.domain,
        to: e.range,
      });
    }
  }

  return { nodes, edges };
}

export { shortName as schemaShortName, NODE_H as SCHEMA_NODE_H };
