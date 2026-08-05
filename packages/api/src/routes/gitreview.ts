/**
 * Git proposal API routes.
 *
 * Scoped mount — all routes guard against non-repo graphs with a 400.
 * The decide handler resolves the graph entry via the manager for
 * allodGraphId / autoPushNotes / originRemote, then delegates to decideGit.
 * Review artifacts are written through the existing commit path.
 */

import { basename } from "node:path";
import {
  KeyMissingError,
  commitDiff,
  decideGit,
  gitProposal,
  listGitProposals,
  listReviewsForSha,
  pushNotes,
} from "@freehold/core";
import { withGraph } from "@freehold/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";

export const gitreviewRouter = new Hono<AppEnv>();

/** Guard: git review routes are only available for repo graphs. */
function repoOnly(fh: { kind: string }): boolean {
  return fh.kind === "repo";
}

const REPO_ONLY_ERROR = "git review is only available for repo graphs";

const SHA_RE = /^[0-9a-f]{7,64}$/i;

function validateSha(sha: string): boolean {
  return SHA_RE.test(sha);
}

// ── GET /git/proposals ────────────────────────────────────────────────────────

gitreviewRouter.get("/git/proposals", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }
  const proposals = await listGitProposals(fh);
  return c.json({ proposals });
});

// ── GET /git/proposals/:sha ───────────────────────────────────────────────────

gitreviewRouter.get("/git/proposals/:sha", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }
  const sha = c.req.param("sha");
  if (!validateSha(sha)) {
    return c.json({ error: "invalid commit sha" }, 400);
  }
  const proposal = await gitProposal(fh, sha);
  if (!proposal) {
    return c.json({ error: "proposal not found" }, 404);
  }
  return c.json(proposal);
});

// ── POST /git/proposals/:sha/decide ──────────────────────────────────────────

const DecideBody = z.object({
  verdict: z.enum(["approve", "reject"]),
  by: z.string().min(1),
});

gitreviewRouter.post("/git/proposals/:sha/decide", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const parsed = DecideBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "verdict and by are required" }, 400);
  }

  // Trust boundary: `by` is accepted from the client as the acting principal.
  // This is an explicit design choice for the single-user daemon: the bearer
  // token authenticates the host owner, signatures require the principal's key
  // to be present on the host (409 without it), and repo graphs use
  // graph-specific principal names — pinning to a fixed "owner" principal is
  // not viable. The 409/KeyMissingError path is the enforcement mechanism.
  const { verdict, by } = parsed.data;
  const sha = c.req.param("sha");
  if (!validateSha(sha)) {
    return c.json({ error: "invalid commit sha" }, 400);
  }

  // Verify sha exists
  const proposal = await gitProposal(fh, sha);
  if (!proposal) {
    return c.json({ error: "proposal not found" }, 404);
  }

  // Resolve the graph entry for allodGraphId / autoPushNotes / originRemote
  const manager = c.get("manager");
  const entry = await manager.getEntry(fh.graphId);
  if (!entry) {
    return c.json({ error: "graph entry not found" }, 500);
  }

  try {
    const result = await decideGit(fh, sha, verdict, by, {
      allodGraphId: entry.allodGraphId,
      autoPushNotes: entry.autoPushNotes,
      originRemote: entry.originRemote,
    });
    return c.json(result);
  } catch (err: unknown) {
    if (err instanceof KeyMissingError) {
      return c.json({ error: `no signing key for ${by}`, code: "key-missing" }, 409);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── POST /git/proposals/:sha/reviews ─────────────────────────────────────────

const CommentSchema = z.object({
  body: z.string().min(1),
  anchor: z.string().optional(),
  span: z.string().optional(),
});

const ReviewBody = z.object({
  verdict: z.enum(["approve", "approve-with-comments", "request-changes"]),
  body: z.string().optional(),
  by: z.string().min(1),
  comments: z.array(CommentSchema).optional(),
});

gitreviewRouter.post("/git/proposals/:sha/reviews", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const parsed = ReviewBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "verdict and by are required" }, 400);
  }

  const { verdict, body: reviewBody, by, comments = [] } = parsed.data;
  const sha = c.req.param("sha");
  if (!validateSha(sha)) {
    return c.json({ error: "invalid commit sha" }, 400);
  }

  // Verify sha exists as a known git proposal
  const proposal = await gitProposal(fh, sha);
  if (!proposal) {
    return c.json({ error: "proposal not found" }, 404);
  }

  const reviewId = crypto.randomUUID();

  // Canonical external-ref format: git:<repo>#<sha>
  const repoName = basename(fh.graphDir);
  const commitRef = `git:${repoName}#${sha}`;

  // Commit 1: create the Review node
  // Engine invariant: endpoints must be admitted before edges — so Review node first.
  const reviewOp = {
    create: {
      kind: "node",
      id: reviewId,
      type: "review/Review@1",
      attributes: {
        verdict,
        ...(reviewBody !== undefined ? { body: reviewBody } : {}),
        commit: commitRef,
      },
    },
  };

  let reviewStatus: "saved" | "pending" = "pending";

  const reviewAdmission = await withGraph(fh.graph, async () =>
    fh.graph.commit(by, `Review ${sha}`, [reviewOp], [], true)
  );

  if (reviewAdmission && typeof reviewAdmission === "object") {
    if ("Admitted" in reviewAdmission) {
      reviewStatus = "saved";
    } else {
      reviewStatus = "pending";
    }
  }

  // Commit 2+: create each ReviewComment node, then the part_of edge
  // Endpoints-before-edges: commit comment node first, then part_of edge
  const commentIds: string[] = [];

  for (const comment of comments) {
    const commentId = crypto.randomUUID();
    commentIds.push(commentId);

    const commentOp = {
      create: {
        kind: "node",
        id: commentId,
        type: "review/ReviewComment@1",
        attributes: {
          body: comment.body,
          ...(comment.anchor !== undefined ? { anchor: comment.anchor } : {}),
          ...(comment.span !== undefined ? { span: comment.span } : {}),
          status: "open",
        },
      },
    };

    // Commit the comment node
    await withGraph(fh.graph, async () =>
      fh.graph.commit(by, `ReviewComment for ${sha}`, [commentOp], [], true)
    );

    // Commit the part_of edge (comment → review)
    const edgeId = crypto.randomUUID();
    const edgeOp = {
      create: {
        kind: "edge",
        id: edgeId,
        type: "review/part_of@1",
        from: `node:${commentId}`,
        to: `node:${reviewId}`,
      },
    };

    await withGraph(fh.graph, async () =>
      fh.graph.commit(by, `part_of edge for comment ${commentId}`, [edgeOp], [], true)
    );
  }

  return c.json({ reviewId, commentIds, status: reviewStatus });
});

// ── GET /git/proposals/:sha/reviews ──────────────────────────────────────────

gitreviewRouter.get("/git/proposals/:sha/reviews", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  const sha = c.req.param("sha");
  if (!validateSha(sha)) {
    return c.json({ error: "invalid commit sha" }, 400);
  }
  const reviews = await listReviewsForSha(fh, sha);
  return c.json({ reviews });
});

// ── GET /git/proposals/:sha/diff ─────────────────────────────────────────────

const DIFF_SIZE_LIMIT = 1_000_000; // 1 MB — matches core cap

gitreviewRouter.get("/git/proposals/:sha/diff", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  const sha = c.req.param("sha");
  if (!validateSha(sha)) {
    return c.json({ error: "invalid commit sha" }, 400);
  }

  const proposal = await gitProposal(fh, sha);
  if (!proposal) {
    return c.json({ error: "proposal not found" }, 404);
  }

  const files = await commitDiff(fh.graphDir, sha);

  // Compute truncated flag: total patch bytes >= limit
  const totalBytes = files.reduce((sum, f) => sum + f.patch.length, 0);
  const truncated = totalBytes >= DIFF_SIZE_LIMIT;

  return c.json({ files, truncated });
});

// ── POST /git/proposals/:sha/push-notes ──────────────────────────────────────

gitreviewRouter.post("/git/proposals/:sha/push-notes", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: REPO_ONLY_ERROR }, 400);
  }

  const sha = c.req.param("sha");
  if (!validateSha(sha)) {
    return c.json({ error: "invalid commit sha" }, 400);
  }

  // Resolve the graph entry for originRemote
  const manager = c.get("manager");
  const entry = await manager.getEntry(fh.graphId);
  if (!entry) {
    return c.json({ error: "graph entry not found" }, 500);
  }

  if (!entry.originRemote) {
    return c.json({ error: "no remote configured" }, 400);
  }

  try {
    await pushNotes(fh.graphDir, entry.originRemote);
    return c.json({ pushed: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ pushed: false, pushError: msg });
  }
});
