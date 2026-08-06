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
export function folderTermFromTerms(terms: string[]): string | undefined {
  const qualifying = terms
    .map((t) => t.split("@")[0])
    .filter((t) => !STATUS_NAMESPACES.has(t.split("/")[0]));
  if (qualifying.length === 0) return undefined;
  qualifying.sort(
    (a, b) => b.split("/").length - a.split("/").length || b.length - a.length || a.localeCompare(b)
  );
  return qualifying[0];
}

export function folderTermOf(entry: MemoryIndexEntry): string | undefined {
  return folderTermFromTerms(entry.terms);
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
 * Map a TreeFolder hierarchy to flat synthetic paths suitable for PierreTree.
 *
 * Synthetic path format: `<TypeFolder>/<TermFolder>/<Title>`
 * - Directory paths end with `/`
 * - Leaf titles have `/` sanitized to `∕` (U+2215) so paths stay well-formed
 * - Duplicate titles within the same folder get ` (2)`, ` (3)` suffixes in the
 *   path only (the entry title is not modified)
 *
 * Returns:
 *   paths    — all directory and leaf paths, suitable for PierreTree `paths` prop
 *   idByPath — maps every leaf path to its memory id
 */
export function treeToPaths(folders: TreeFolder[]): {
  paths: string[];
  idByPath: Map<string, string>;
} {
  const paths: string[] = [];
  const idByPath = new Map<string, string>();

  function sanitizeTitle(title: string): string {
    return title.replace(/\//g, "∕");
  }

  function walkFolder(folder: TreeFolder, prefix: string): void {
    const dirPath = `${prefix}${folder.label}/`;
    paths.push(dirPath);

    // Count title occurrences among leaf children to deduplicate
    const titleCount = new Map<string, number>();
    const titleSeen = new Map<string, number>();
    for (const child of folder.children) {
      if (child.kind === "leaf") {
        const sanitized = sanitizeTitle(child.entry.title);
        titleCount.set(sanitized, (titleCount.get(sanitized) ?? 0) + 1);
      }
    }

    for (const child of folder.children) {
      if (child.kind === "folder") {
        walkFolder(child, dirPath);
      } else {
        const sanitized = sanitizeTitle(child.entry.title);
        const count = titleCount.get(sanitized) ?? 1;
        let leafPath: string;
        if (count <= 1) {
          leafPath = `${dirPath}${sanitized}`;
        } else {
          const seen = (titleSeen.get(sanitized) ?? 0) + 1;
          titleSeen.set(sanitized, seen);
          leafPath = seen === 1 ? `${dirPath}${sanitized}` : `${dirPath}${sanitized} (${seen})`;
        }
        paths.push(leafPath);
        idByPath.set(leafPath, child.entry.id);
      }
    }
  }

  for (const folder of folders) {
    walkFolder(folder, "");
  }

  return { paths, idByPath };
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
