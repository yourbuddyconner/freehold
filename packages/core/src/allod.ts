/**
 * @freehold/core — Allod graph wiring.
 *
 * Thin wrappers around `@allod/core` that bind the filesystem backend
 * and expose a clean async API for the rest of the Freehold stack.
 *
 * Every function in this module is the *only* place the rest of the
 * codebase touches `@allod/core` directly — per decision 3 in the design.
 */

import { AllodGraph, fsBackend } from "@allod/core";

/**
 * Open an existing Allod graph stored under `graphDir`.
 *
 * The directory must have been created by `createGraph` (or the Rust CLI).
 * Returns a ready-to-use `AllodGraph` instance backed by the filesystem.
 */
export async function openGraph(graphDir: string): Promise<AllodGraph> {
  const backend = fsBackend(graphDir);
  const docs = backend.load();
  const graph = new AllodGraph(docs, backend.persist.bind(backend));
  return graph;
}

/**
 * Create a new Allod graph under `graphDir` with `owner` as the founding
 * principal, then return the initialised graph.
 *
 * Calls `init(owner, "memory")` — the "memory" profile is the embedded
 * in-process profile that does not require an external key agent.
 */
export async function createGraph(graphDir: string, owner: string): Promise<AllodGraph> {
  const backend = fsBackend(graphDir);
  // New graph: empty docs array, then call init to bootstrap.
  const graph = new AllodGraph([], backend.persist.bind(backend));
  await graph.init(owner, "memory");
  return graph;
}
