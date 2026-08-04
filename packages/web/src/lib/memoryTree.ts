/**
 * Tree derivation for the Memory workspace.
 *
 * The tree is the ontology: top-level folders come from root entity types
 * (People, Notes, Documents, …), nested folders follow type-path segments,
 * and items are leaves. Taxonomy terms are labels on items, never folders.
 * Pure functions — the server ships a flat listing, the client owns shape.
 */

import type { MemoryIndexEntry } from "@freehold/client";

export interface TreeFolder {
  kind: "folder";
  label: string;
  /** Bare type path this folder groups, e.g. "memory/Note" */
  typePrefix: string;
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

/** Bare type path without version: "memory/Note@1" → "memory/Note". */
function barePath(typeRef: string): string {
  return typeRef.split("@")[0];
}

function leafCompare(a: TreeLeaf, b: TreeLeaf): number {
  // Newest first
  return b.entry.updatedAt.localeCompare(a.entry.updatedAt);
}

/**
 * Build the workspace tree: one folder per display name (types that map to
 * the same display name — Person, Colleague — share a folder), leaves
 * sorted newest first, folders sorted alphabetically.
 */
export function buildMemoryTree(entries: MemoryIndexEntry[]): TreeFolder[] {
  const folders = new Map<string, TreeFolder>();

  for (const entry of entries) {
    const label = displayTypeName(entry.type);
    let folder = folders.get(label);
    if (!folder) {
      folder = { kind: "folder", label, typePrefix: barePath(entry.type), children: [], count: 0 };
      folders.set(label, folder);
    }
    folder.children.push({ kind: "leaf", entry });
    folder.count += 1;
  }

  const result = [...folders.values()];
  for (const folder of result) {
    (folder.children as TreeLeaf[]).sort(leafCompare);
  }
  result.sort((a, b) => a.label.localeCompare(b.label));
  return result;
}
