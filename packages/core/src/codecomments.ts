/**
 * @freehold/core — Standalone line-anchored code comments.
 *
 * Creates and lists review/ReviewComment@1 entities that are NOT attached to
 * any review/Review@1 node. Each comment is anchored to a specific file path
 * and spans one or more lines of code.
 *
 * Commit flow: two-phase signed commit (commit_payload → keys.resolveKey →
 * keys.signPayload → commit_signed), same as decideGit in gitreview.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { headSha } from "./git.js";
import type { Freehold } from "./graphs.js";
import * as keys from "./keys.js";
import { withGraph } from "./lock.js";

// ── KeyMissingError (re-exported from gitreview; duplicated here to avoid circular) ──

export class CodeCommentKeyMissingError extends Error {
  readonly code = "key-missing" as const;
  constructor(message: string) {
    super(message);
    this.name = "CodeCommentKeyMissingError";
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PostCodeCommentInput {
  path: string;
  span: string;
  body: string;
  by: string;
}

export interface CodeCommentEntry {
  commentId: string;
  body: string;
  span: string;
  status: "open";
  author: string;
  anchorSha: string;
  /** True when anchorSha === the repo's current HEAD */
  currentHead: boolean;
}

// ── Wasm helpers ─────────────────────────────────────────────────────────────

interface CommitPayloadResult {
  changeset: unknown;
  hash: string;
}

function wasmCommitPayload(
  graph: unknown,
  author: string,
  intent: string,
  ops: unknown[],
  keyId?: string
): CommitPayloadResult {
  return (
    graph as {
      commit_payload(
        author: string,
        intent: string,
        ops: unknown[],
        key_id?: string | null
      ): CommitPayloadResult;
    }
  ).commit_payload(author, intent, ops, keyId ?? null);
}

function wasmCommitSigned(
  graph: unknown,
  changeset: unknown,
  signature: string,
  approvals: unknown[]
): unknown {
  return (
    graph as {
      commit_signed(changeset: unknown, signature: string, approvals: unknown[]): unknown;
    }
  ).commit_signed(changeset, signature, approvals);
}

// ── postCodeComment ───────────────────────────────────────────────────────────

/**
 * Post a standalone line-anchored code comment.
 *
 * Anchor format: git:<repo>#<HEAD sha>:<path>
 * No Review node, no part_of edge.
 *
 * Throws CodeCommentKeyMissingError if the signing key for `by` is not found.
 */
export async function postCodeComment(
  fh: Freehold,
  input: PostCodeCommentInput
): Promise<{ commentId: string; status: "saved" | "pending"; anchorSha: string }> {
  const { path, span, body, by } = input;

  // Resolve the allodGraphId from the graph's graph.yaml on disk
  const graphYamlPath = join(fh.graphDir, ".allod", "graph.yaml");
  let allodGraphId = "allod";
  if (existsSync(graphYamlPath)) {
    try {
      const graphYaml = readFileSync(graphYamlPath, "utf-8");
      const doc = yamlLoad(graphYaml) as Record<string, unknown>;
      if (doc && typeof doc.graph_id === "string") {
        allodGraphId = doc.graph_id;
      }
    } catch {
      // fall through to default
    }
  }

  // Resolve HEAD sha for this repo at posting time
  const anchorSha = await headSha(fh.graphDir);

  // Canonical anchor: git:<repo>#<sha>:<path>
  const repoName = basename(fh.graphDir);
  const anchor = `git:${repoName}#${anchorSha}:${path}`;

  const commentId = crypto.randomUUID();

  const op = {
    create: {
      kind: "node",
      id: commentId,
      type: "review/ReviewComment@1",
      attributes: {
        body,
        anchor,
        span,
        status: "open",
      },
    },
  };

  // Resolve signing key first — raise CodeCommentKeyMissingError if absent
  let resolvedKey: Awaited<ReturnType<typeof keys.resolveKey>>;
  try {
    resolvedKey = await keys.resolveKey(allodGraphId, by, { repoDir: fh.graphDir });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CodeCommentKeyMissingError(msg);
  }

  // Get key_id so wasm can stamp it into the changeset body
  const keyId = await keys.keyIdFor(resolvedKey, allodGraphId, { repoDir: fh.graphDir });

  // Phase 1: build unsigned changeset + hash.
  // Pass key_id so wasm stamps it (avoids wasm-side key resolution which fails for host-managed keys).
  const { changeset, hash } = await withGraph(fh.graph, () =>
    wasmCommitPayload(fh.graph, by, `code comment on ${path}`, [op], keyId)
  );

  // Sign the hash payload
  const signature = await keys.signPayload(resolvedKey, hash, allodGraphId, {
    repoDir: fh.graphDir,
  });

  // Phase 2: admit the signed changeset
  const result = await withGraph(fh.graph, () =>
    wasmCommitSigned(fh.graph, changeset, signature, [])
  );

  let status: "saved" | "pending" = "pending";
  if (result && typeof result === "object") {
    if ("Admitted" in result) status = "saved";
  }

  return { commentId, status, anchorSha };
}

// ── listCodeComments ──────────────────────────────────────────────────────────

interface RawLogEntry {
  hash: string;
  author: string;
}

interface RawPendingProposal {
  hash: string;
  author?: string;
}

interface RawPendingChangeset {
  operations?: unknown[];
}

/**
 * List all standalone code comments (review/ReviewComment@1) for the given
 * file path in this repo, across all anchor shas.
 *
 * Returns both admitted (saved) and held (pending) comments.
 * The anchor is matched by the suffix `:<path>` after the sha segment, so
 * `src/lib.rs` will not match `test/src/lib.rs`.
 */
export async function listCodeComments(fh: Freehold, path: string): Promise<CodeCommentEntry[]> {
  // Suffix used for exact path matching: :<path>
  const anchorSuffix = `:${path}`;

  // Get current HEAD for the `currentHead` field
  let currentHead = "";
  try {
    currentHead = await headSha(fh.graphDir);
  } catch {
    // leave empty; no comment will have currentHead=true
  }

  const results: CodeCommentEntry[] = [];

  // ── 1. Admitted changesets ────────────────────────────────────────────────
  const log = await withGraph(fh.graph, () => {
    return (fh.graph as unknown as { log(): RawLogEntry[] }).log();
  });

  if (Array.isArray(log)) {
    const csDir = join(fh.graphDir, ".allod", "changesets");

    for (const entry of log) {
      const bareHash = (entry.hash ?? "").replace("sha256:", "");
      const yamlPath = join(csDir, `${bareHash}.yaml`);
      if (!existsSync(yamlPath)) continue;

      let yaml: string;
      try {
        yaml = readFileSync(yamlPath, "utf-8");
      } catch {
        continue;
      }

      let doc: unknown;
      try {
        doc = yamlLoad(yaml);
      } catch {
        continue;
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;

      const cs = doc as Record<string, unknown>;
      const operations = cs.operations;
      if (!Array.isArray(operations)) continue;

      const rawAuthor = entry.author ?? "";
      const author = rawAuthor.startsWith("principal:")
        ? rawAuthor.slice("principal:".length)
        : rawAuthor;

      for (const comment of extractCodeComments(operations, anchorSuffix, author, currentHead)) {
        results.push(comment);
      }
    }
  }

  // ── 2. Pending proposals ──────────────────────────────────────────────────
  await withGraph(fh.graph, () => {
    let pendingList: RawPendingProposal[];
    try {
      pendingList = (fh.graph as unknown as { proposals(): RawPendingProposal[] }).proposals();
    } catch {
      return;
    }
    if (!Array.isArray(pendingList)) return;

    for (const p of pendingList) {
      const hash = p.hash ?? "";
      if (!hash) continue;

      let cs: RawPendingChangeset;
      try {
        cs = (
          fh.graph as unknown as { proposal_get(hash: string): RawPendingChangeset }
        ).proposal_get(hash);
      } catch {
        continue;
      }
      if (!cs || !Array.isArray(cs.operations)) continue;

      const rawAuthor = p.author ?? "";
      const author = rawAuthor.startsWith("principal:")
        ? rawAuthor.slice("principal:".length)
        : rawAuthor;

      for (const comment of extractCodeComments(cs.operations, anchorSuffix, author, currentHead)) {
        results.push(comment);
      }
    }
  });

  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extracts standalone ReviewComment entries from a list of changeset operations,
 * filtering by anchor suffix. Returns only comments with an anchor that ends
 * with `:<path>` exactly (i.e., the last segment after the sha is exactly `path`).
 */
function extractCodeComments(
  operations: unknown[],
  anchorSuffix: string,
  author: string,
  currentHead: string
): CodeCommentEntry[] {
  const entries: CodeCommentEntry[] = [];

  for (const op of operations) {
    if (!op || typeof op !== "object" || Array.isArray(op)) continue;
    const o = op as Record<string, unknown>;
    const inner = o.create as Record<string, unknown> | undefined;
    if (!inner || typeof inner !== "object") continue;

    if (
      inner.kind !== "node" ||
      typeof inner.type !== "string" ||
      !inner.type.startsWith("review/ReviewComment")
    )
      continue;

    const attrs = (inner.attributes as Record<string, unknown> | undefined) ?? {};
    const anchor = attrs.anchor as string | undefined;
    if (!anchor) continue;

    // Exact suffix match: the anchor must end with :<path>, and the character
    // immediately before :<path> must be the sha segment (not another path).
    // The anchor format is git:<repo>#<sha>:<path>, so we verify:
    // - anchor ends with anchorSuffix
    // - what precedes anchorSuffix ends with the sha (i.e., no extra path segments)
    if (!anchor.endsWith(anchorSuffix)) continue;

    // Extract the sha from the anchor: git:<repo>#<sha>:<path>
    // Format: everything after '#' and before the first ':' following '#'
    const hashIdx = anchor.indexOf("#");
    if (hashIdx === -1) continue;
    const afterHash = anchor.slice(hashIdx + 1);
    // afterHash = <sha>:<path>
    const colonIdx = afterHash.indexOf(":");
    if (colonIdx === -1) continue;
    const anchorSha = afterHash.slice(0, colonIdx);
    const anchorPath = afterHash.slice(colonIdx + 1);

    // Exact path match — guard against suffix collisions (e.g. `src/lib.rs` vs `test/src/lib.rs`)
    if (anchorPath !== anchorSuffix.slice(1)) continue;

    entries.push({
      commentId: inner.id as string,
      body: (attrs.body as string) ?? "",
      span: (attrs.span as string) ?? "",
      status: "open",
      author,
      anchorSha,
      currentHead: anchorSha === currentHead,
    });
  }

  return entries;
}
