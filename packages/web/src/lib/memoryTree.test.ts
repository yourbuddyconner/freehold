import { describe, expect, it } from "vitest";
import { buildMemoryTree, displayTypeName, treeToPaths } from "./memoryTree";

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

  it("nests items by hierarchical terms inside the type folder", () => {
    const tree = buildMemoryTree([
      entry({ id: "a", terms: ["projects/agent-auth@1", "workspace/scratch@1"] }),
      entry({ id: "b", terms: ["projects@1"] }),
      entry({ id: "c", terms: [] }),
    ]);
    const notes = tree[0];
    // c has no filing term — sits directly under Notes (after folders)
    const looseIds = notes.children.filter((n) => n.kind === "leaf").map((n) => n.entry.id);
    expect(looseIds).toEqual(["c"]);
    const projects = notes.children.find((n) => n.kind === "folder" && n.label === "projects");
    expect(projects?.kind).toBe("folder");
    if (projects?.kind !== "folder") return;
    expect(projects.count).toBe(2);
    // b files at projects/, a nests one level deeper
    expect(projects.children.some((n) => n.kind === "leaf" && n.entry.id === "b")).toBe(true);
    const agentAuth = projects.children.find(
      (n) => n.kind === "folder" && n.label === "agent-auth"
    );
    if (agentAuth?.kind !== "folder") throw new Error("missing nested folder");
    expect(agentAuth.children.some((n) => n.kind === "leaf" && n.entry.id === "a")).toBe(true);
  });

  it("status namespaces never become folders", () => {
    const tree = buildMemoryTree([
      entry({ id: "s", terms: ["workspace/scratch@1", "sensitivity/private@1"] }),
    ]);
    expect(tree[0].children.every((n) => n.kind === "leaf")).toBe(true);
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

describe("treeToPaths", () => {
  function leafEntry(over: Partial<Parameters<typeof buildMemoryTree>[0][number]> = {}) {
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

  it("produces synthetic paths <TypeFolder>/<Title> for top-level leaves", () => {
    const folders = buildMemoryTree([leafEntry({ id: "n1", title: "My Note" })]);
    const { paths } = treeToPaths(folders);
    expect(paths).toContain("Notes/My Note");
  });

  it("maps every leaf path to its memory id in idByPath", () => {
    const folders = buildMemoryTree([leafEntry({ id: "abc", title: "My Note" })]);
    const { idByPath } = treeToPaths(folders);
    expect(idByPath.get("Notes/My Note")).toBe("abc");
  });

  it("produces paths <TypeFolder>/<TermFolder>/<Title> for nested leaves", () => {
    const folders = buildMemoryTree([
      leafEntry({ id: "n1", title: "Agent Auth Note", terms: ["projects/agent-auth@1"] }),
    ]);
    const { paths, idByPath } = treeToPaths(folders);
    expect(paths).toContain("Notes/projects/agent-auth/Agent Auth Note");
    expect(idByPath.get("Notes/projects/agent-auth/Agent Auth Note")).toBe("n1");
  });

  it("includes directory paths for intermediate folders", () => {
    const folders = buildMemoryTree([
      leafEntry({ id: "n1", title: "Item", terms: ["projects@1"] }),
    ]);
    const { paths } = treeToPaths(folders);
    expect(paths).toContain("Notes/");
    expect(paths).toContain("Notes/projects/");
  });

  it("deduplicates titles within the same folder by appending (2), (3) suffixes in path only", () => {
    const folders = buildMemoryTree([
      leafEntry({ id: "a", title: "Same Title", updatedAt: "2026-08-04T12:00:00.000Z" }),
      leafEntry({ id: "b", title: "Same Title", updatedAt: "2026-08-04T11:00:00.000Z" }),
      leafEntry({ id: "c", title: "Same Title", updatedAt: "2026-08-04T10:00:00.000Z" }),
    ]);
    const { paths, idByPath } = treeToPaths(folders);
    expect(paths).toContain("Notes/Same Title");
    expect(paths).toContain("Notes/Same Title (2)");
    expect(paths).toContain("Notes/Same Title (3)");
    // idByPath covers all three
    expect(idByPath.get("Notes/Same Title")).toBe("a");
    expect(idByPath.get("Notes/Same Title (2)")).toBe("b");
    expect(idByPath.get("Notes/Same Title (3)")).toBe("c");
  });

  it("sanitizes forward slashes in titles to U+2215 division slash", () => {
    const folders = buildMemoryTree([leafEntry({ id: "n1", title: "2026/08/04" })]);
    const { paths, idByPath } = treeToPaths(folders);
    const sanitized = "Notes/2026∕08∕04";
    expect(paths).toContain(sanitized);
    expect(idByPath.get(sanitized)).toBe("n1");
  });

  it("returns empty paths and empty idByPath for empty folder list", () => {
    const { paths, idByPath } = treeToPaths([]);
    expect(paths).toEqual([]);
    expect(idByPath.size).toBe(0);
  });

  it("suffix disambiguation is per-folder, not global", () => {
    // Two different type folders can both have a leaf titled "Foo" without conflict
    const folders = buildMemoryTree([
      leafEntry({ id: "n1", title: "Foo" }),
      leafEntry({ id: "p1", type: "memory/Person@1", title: "Foo" }),
    ]);
    const { paths } = treeToPaths(folders);
    // Notes/Foo and People/Foo should both exist without (2) suffix
    expect(paths).toContain("Notes/Foo");
    expect(paths).toContain("People/Foo");
    // Neither gets a (2) suffix since they are in different folders
    expect(paths).not.toContain("Notes/Foo (2)");
    expect(paths).not.toContain("People/Foo (2)");
  });
});
