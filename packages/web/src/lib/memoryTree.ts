/**
 * Tree derivation for the Memory workspace.
 *
 * Top-level folders come from root entity types (People, Notes, …). Inside
 * a type folder, items nest by their hierarchical taxonomy terms — a note
 * classified `projects/agent-auth` files under Notes → projects →
 * agent-auth. Terms in status namespaces (workspace/*, sensitivity/*) are
 * labels, never folders. Pure functions — the server ships a flat listing,
 * the client owns shape.
 */

import type { MemoryIndexEntry } from "@freehold/client";

export interface TreeFolder {
  kind: "folder";
  label: string;
  /** Stable identity for open-state persistence, e.g. "Notes/projects/agent-auth" */
  id: string;
  children: TreeNode[];
  /** Leaf count including nested folders */
  count: number;
}

export interface TreeLeaf {
  kind: "leaf";
  entry: MemoryIndexEntry;
}

export type TreeNode = TreeFolder | TreeLeaf;

/** Display names for known type paths; fallback pluralizes the bare name. */
const DISPLAY_NAMES: Record<string, string> = {
  Note: "Notes",
  Document: "Documents",
  Event: "Events",
  Preference: "Preferences",
  Person: "People",
  Colleague: "People",
  Entity: "Entities",
  Agent: "Agents",
  User: "Users",
};

/** "memory/Note@1" → "Notes"; "claude-workspace/Colleague@1" → "People". */
export function displayTypeName(typeRef: string): string {
  const bare = typeRef.split("@")[0];
  const leaf = bare.split("/").pop() ?? bare;
  const known = DISPLAY_NAMES[leaf];
  if (known) return known;
  const capped = leaf.charAt(0).toUpperCase() + leaf.slice(1);
  return capped.endsWith("s") ? capped : `${capped}s`;
}

/** Term namespaces that are statuses, not places — never folders. */
const STATUS_NAMESPACES = new Set(["workspace", "sensitivity"]);

/**
 * The term that files this entry into a folder: the deepest classification
 * outside the status namespaces, without its version suffix. Undefined when
 * the entry has no filing term — it sits directly in its type folder.
 */
export function folderTermOf(entry: MemoryIndexEntry): string | undefined {
  const qualifying = entry.terms
    .map((t) => t.split("@")[0])
    .filter((t) => !STATUS_NAMESPACES.has(t.split("/")[0]));
  if (qualifying.length === 0) return undefined;
  qualifying.sort(
    (a, b) => b.split("/").length - a.split("/").length || b.length - a.length || a.localeCompare(b)
  );
  return qualifying[0];
}

function leafCompare(a: TreeLeaf, b: TreeLeaf): number {
  // Newest first
  return b.entry.updatedAt.localeCompare(a.entry.updatedAt);
}

function sortFolder(folder: TreeFolder): void {
  const folders = folder.children.filter((c): c is TreeFolder => c.kind === "folder");
  const leaves = folder.children.filter((c): c is TreeLeaf => c.kind === "leaf");
  folders.sort((a, b) => a.label.localeCompare(b.label));
  leaves.sort(leafCompare);
  folder.children = [...folders, ...leaves];
  for (const f of folders) sortFolder(f);
}

function countLeaves(folder: TreeFolder): number {
  let n = 0;
  for (const c of folder.children) {
    n += c.kind === "leaf" ? 1 : countLeaves(c);
  }
  folder.count = n;
  return n;
}

/**
 * Build the workspace tree: one folder per display name (types that map to
 * the same display name — Person, Colleague — share a folder), with items
 * nested by their filing terms. Subfolders sort alphabetically before
 * leaves; leaves sort newest first.
 */
export function buildMemoryTree(entries: MemoryIndexEntry[]): TreeFolder[] {
  const roots = new Map<string, TreeFolder>();

  function folderFor(root: TreeFolder, termPath: string | undefined): TreeFolder {
    if (!termPath) return root;
    let current = root;
    const segments = termPath.split("/");
    for (let i = 0; i < segments.length; i++) {
      const id = `${root.id}/${segments.slice(0, i + 1).join("/")}`;
      let next = current.children.find((c): c is TreeFolder => c.kind === "folder" && c.id === id);
      if (!next) {
        next = { kind: "folder", label: segments[i], id, children: [], count: 0 };
        current.children.push(next);
      }
      current = next;
    }
    return current;
  }

  for (const entry of entries) {
    const label = displayTypeName(entry.type);
    let root = roots.get(label);
    if (!root) {
      root = { kind: "folder", label, id: label, children: [], count: 0 };
      roots.set(label, root);
    }
    folderFor(root, folderTermOf(entry)).children.push({ kind: "leaf", entry });
  }

  const result = [...roots.values()];
  for (const root of result) {
    sortFolder(root);
    countLeaves(root);
  }
  result.sort((a, b) => a.label.localeCompare(b.label));
  return result;
}
