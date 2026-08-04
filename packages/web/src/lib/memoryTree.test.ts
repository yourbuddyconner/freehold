import { describe, expect, it } from "vitest";
import { buildMemoryTree, displayTypeName } from "./memoryTree";

function entry(over: Partial<Parameters<typeof buildMemoryTree>[0][number]> = {}) {
  return {
    id: "id-1",
    type: "memory/Note@1",
    title: "A note",
    approval: "saved",
    author: "claude",
    updatedAt: "2026-08-04T10:00:00.000Z",
    terms: [],
    ...over,
  };
}

describe("displayTypeName", () => {
  it("maps known type leaves to display names", () => {
    expect(displayTypeName("memory/Note@1")).toBe("Notes");
    expect(displayTypeName("claude-workspace/Colleague@1")).toBe("People");
    expect(displayTypeName("memory/Preference@1")).toBe("Preferences");
    expect(displayTypeName("core/Agent@1")).toBe("Agents");
  });

  it("pluralizes unknown types", () => {
    expect(displayTypeName("x/Widget@1")).toBe("Widgets");
    expect(displayTypeName("x/Boss@2")).toBe("Bosss".replace("sss", "ss")); // already ends in s
  });
});

describe("buildMemoryTree", () => {
  it("returns empty for no entries", () => {
    expect(buildMemoryTree([])).toEqual([]);
  });

  it("groups by display name and sorts folders alphabetically", () => {
    const tree = buildMemoryTree([
      entry({ id: "n1" }),
      entry({ id: "p1", type: "claude-workspace/Colleague@1", title: "Sam" }),
      entry({ id: "n2", title: "Second note" }),
    ]);
    expect(tree.map((f) => f.label)).toEqual(["Notes", "People"]);
    expect(tree[0].count).toBe(2);
    expect(tree[1].count).toBe(1);
  });

  it("sorts leaves newest first", () => {
    const tree = buildMemoryTree([
      entry({ id: "old", updatedAt: "2026-08-01T00:00:00.000Z" }),
      entry({ id: "new", updatedAt: "2026-08-04T00:00:00.000Z" }),
    ]);
    const ids = tree[0].children.map((c) => (c.kind === "leaf" ? c.entry.id : ""));
    expect(ids).toEqual(["new", "old"]);
  });

  it("keeps pending entries in place with their approval", () => {
    const tree = buildMemoryTree([entry({ id: "p", approval: "pending" })]);
    const leaf = tree[0].children[0];
    expect(leaf.kind).toBe("leaf");
    if (leaf.kind === "leaf") expect(leaf.entry.approval).toBe("pending");
  });

  it("merges types sharing a display name into one folder", () => {
    const tree = buildMemoryTree([
      entry({ id: "a", type: "memory/Person@1" }),
      entry({ id: "b", type: "claude-workspace/Colleague@1" }),
    ]);
    expect(tree.length).toBe(1);
    expect(tree[0].label).toBe("People");
    expect(tree[0].count).toBe(2);
  });
});
