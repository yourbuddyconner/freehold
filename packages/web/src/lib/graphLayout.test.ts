import { describe, expect, it } from "vitest";
import { groupNodeId, layoutGraph } from "./graphLayout";

const nodes = [
  { id: "a", type: "memory/Note@1", title: "Note A", approval: "saved" },
  { id: "b", type: "memory/Note@1", title: "Note B", approval: "saved" },
  { id: "c", type: "claude-workspace/Colleague@1", title: "Sam", approval: "pending" },
];
const edges = [{ id: "e1", type: "memory/relates_to@1", from: "c", to: "b" }];

describe("layoutGraph", () => {
  it("is deterministic — same input, same positions", () => {
    const one = layoutGraph(nodes, edges, { expanded: new Set(["Notes"]) });
    const two = layoutGraph(nodes, edges, { expanded: new Set(["Notes"]) });
    expect(one).toEqual(two);
  });

  it("collapsed groups render as one folder node with a count", () => {
    const { nodes: out } = layoutGraph(nodes, edges);
    expect(out.length).toBe(2); // Notes folder + People folder
    const notesFolder = out.find((n) => n.id === groupNodeId("Notes"));
    expect(notesFolder?.kind).toBe("group");
    expect(notesFolder?.count).toBe(2);
  });

  it("cross-group edges attach to the collapsed folder", () => {
    const { edges: out } = layoutGraph(nodes, edges);
    const e = out.find((x) => x.type === "memory/relates_to@1");
    expect(e?.from).toBe(groupNodeId("People"));
    expect(e?.to).toBe(groupNodeId("Notes"));
  });

  it("expanding a group shows its members with containment edges to the anchor", () => {
    const { nodes: out, edges: outEdges } = layoutGraph(nodes, edges, {
      expanded: new Set(["Notes"]),
    });
    expect(out.some((n) => n.id === "a")).toBe(true);
    expect(out.some((n) => n.id === "b")).toBe(true);
    // People stays collapsed
    expect(out.some((n) => n.id === "c")).toBe(false);
    const containment = outEdges.filter((e) => e.type === "containment");
    expect(containment.length).toBe(2);
    // The real edge now lands on the expanded member
    const real = outEdges.find((e) => e.type === "memory/relates_to@1");
    expect(real?.from).toBe(groupNodeId("People"));
    expect(real?.to).toBe("b");
  });

  it("edges inside one collapsed folder disappear", () => {
    const internal = [{ id: "e2", type: "memory/relates_to@1", from: "a", to: "b" }];
    const { edges: out } = layoutGraph(nodes, internal);
    expect(out.some((e) => e.type === "memory/relates_to@1")).toBe(false);
  });

  it("keeps approval on expanded members", () => {
    const { nodes: out } = layoutGraph(nodes, edges, { expanded: new Set(["People"]) });
    expect(out.find((n) => n.id === "c")?.approval).toBe("pending");
  });
});
