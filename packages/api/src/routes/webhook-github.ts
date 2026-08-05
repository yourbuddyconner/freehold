/**
 * POST /webhooks/github — unauthenticated GitHub webhook receiver.
 *
 * Mounted BEFORE bearerAuth in app.ts. Security is entirely HMAC-based:
 *   - Match the graph by repository.full_name (owner/repo).
 *   - Verify X-Hub-Signature-256 against the graph's stored webhook secret.
 *   - Invalid signature → 401, no body detail.
 *   - Unknown repo → 204 silent drop.
 *   - Valid → normalize event → handleConnectorEvent.
 *
 * Raw-body approach: c.req.text() before JSON.parse so the HMAC is computed
 * over the original bytes (required — any re-serialization may differ).
 *
 * Never logs secrets or tokens.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  getConnector,
  getSecret,
  deriveEncKey,
  handleConnectorEvent,
  parseOriginRemote,
} from "@freehold/core";
import type { ConnectorEvent } from "@freehold/core";
import type { AppEnv } from "../types.js";

export const githubWebhookRouter = new Hono<AppEnv>();

// ── HMAC verification ─────────────────────────────────────────────────────────

function verifyWebhookSig(rawBody: string, sigHeader: string | undefined, secret: string): boolean {
  if (!sigHeader) return false;
  // An empty secret must never verify.
  if (secret.length === 0) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(sigHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Event normalization ───────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalize a GitHub webhook payload into a ConnectorEvent (or null to ignore).
 * Supports: push, pull_request, pull_request_review, issue_comment,
 *           pull_request_review_comment.
 * issue_comment with action "deleted" → tombstone.
 */
function normalizeGithubEvent(eventType: string, payload: unknown): ConnectorEvent | null {
  if (!isRecord(payload)) return null;

  // ── push ─────────────────────────────────────────────────────────────────
  if (eventType === "push") {
    const ref = typeof payload.ref === "string" ? payload.ref : "";
    const headSha =
      isRecord(payload.head_commit) && typeof payload.head_commit.id === "string"
        ? payload.head_commit.id
        : typeof payload.after === "string"
          ? payload.after
          : "";
    if (!headSha) return null;
    return { kind: "push", ref, headSha };
  }

  // ── pull_request ──────────────────────────────────────────────────────────
  if (eventType === "pull_request") {
    const action = typeof payload.action === "string" ? payload.action : "";
    const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
    if (!pr) return null;
    const number = typeof pr.number === "number" ? pr.number : 0;
    const head = isRecord(pr.head) ? pr.head : null;
    const headSha = head && typeof head.sha === "string" ? head.sha : "";
    if (!headSha) return null;
    return { kind: "pr", action, number, headSha };
  }

  // ── pull_request_review ───────────────────────────────────────────────────
  if (eventType === "pull_request_review") {
    const review = isRecord(payload.review) ? payload.review : null;
    if (!review) return null;
    const id = typeof review.id === "number" ? String(review.id) : null;
    if (!id) return null;
    const body = typeof review.body === "string" ? review.body : "";
    if (!body.trim()) return null; // ignore bodyless reviews
    const user = isRecord(review.user) ? review.user : null;
    const author = user && typeof user.login === "string" ? user.login : "";
    const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
    const prNumber = pr && typeof pr.number === "number" ? pr.number : undefined;
    const action = typeof payload.action === "string" ? payload.action : "created";
    const normalizedAction: "created" | "edited" | "deleted" =
      action === "deleted" ? "deleted" : action === "edited" ? "edited" : "created";
    return {
      kind: "comment",
      action: normalizedAction,
      id: `review:${id}`,
      body,
      author,
      prNumber,
    };
  }

  // ── issue_comment (PR conversation comments) ──────────────────────────────
  if (eventType === "issue_comment") {
    // Only handle PR comments (issue has pull_request field)
    const issue = isRecord(payload.issue) ? payload.issue : null;
    if (!issue || !isRecord(issue.pull_request)) return null;
    const comment = isRecord(payload.comment) ? payload.comment : null;
    if (!comment) return null;
    const id = typeof comment.id === "number" ? String(comment.id) : null;
    if (!id) return null;
    const body = typeof comment.body === "string" ? comment.body : "";
    const user = isRecord(comment.user) ? comment.user : null;
    const author = user && typeof user.login === "string" ? user.login : "";
    const prNumber = typeof issue.number === "number" ? issue.number : undefined;
    const action = typeof payload.action === "string" ? payload.action : "created";
    const normalizedAction: "created" | "edited" | "deleted" =
      action === "deleted" ? "deleted" : action === "edited" ? "edited" : "created";
    return {
      kind: "comment",
      action: normalizedAction,
      id: `issue:${id}`,
      body,
      author,
      prNumber,
    };
  }

  // ── pull_request_review_comment (inline code comments) ───────────────────
  if (eventType === "pull_request_review_comment") {
    const comment = isRecord(payload.comment) ? payload.comment : null;
    if (!comment) return null;
    const id = typeof comment.id === "number" ? String(comment.id) : null;
    if (!id) return null;
    const body = typeof comment.body === "string" ? comment.body : "";
    const user = isRecord(comment.user) ? comment.user : null;
    const author = user && typeof user.login === "string" ? user.login : "";
    const path = typeof comment.path === "string" ? comment.path : undefined;
    const commitSha = typeof comment.commit_id === "string" ? comment.commit_id : undefined;
    const inReplyTo =
      typeof comment.in_reply_to_id === "number"
        ? String(comment.in_reply_to_id)
        : undefined;
    const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
    const prNumber = pr && typeof pr.number === "number" ? pr.number : undefined;
    const action = typeof payload.action === "string" ? payload.action : "created";
    const normalizedAction: "created" | "edited" | "deleted" =
      action === "deleted" ? "deleted" : action === "edited" ? "edited" : "created";
    return {
      kind: "comment",
      action: normalizedAction,
      id,
      body,
      author,
      path,
      commitSha,
      inReplyTo,
      prNumber,
    };
  }

  return null;
}

// ── Route ─────────────────────────────────────────────────────────────────────

githubWebhookRouter.post("/webhooks/github", async (c) => {
  // Use c.req.text() to get raw body BEFORE JSON.parse so HMAC is computed
  // over the exact bytes GitHub signed.
  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return c.body(null, 400);
  }

  // Parse the repository.full_name from the payload to find the matching graph.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.body(null, 400);
  }

  if (!isRecord(payload)) return c.body(null, 204);

  // Extract owner/repo from repository.full_name
  const repository = isRecord(payload.repository) ? payload.repository : null;
  const fullName = repository && typeof repository.full_name === "string" ? repository.full_name : null;

  if (!fullName) {
    // No repo to match — probably a ping or unrecognized event shape.
    return c.body(null, 204);
  }

  const [repoOwner, repoName] = fullName.split("/");
  if (!repoOwner || !repoName) return c.body(null, 204);

  // Walk all known graphs to find one with matching owner/repo
  const manager = c.get("manager");
  const config = c.get("config");
  const encKey = deriveEncKey(config.token);

  const entries = await manager.list();

  let matchedFh = null;
  let matchedWebhookSecret: string | null = null;

  for (const entry of entries) {
    // Only consider repo graphs
    if (entry.kind !== "repo") continue;

    // Parse the graph's origin remote
    if (!entry.originRemote) continue;
    const parsed = parseOriginRemote(entry.originRemote);
    if (!parsed) continue;
    if (parsed.owner.toLowerCase() !== repoOwner.toLowerCase()) continue;
    if (parsed.repo.toLowerCase() !== repoName.toLowerCase()) continue;

    // Found a candidate — check if it has a connector config
    try {
      const fh = await manager.get(entry.id);
      const cfg = await getConnector(fh.db, entry.id);
      if (!cfg) continue;

      // Get the webhook secret for this graph
      const secret = await getSecret(fh.db, entry.id, "webhookSecret", encKey);
      if (!secret) continue;

      matchedFh = fh;
      matchedWebhookSecret = secret;
      break;
    } catch {
      continue;
    }
  }

  // Unknown repo → 204 silent
  if (!matchedFh || matchedWebhookSecret === null) {
    return c.body(null, 204);
  }

  // Verify HMAC
  const sigHeader = c.req.header("x-hub-signature-256");
  if (!verifyWebhookSig(rawBody, sigHeader, matchedWebhookSecret)) {
    return c.body(null, 401);
  }

  // Normalize and dispatch the event
  const eventType = c.req.header("x-github-event") ?? "";
  const ev = normalizeGithubEvent(eventType, payload);
  if (ev) {
    try {
      await handleConnectorEvent(matchedFh, ev);
    } catch {
      // Log but do not expose detail; return 204 so GitHub doesn't retry endlessly.
      console.error("github-webhook: handleConnectorEvent failed");
    }
  }

  return c.body(null, 204);
});
