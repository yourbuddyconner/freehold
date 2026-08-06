/**
 * Shared utility for reading the allod graph id from a repo path.
 * Extracted to avoid circular imports between onboarding.ts and manager.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";

/**
 * Parse the allod_graph_id from a graph's .allod/graph.yaml file.
 * Returns "" if the file doesn't exist or lacks the field.
 */
export function readAllodGraphIdFromPath(repoPath: string): string {
  const yamlPath = join(repoPath, ".allod", "graph.yaml");
  if (!existsSync(yamlPath)) return "";
  try {
    const doc = yamlLoad(readFileSync(yamlPath, "utf-8")) as Record<string, unknown> | null;
    if (!doc) return "";
    return ((doc.graph_id ?? doc.id) as string) ?? "";
  } catch {
    return "";
  }
}
