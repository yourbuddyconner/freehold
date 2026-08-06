/**
 * @freehold/core — Apply a review suggestion as a plain git commit.
 *
 * Pure object-database commit: reads blob, splices lines, writes new
 * tree and commit via git plumbing. No working-tree mutation.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Internal git helper
// ---------------------------------------------------------------------------

/**
 * Run a git command. When `opts.input` is provided, write it to the
 * process stdin (spawn-based; execFile does not support stdin input).
 * Otherwise behave like execFile.
 */
function git(
  repoDir: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoDir,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        reject(new Error(stderr || `git ${args[0]} exited with code ${code}`));
      } else {
        resolve(Buffer.concat(stdoutChunks).toString());
      }
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/**
 * Defense-in-depth guard (mirrors assertSafeRef in git.ts).
 * Rejects refs/shas starting with '-' to prevent option injection.
 */
function assertSafeRef(ref: string, label: string): void {
  if (ref.startsWith("-")) {
    throw new Error(`unsafe ${label}: starts with '-'`);
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** 409 — branch tip moved between blob read and update-ref. */
export class BranchMovedError extends Error {
  readonly code = "branch-moved" as const;
  constructor(branch: string) {
    super(`branch ${branch} moved during apply`);
    this.name = "BranchMovedError";
  }
}

/** 422 — file is binary (contains NUL). */
export class BinaryFileError extends Error {
  readonly code = "binary-file" as const;
  constructor(path: string) {
    super(`file ${path} is binary`);
    this.name = "BinaryFileError";
  }
}

/** 422 — span is on the deletions side (old:). */
export class OldSideSpanError extends Error {
  readonly code = "old-side-span" as const;
  constructor(span: string) {
    super(`span ${span} is on the deletions side; only additions-side spans are supported`);
    this.name = "OldSideSpanError";
  }
}

/** 422 — span format is invalid or out of range. */
export class InvalidSpanError extends Error {
  readonly code = "invalid-span" as const;
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidSpanError";
  }
}

// ---------------------------------------------------------------------------
// Span parsing
// ---------------------------------------------------------------------------

/** Parse "L<n>" or "L<n>-L<m>". Returns [startLine, endLine] (1-indexed, inclusive). */
function parseSpan(span: string): [number, number] {
  if (span.startsWith("old:")) {
    throw new OldSideSpanError(span);
  }
  const single = span.match(/^L(\d+)$/);
  if (single) {
    const n = Number.parseInt(single[1], 10);
    return [n, n];
  }
  const range = span.match(/^L(\d+)-L(\d+)$/);
  if (range) {
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    if (start > end) {
      throw new InvalidSpanError(`span ${span}: start line ${start} > end line ${end}`);
    }
    return [start, end];
  }
  throw new InvalidSpanError(`unrecognised span format: ${span}`);
}

// ---------------------------------------------------------------------------
// Line splicing
// ---------------------------------------------------------------------------

/**
 * Replace lines [startLine..endLine] (1-indexed, inclusive) in `content`
 * with `replacement`. Preserves trailing-newline discipline:
 * - If the original file ends with \n, the result does too.
 * - The replacement is split on \n; any trailing empty string after the last
 *   \n is preserved only to reconstruct the file's trailing newline.
 */
function spliceLines(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  // Split keeping trailing newline information: a "a\nb\n" → ["a","b",""]
  const originalLines = content.split("\n");
  const fileEndedWithNewline =
    originalLines.length > 0 && originalLines[originalLines.length - 1] === "";

  // Working lines: if there's a trailing "", exclude it from the logical lines
  const logicalLines = fileEndedWithNewline ? originalLines.slice(0, -1) : originalLines;

  if (startLine < 1 || endLine > logicalLines.length) {
    throw new InvalidSpanError(
      `span L${startLine}-L${endLine} is out of range (file has ${logicalLines.length} lines)`
    );
  }

  // Split the replacement on \n; drop a trailing empty segment (it's a trailing \n, not a real line)
  const replacementLines = replacement.split("\n");
  const replacementEndedWithNewline =
    replacementLines.length > 0 && replacementLines[replacementLines.length - 1] === "";
  const replacementLogical = replacementEndedWithNewline
    ? replacementLines.slice(0, -1)
    : replacementLines;

  const before = logicalLines.slice(0, startLine - 1);
  const after = logicalLines.slice(endLine);
  const newLogical = [...before, ...replacementLogical, ...after];

  // Reconstruct with the file's original trailing-newline discipline
  return fileEndedWithNewline ? `${newLogical.join("\n")}\n` : newLogical.join("\n");
}

// ---------------------------------------------------------------------------
// Tree manipulation via a scratch index
// ---------------------------------------------------------------------------

/**
 * Build a new tree object that is identical to the tree at `tipSha` but with
 * `path` replaced by the blob at `newBlobHash`. Handles nested paths.
 *
 * Strategy: use `git update-index --index-info` against a scratch index
 * (GIT_INDEX_FILE pointing to a temp file) to swap the entry, then
 * `git write-tree` to produce the new tree hash.
 *
 * Returns the new tree SHA.
 */
async function buildNewTree(
  repoDir: string,
  tipSha: string,
  filePath: string,
  newBlobHash: string,
  scratchIndex: string
): Promise<string> {
  // Read full recursive tree listing for the tip commit's tree.
  // assertSafeRef on tipSha has already been done by the caller.
  const lsOut = await git(repoDir, ["ls-tree", "-r", "--full-tree", tipSha]);

  // Find the mode for the existing path entry
  let fileMode = "100644"; // default
  for (const line of lsOut.split("\n")) {
    if (!line.trim()) continue;
    // format: <mode> SP <type> SP <hash> TAB <name>
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const entryPath = line.slice(tab + 1).trim();
    if (entryPath === filePath) {
      const parts = line.slice(0, tab).trim().split(/\s+/);
      if (parts[0]) fileMode = parts[0];
      break;
    }
  }

  // Resolve the tree SHA for this commit
  // Format: <sha>^{tree} — safe because tipSha is validated (no leading '-')
  const treeOut = await git(repoDir, ["rev-parse", `${tipSha}^{tree}`]);
  const treeSha = treeOut.trim();

  // Populate the scratch index from the commit's tree
  await git(repoDir, ["read-tree", treeSha], {
    env: { GIT_INDEX_FILE: scratchIndex },
  });

  // Swap the entry for the target path.
  // update-index --index-info line format: <mode> SP <hash> TAB <path>
  const indexInfo = `${fileMode} ${newBlobHash}\t${filePath}\n`;
  await git(repoDir, ["update-index", "--index-info"], {
    env: { GIT_INDEX_FILE: scratchIndex },
    input: indexInfo,
  });

  // Write the new tree
  const newTree = await git(repoDir, ["write-tree"], {
    env: { GIT_INDEX_FILE: scratchIndex },
  });
  return newTree.trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ApplySuggestionInput {
  /** The branch to commit onto (without refs/heads/ prefix). */
  branch: string;
  /** Repo-relative file path. */
  path: string;
  /** Span in "L<n>" or "L<n>-L<m>" format (additions side only). */
  span: string;
  /** Replacement text (the suggestion body). */
  suggestion: string;
  /** Principal name for author/committer attribution. */
  by: string;
  /**
   * The SHA the caller expects to be the current branch tip.
   * Must equal the actual tip exactly; otherwise BranchMovedError is thrown.
   */
  expectedTip: string;
  /**
   * Optional hook called after blob/tree are built but before update-ref.
   * Intended for test injection to simulate a concurrent push.
   */
  preUpdateHook?: () => Promise<void>;
}

export interface ApplySuggestionResult {
  /** The new commit SHA. */
  newSha: string;
}

/**
 * Apply a review suggestion as a pure git plumbing commit on `branch`.
 *
 * Reads the blob at the branch tip, splices the span with the suggestion,
 * writes a new blob/tree/commit, and atomically updates the branch ref with
 * an old-value guard. Returns the new commit SHA.
 *
 * Throws:
 * - BranchMovedError (409) — branch tip != expectedTip, or update-ref lost the race
 * - BinaryFileError  (422) — file contains NUL bytes
 * - OldSideSpanError (422) — span starts with "old:"
 * - InvalidSpanError (422) — span format error or out-of-range
 */
export async function applySuggestion(
  repoDir: string,
  input: ApplySuggestionInput
): Promise<ApplySuggestionResult> {
  const { branch, path, span, suggestion, by, expectedTip, preUpdateHook } = input;

  // Validate inputs
  assertSafeRef(branch, "branch");
  assertSafeRef(expectedTip, "expectedTip");

  const branchRef = `refs/heads/${branch}`;

  // 1. Resolve the branch tip and verify it equals expectedTip.
  // branchRef is safe: "refs/heads/" + a branch validated by assertSafeRef.
  let tipOut: string;
  try {
    tipOut = await git(repoDir, ["rev-parse", branchRef]);
  } catch {
    throw new BranchMovedError(branch);
  }
  const tip = tipOut.trim();
  if (tip !== expectedTip) {
    throw new BranchMovedError(branch);
  }

  // 2. Read the blob at tip:path
  let content: string;
  try {
    content = await git(repoDir, ["show", "--end-of-options", `${tip}:${path}`]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read ${path} at ${tip}: ${msg}`);
  }

  // Binary check: NUL byte in content
  if (content.includes("\0")) {
    throw new BinaryFileError(path);
  }

  // 3. Parse span and splice lines
  const [startLine, endLine] = parseSpan(span);
  const newContent = spliceLines(content, startLine, endLine, suggestion);

  // 4. Write the new blob object
  const blobHashOut = await git(repoDir, ["hash-object", "-w", "--stdin"], {
    input: newContent,
  });
  const newBlobHash = blobHashOut.trim();

  // 5. Build new tree using a scratch index
  const scratchDir = mkdtempSync(join(tmpdir(), "freehold-apply-"));
  const scratchIndex = join(scratchDir, "index");
  let newTreeSha: string;
  try {
    newTreeSha = await buildNewTree(repoDir, tip, path, newBlobHash, scratchIndex);
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  // 6. Build commit-tree
  // Author / committer: "<by> via freehold <noreply@freehold.local>"
  const authorName = `${by} via freehold`;
  const authorEmail = "noreply@freehold.local";
  const commitMessage = `Apply suggestion to ${path} (${span})\n\nSuggested in review of ${expectedTip}`;

  // Use ISO 8601 for author/committer date
  const now = new Date().toISOString();
  // commit-tree <tree> -p <parent> -m <message>
  // tipSha is safe (starts with hex chars, validated by assertSafeRef).
  const newCommitOut = await git(
    repoDir,
    ["commit-tree", newTreeSha, "-p", tip, "-m", commitMessage],
    {
      env: {
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_AUTHOR_DATE: now,
        GIT_COMMITTER_NAME: authorName,
        GIT_COMMITTER_EMAIL: authorEmail,
        GIT_COMMITTER_DATE: now,
      },
    }
  );
  const newCommitSha = newCommitOut.trim();

  // Optional test hook: simulate concurrent push before update-ref
  if (preUpdateHook) {
    await preUpdateHook();
  }

  // 7. Update the branch ref with old-value guard
  try {
    await git(repoDir, [
      "update-ref",
      branchRef,
      newCommitSha,
      tip, // old-value guard
    ]);
  } catch (err) {
    // update-ref fails when the old value no longer matches — branch moved
    throw new BranchMovedError(branch);
  }

  return { newSha: newCommitSha };
}
