import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graphLayout";

const nodes = [
  { id: "a", type: "memory/Note@1", title: "Note A", approval: "saved" },
  { id: "b", type: "memory/Note@1", title: "Note B", approval: "saved" },
  { id: "c", type: "claude-workspace/Colleague@1", title: "Sam", approval: "pending" },
];
const edges = [{ id: "e1", type: "memory/relates_to@1", from: "a", to: "b" }];

describe("layoutGraph", () => {
  it("is deterministic — same input, same positions", () => {
    const one = layoutGraph(nodes, edges);
    const two = layoutGraph(nodes, edges);
    expect(one).toEqual(two);
  });

  it("scales node size with incoming degree", () => {
    const manyIn = [
      ...edges,
      { id: "e2", type: "t", from: "c", to: "b" },
      { id: "e3", type: "t", from: "a", to: "b" },
    ];
    const { nodes: out } = layoutGraph(nodes, manyIn, { hubs: false });
    const a = out.find((n) => n.id === "a");
    const b = out.find((n) => n.id === "b");
    expect(b && a && b.size > a.size).toBe(true);
  });

  it("adds a hub per group with containment edges when enabled", () => {
    const { nodes: out, edges: outEdges } = layoutGraph(nodes, edges, { hubs: true });
    const hub = out.find((n) => n.id === "hub:Notes");
    expect(hub).toBeDefined();
    expect(hub?.hub).toBe(true);
    // Only one Colleague — no People hub for a single member
    expect(out.find((n) => n.id === "hub:People")).toBeUndefined();
    expect(outEdges.some((e) => e.from === "hub:Notes" && e.type === "containment")).toBe(true);
  });

  it("omits hubs when disabled", () => {
    const { nodes: out } = layoutGraph(nodes, edges, { hubs: false });
    expect(out.some((n) => n.hub)).toBe(false);
  });

  it("keeps approval on positioned nodes", () => {
    const { nodes: out } = layoutGraph(nodes, edges, { hubs: false });
    expect(out.find((n) => n.id === "c")?.approval).toBe("pending");
  });
});
