import { describe, expect, it } from "vitest";
import { groupNodeId, layoutGraph, pathOf } from "./graphLayout";

const nodes = [
  {
    id: "a",
    type: "memory/Note@1",
    title: "Valet plan",
    approval: "saved",
    terms: ["projects/valet@1", "workspace/scratch@1"],
  },
  {
    id: "b",
    type: "memory/Note@1",
    title: "Journal entry",
    approval: "saved",
    terms: ["journal@1"],
  },
  {
    id: "c",
    type: "claude-workspace/Colleague@1",
    title: "Sam",
    approval: "pending",
    terms: [],
  },
];
const edges = [{ id: "e1", type: "memory/relates_to@1", from: "c", to: "a" }];

describe("pathOf", () => {
  it("files nodes by type group then folder-term segments", () => {
    expect(pathOf(nodes[0])).toEqual(["Notes", "projects", "valet"]);
    expect(pathOf(nodes[1])).toEqual(["Notes", "journal"]);
    expect(pathOf(nodes[2])).toEqual(["People"]);
  });
});

describe("layoutGraph", () => {
  it("is deterministic — same input, same positions", () => {
    const one = layoutGraph(nodes, edges, { expanded: new Set(["Notes"]) });
    const two = layoutGraph(nodes, edges, { expanded: new Set(["Notes"]) });
    expect(one).toEqual(two);
  });

  it("fully collapsed shows one folder per type group", () => {
    const { nodes: out } = layoutGraph(nodes, edges);
    expect(out.map((n) => n.id).sort()).toEqual([groupNodeId("Notes"), groupNodeId("People")]);
    expect(out.find((n) => n.id === groupNodeId("Notes"))?.count).toBe(2);
  });

  it("expanding a type group reveals term subfolders, not members", () => {
    const { nodes: out } = layoutGraph(nodes, edges, { expanded: new Set(["Notes"]) });
    const ids = out.map((n) => n.id);
    // Anchor for Notes plus its two subfolders; members stay hidden
    expect(ids).toContain(groupNodeId("Notes"));
    expect(ids).toContain(groupNodeId("Notes/projects"));
    expect(ids).toContain(groupNodeId("Notes/journal"));
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
    const projects = out.find((n) => n.id === groupNodeId("Notes/projects"));
    expect(projects?.count).toBe(1);
    expect(projects?.expandedAnchor).toBe(false);
    expect(out.find((n) => n.id === groupNodeId("Notes"))?.expandedAnchor).toBe(true);
  });

  it("walking the full path reveals the member", () => {
    const { nodes: out, edges: outEdges } = layoutGraph(nodes, edges, {
      expanded: new Set(["Notes", "Notes/projects", "Notes/projects/valet"]),
    });
    const ids = out.map((n) => n.id);
    expect(ids).toContain("a");
    // Containment chain: Notes → projects → valet → a
    expect(outEdges.some((e) => e.type === "containment" && e.to === "a")).toBe(true);
    // The real edge attaches from the collapsed People folder to the member
    const real = outEdges.find((e) => e.type === "memory/relates_to@1");
    expect(real?.from).toBe(groupNodeId("People"));
    expect(real?.to).toBe("a");
  });

  it("edges inside one collapsed folder disappear", () => {
    const internal = [{ id: "e2", type: "memory/relates_to@1", from: "a", to: "b" }];
    const { edges: out } = layoutGraph(nodes, internal);
    expect(out.some((e) => e.type === "memory/relates_to@1")).toBe(false);
  });

  it("collapsed-folder edges aggregate across the hierarchy", () => {
    const { edges: out } = layoutGraph(nodes, edges);
    const real = out.find((e) => e.type === "memory/relates_to@1");
    expect(real?.from).toBe(groupNodeId("People"));
    expect(real?.to).toBe(groupNodeId("Notes"));
  });
});
