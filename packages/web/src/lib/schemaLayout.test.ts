import { describe, expect, it } from "vitest";
import { layoutSchema } from "./schemaLayout";

const types = [
  { name: "core/Person", package: "core", attributes: { name: { type: "string" } } },
  {
    name: "claude-workspace/Colleague",
    package: "claude-workspace",
    extends: "core/Person",
    attributes: { name: {}, emails: {} },
  },
  { name: "memory/Note", package: "memory", attributes: { content: {} } },
];
const edgeTypes = [
  {
    name: "claude-workspace/mentioned_in",
    domain: "claude-workspace/Colleague",
    range: "memory/Note",
  },
  { name: "memory/dangling", domain: "memory/Missing", range: "memory/Note" },
];

describe("layoutSchema", () => {
  it("is deterministic", () => {
    expect(layoutSchema(types, edgeTypes)).toEqual(layoutSchema(types, edgeTypes));
  });

  it("children sit one row below their parent", () => {
    const { nodes } = layoutSchema(types, edgeTypes);
    const person = nodes.find((n) => n.id === "core/Person");
    const colleague = nodes.find((n) => n.id === "claude-workspace/Colleague");
    expect(person?.y).toBe(0);
    expect(colleague && person && colleague.y > person.y).toBe(true);
  });

  it("emits extends edges child→parent and relation edges with labels", () => {
    const { edges } = layoutSchema(types, edgeTypes);
    const ext = edges.find((e) => e.kind === "extends");
    expect(ext?.from).toBe("claude-workspace/Colleague");
    expect(ext?.to).toBe("core/Person");
    const rel = edges.find((e) => e.kind === "relation");
    expect(rel?.label).toBe("mentioned_in");
    expect(rel?.from).toBe("claude-workspace/Colleague");
  });

  it("drops relation edges whose endpoints are not in the type set", () => {
    const { edges } = layoutSchema(types, edgeTypes);
    expect(edges.some((e) => e.id === "r:memory/dangling")).toBe(false);
  });

  it("marks pending types", () => {
    const { nodes } = layoutSchema(types, [], new Set(["memory/Note"]));
    expect(nodes.find((n) => n.id === "memory/Note")?.pending).toBe(true);
  });

  it("nodes do not overlap horizontally within a row", () => {
    const { nodes } = layoutSchema(types, []);
    const byRow = new Map<number, typeof nodes>();
    for (const n of nodes) {
      const row = byRow.get(n.y) ?? [];
      row.push(n);
      byRow.set(n.y, row);
    }
    for (const row of byRow.values()) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].width);
      }
    }
  });
});
