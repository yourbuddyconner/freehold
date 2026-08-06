/**
 * @freehold/core — auto-index runner queue
 *
 * Fires `allodBin git index <repoDir> <sha> --as <signingPrincipal>` in the
 * background when evaluateSha finds unindexed paths. Single-flight per (repoDir,
 * sha) pair: concurrent requests for the same sha are deduplicated. On success,
 * evicts the sha from the proposal cache so the next fetch shows indexed chips.
 *
 * If allodBin is unavailable, the run is skipped silently — behavior is unchanged
 * per the spec ("If `allodBin` is unavailable, behavior is unchanged").
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { evictSha } from "./gitreview.js";

// In-flight set: key = `${repoDir}\0${sha}` — deduplicate concurrent requests
const inFlight = new Set<string>();

/**
 * Resolve the allod binary path.
 * Returns null if the binary cannot be found (no PATH entry and no override).
 */
function resolveAllodBin(allodBin: string): string | null {
  // If it's an absolute path, check existence directly
  if (allodBin.startsWith("/")) {
    return existsSync(allodBin) ? allodBin : null;
  }
  // For a bare name like "allod", rely on execFile's PATH resolution.
  // We trust the caller to have verified the binary before we get here.
  return allodBin;
}

/**
 * Queue a background `allodBin git index` run for the given (repoDir, sha).
 *
 * - Deduplicates: if a run for the same (repoDir, sha) is already in flight,
 *   this call is a no-op.
 * - On success: evicts the sha from the proposal cache.
 * - On failure: logs the error and continues (log-only as per spec).
 * - If allodBin is null/unavailable: silently skips.
 */
export function queueAutoIndex(
  repoDir: string,
  sha: string,
  signingPrincipal: string,
  allodBin: string | undefined | null
): void {
  if (!allodBin) return;

  const resolved = resolveAllodBin(allodBin);
  if (!resolved) {
    // Binary not found — behavior unchanged per spec
    return;
  }

  const key = `${repoDir}\0${sha}`;
  if (inFlight.has(key)) return;

  inFlight.add(key);

  // Fire and forget — not awaited
  void (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          resolved,
          ["git", "index", repoDir, sha, "--as", signingPrincipal],
          { timeout: 120_000 },
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
      // Evict the sha from the proposal cache on success
      evictSha(repoDir, sha);
    } catch (err) {
      // Log-only — do not propagate
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[freehold] auto-index failed for ${sha} in ${repoDir}: ${msg}`);
    } finally {
      inFlight.delete(key);
    }
  })();
}

/**
 * Returns whether a (repoDir, sha) auto-index run is currently in flight.
 * Used by the UI caption: "Indexing." while in flight.
 */
export function isAutoIndexInFlight(repoDir: string, sha: string): boolean {
  return inFlight.has(`${repoDir}\0${sha}`);
}
