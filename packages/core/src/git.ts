/**
 * @freehold/core — Git shell-out helpers
 *
 * All operations use execFile (never shell strings) to avoid injection.
 * Functions are async and throw on unexpected git errors.
 */

import { execFile } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";

const execFileAsync = promisify(execFile);

// Per-(repoDir+sha) serialization for appendDecision read-modify-write.
// Uses the same promise-chain pattern as withGraph in lock.ts.
const appendLocks = new Map<string, Promise<void>>();

function withAppendLock<T>(repoDir: string, sha: string, fn: () => Promise<T>): Promise<T> {
  const key = `${repoDir}\0${sha}`;
  const prev = appendLocks.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  appendLocks.set(key, next);
  return prev
    .then(() => fn())
    .finally(() => {
      resolve();
      // Clean up if this is still the current tail to avoid unbounded growth
      if (appendLocks.get(key) === next) {
        appendLocks.delete(key);
      }
    });
}

/**
 * Defense-in-depth guard: reject refs/shas that start with '-' to prevent them
 * from being parsed as git options in commands that don't support --end-of-options.
 */
function assertSafeRef(ref: string, label: string): void {
  if (ref.startsWith("-")) {
    throw new Error(`unsafe ${label}: starts with '-'`);
  }
}

async function git(repoDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr || e.message || String(err));
  }
}

/**
 * Get the URL for the "origin" remote, or null if no remote is configured.
 */
export async function originRemote(repoDir: string): Promise<string | null> {
  try {
    const out = await git(repoDir, ["remote", "get-url", "origin"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a git ref (defaults to HEAD) to a 40-char hex SHA.
 */
export async function headSha(repoDir: string, ref = "HEAD"): Promise<string> {
  assertSafeRef(ref, "ref");
  const out = await git(repoDir, ["rev-parse", ref]);
  return out.trim();
}

export interface CommitMeta {
  sha: string;
  author: string;
  email: string;
  timestamp: string;
  message: string;
  parents: string[];
}

/**
 * Return structured metadata for a commit SHA.
 */
export async function commitMeta(repoDir: string, sha: string): Promise<CommitMeta> {
  // Format: SHA\nAuthorName\nAuthorEmail\nISO8601timestamp\nParent SHAs\nBody…
  const out = await git(repoDir, [
    "show",
    "-s",
    "--format=%H%n%an%n%ae%n%aI%n%P%n%B",
    "--end-of-options",
    sha,
  ]);
  const lines = out.split("\n");
  const resultSha = lines[0].trim();
  const author = lines[1].trim();
  const email = lines[2].trim();
  const timestamp = lines[3].trim();
  const parentsLine = lines[4].trim();
  const parents = parentsLine ? parentsLine.split(" ").filter(Boolean) : [];
  // Everything from line 5 onward is the commit body (%B); strip trailing newline
  const message = lines.slice(5).join("\n").trimEnd();
  return { sha: resultSha, author, email, timestamp, message, parents };
}

/**
 * Return the list of file operations for a commit as [status, path] pairs.
 *
 * For root commits (no parents), uses --root to diff against the empty tree.
 * Status characters: A=added, M=modified, D=deleted, R=renamed, C=copied, etc.
 */
export async function diffTreeOps(repoDir: string, sha: string): Promise<Array<[string, string]>> {
  const meta = await commitMeta(repoDir, sha);
  let args: string[];
  if (meta.parents.length === 0) {
    // Root commit: diff against empty tree
    args = ["diff-tree", "--root", "--no-renames", "--name-status", "-r", "--end-of-options", sha];
  } else {
    // First-parent two-tree diff
    args = [
      "diff-tree",
      "--no-renames",
      "--name-status",
      "-r",
      "--end-of-options",
      meta.parents[0],
      sha,
    ];
  }
  const out = await git(repoDir, args);
  const results: Array<[string, string]> = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\t/);
    if (parts.length >= 2) {
      results.push([parts[0], parts[1]]);
    }
  }
  return results;
}

/**
 * Read the allod-decisions git note for a commit SHA.
 * Returns [] if no note exists.
 */
export async function readDecisions(repoDir: string, sha: string): Promise<unknown[]> {
  assertSafeRef(sha, "sha");
  let body: string;
  try {
    body = await git(repoDir, ["notes", "--ref=allod-decisions", "show", sha]);
  } catch (err: unknown) {
    const msg = String(err).toLowerCase();
    if (msg.includes("no note") || msg.includes("found no note") || msg.includes("no notes")) {
      return [];
    }
    throw err;
  }
  if (!body.trim()) return [];
  const doc = yamlLoad(body) as Record<string, unknown> | null;
  if (!doc) return [];
  const decisions = doc.decisions;
  return Array.isArray(decisions) ? decisions : [];
}

/**
 * Append a decision record to the allod-decisions git note for a commit SHA.
 * Reads existing decisions, appends, and writes back atomically via a temp file.
 */
export async function appendDecision(repoDir: string, sha: string, record: unknown): Promise<void> {
  assertSafeRef(sha, "sha"); // reject before locking
  return withAppendLock(repoDir, sha, async () => {
    const existing = await readDecisions(repoDir, sha);
    existing.push(record);
    const root = { decisions: existing };
    const body = yamlDump(root);
    const tmpFile = join(tmpdir(), `allod-note-${sha}-${Date.now()}.yaml`);
    writeFileSync(tmpFile, body);
    try {
      await git(repoDir, ["notes", "--ref=allod-decisions", "add", "-f", "-F", tmpFile, sha]);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });
}

/**
 * Push the allod-decisions notes ref to a remote.
 */
export async function pushNotes(repoDir: string, remote = "origin"): Promise<void> {
  await git(repoDir, ["push", remote, "refs/notes/allod-decisions"]);
}

/**
 * Return all local branch heads as { ref, sha } pairs.
 * Uses `git for-each-ref refs/heads --format=%(refname)%09%(objectname)`.
 */
export async function branchHeads(repoDir: string): Promise<Array<{ ref: string; sha: string }>> {
  const out = await git(repoDir, [
    "for-each-ref",
    "refs/heads",
    "--format=%(refname)\t%(objectname)",
  ]);
  const results: Array<{ ref: string; sha: string }> = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const ref = trimmed.slice(0, tab).trim();
    const sha = trimmed.slice(tab + 1).trim();
    if (ref && sha) {
      results.push({ ref, sha });
    }
  }
  return results;
}
