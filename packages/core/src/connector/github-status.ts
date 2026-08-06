/**
 * @freehold/core/connector — Outbound GitHub commit status posting.
 *
 * After a successful decide on a repo graph with a configured GitHub connector,
 * posts a commit status to the origin repo's GitHub API:
 *   POST /repos/{owner}/{repo}/statuses/{sha}
 *
 * Context: "freehold/review"
 * State:   "success" (approve) / "failure" (reject)
 * Fire-and-forget: errors are returned, not thrown; callers record statusPosted.
 *
 * Works with both credential-mode PATs and App installation tokens by calling
 * the existing connector token helpers. Silent no-op when no connector configured.
 */

import type { DbHandle } from "../db.js";
import type { Freehold } from "../graphs.js";
import { makeAppClient } from "./app.js";
import { getConnector, getSecret } from "./config.js";
import { makeTokenClient, parseOriginRemote } from "./github.js";

// ── GitHubStatusResult ────────────────────────────────────────────────────────

export interface GitHubStatusResult {
  /** true when the status was successfully posted to GitHub. */
  statusPosted: boolean;
  /** Present when statusPosted is false and an error occurred. */
  statusError?: string;
}

// ── postCommitStatus ──────────────────────────────────────────────────────────

/**
 * Post a GitHub commit status for the given sha and decide outcome.
 *
 * @param fh          - Freehold handle (provides db, graphId, graphDir)
 * @param sha         - full commit sha
 * @param outcome     - "approved" or "rejected" (incomplete is not posted)
 * @param principal   - principal name that performed the decide
 * @param encKey      - AES encryption key (from deriveEncKey) for secret retrieval
 * @param targetUrl   - URL to the review page (shown in GitHub UI); optional
 * @param fetchImpl   - injectable fetch for testing
 *
 * Always resolves — never throws. Returns { statusPosted, statusError }.
 */
export async function postCommitStatus(
  fh: Freehold,
  sha: string,
  outcome: "approved" | "rejected",
  principal: string,
  encKey: Buffer,
  targetUrl?: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<GitHubStatusResult> {
  // 1. Check connector is configured for this graph
  let cfg: Awaited<ReturnType<typeof getConnector>>;
  try {
    cfg = await getConnector(fh.db, fh.graphId);
  } catch (err) {
    return { statusPosted: false, statusError: `connector lookup failed: ${String(err)}` };
  }
  if (!cfg) {
    // No connector configured — silent no-op per spec.
    return { statusPosted: false };
  }

  // 2. Determine owner/repo from originRemote stored in the graph entry.
  //    The connector config has owner/repo too but the spec says parse from originRemote.
  //    Fall back to connector config values if originRemote is missing.
  let owner: string;
  let repo: string;

  // Try to get originRemote from the graphs registry via the DB.
  const originRemoteRow = await fh.db.pg.query<{ origin_remote: string | null }>(
    "SELECT origin_remote FROM graphs WHERE id = $1",
    [fh.graphId]
  );
  const originRemote = originRemoteRow.rows[0]?.origin_remote ?? null;

  if (originRemote) {
    const parsed = parseOriginRemote(originRemote);
    if (!parsed) {
      return {
        statusPosted: false,
        statusError: `could not parse owner/repo from originRemote: ${originRemote}`,
      };
    }
    owner = parsed.owner;
    repo = parsed.repo;
  } else {
    // Fall back to connector config (already has owner/repo).
    owner = cfg.owner;
    repo = cfg.repo;
  }

  // 3. Mint a GitHub token using existing connector infrastructure.
  let client: ReturnType<typeof makeTokenClient> | null = null;
  try {
    if (cfg.mode === "credential") {
      const token = await getSecret(fh.db, fh.graphId, "credentialToken", encKey);
      if (!token) {
        return { statusPosted: false, statusError: "credential token not stored" };
      }
      client = makeTokenClient(token, fetchImpl);
    } else {
      // App mode — makeAppClient mints an installation token; may return null if app not fully configured.
      client = await makeAppClient(fh, encKey, fetchImpl);
    }
  } catch (err) {
    return { statusPosted: false, statusError: `token error: ${String(err)}` };
  }

  if (!client) {
    return {
      statusPosted: false,
      statusError: "GitHub App client unavailable (app not installed)",
    };
  }

  // 4. Build the status payload.
  const state = outcome === "approved" ? "success" : "failure";
  const description =
    outcome === "approved" ? `approved by ${principal}` : `changes requested by ${principal}`;

  const body: {
    state: string;
    description: string;
    context: string;
    target_url?: string;
  } = {
    state,
    description,
    context: "freehold/review",
  };
  if (targetUrl) {
    body.target_url = targetUrl;
  }

  // 5. POST the status.
  try {
    await client.rest(`/repos/${owner}/${repo}/statuses/${sha}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    return { statusPosted: true };
  } catch (err) {
    return { statusPosted: false, statusError: String(err) };
  }
}

// ── buildStatusPayload ────────────────────────────────────────────────────────

/**
 * Build the GitHub commit status request payload for a given decide outcome.
 * Exported for unit testing without making real HTTP calls.
 */
export function buildStatusPayload(
  outcome: "approved" | "rejected",
  principal: string,
  targetUrl?: string
): {
  state: "success" | "failure";
  description: string;
  context: string;
  target_url?: string;
} {
  const payload: {
    state: "success" | "failure";
    description: string;
    context: string;
    target_url?: string;
  } = {
    state: outcome === "approved" ? "success" : "failure",
    description:
      outcome === "approved" ? `approved by ${principal}` : `changes requested by ${principal}`,
    context: "freehold/review",
  };
  if (targetUrl) payload.target_url = targetUrl;
  return payload;
}
