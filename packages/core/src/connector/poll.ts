/**
 * @freehold/core/connector — Polling transport.
 *
 * pollOnce: fetch open PRs → per-PR comments/reviews/check-runs → emit ConnectorEvents.
 * Tombstone detection: compare previously-ingested external_ids (stored in connector_cursor
 * state jsonb) against the current comment listing for each open PR. An id that was ingested
 * in a previous poll but is absent from the current listing while its PR is still open is
 * emitted as a tombstone event.
 *
 * startPoller: setInterval loop respecting pollIntervalSec; skips overlapping runs; errors
 * recorded to cursor state; never crashes the daemon.
 *
 * All GitHub access goes through the injected GithubClient. Never logs tokens.
 */

import type { Freehold } from "../graphs.js";
import type { ConnectorConfig } from "./config.js";
import type { GithubClient } from "./github.js";
import { handleConnectorEvent } from "./events.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PollResult {
  events: number;
  errors: string[];
}

// Cursor state stored in connector_cursor.state jsonb.
// We track the set of external_ids (as "<prNumber>:<id>") that were ingested for each
// open PR so we can detect deletions on the next poll.
interface CursorState {
  // Map of prNumber (string) → array of ingested external_ids seen in last poll
  ingestedIdsByPr: Record<string, string[]>;
  lastErrors?: string[];
}

// ── GitHub REST shapes ────────────────────────────────────────────────────────

interface GhPr {
  number: number;
  head: { sha: string; ref: string };
}

interface GhReviewComment {
  id: number;
  body: string;
  user: { login: string };
  path?: string;
  commit_id?: string;
  in_reply_to_id?: number;
}

interface GhIssueComment {
  id: number;
  body: string;
  user: { login: string };
}

interface GhReview {
  id: number;
  body: string;
  user: { login: string };
  state: string;
}

interface GhCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

interface GhCheckRunsResponse {
  check_runs: GhCheckRun[];
}

// ── Cursor helpers ────────────────────────────────────────────────────────────

async function ensureCursorTable(fh: Freehold): Promise<void> {
  await fh.db.pg.exec(`
    CREATE TABLE IF NOT EXISTS connector_cursor (
      graph_id      text PRIMARY KEY,
      last_poll_at  timestamptz,
      state         jsonb NOT NULL DEFAULT '{}'
    )
  `);
}

async function readCursor(fh: Freehold): Promise<CursorState> {
  await ensureCursorTable(fh);
  const result = await fh.db.pg.query<{ state: unknown }>(
    `SELECT state FROM connector_cursor WHERE graph_id = $1`,
    [fh.graphId]
  );
  if (result.rows.length === 0) return { ingestedIdsByPr: {} };
  const raw = result.rows[0].state;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as CursorState;
  }
  return { ingestedIdsByPr: {} };
}

async function writeCursor(fh: Freehold, state: CursorState): Promise<void> {
  await ensureCursorTable(fh);
  await fh.db.pg.query(
    `INSERT INTO connector_cursor (graph_id, last_poll_at, state)
     VALUES ($1, now(), $2)
     ON CONFLICT (graph_id) DO UPDATE SET
       last_poll_at = now(),
       state        = EXCLUDED.state`,
    [fh.graphId, JSON.stringify(state)]
  );
}

async function writeCursorError(fh: Freehold, errors: string[]): Promise<void> {
  await ensureCursorTable(fh);
  await fh.db.pg.query(
    `INSERT INTO connector_cursor (graph_id, last_poll_at, state)
     VALUES ($1, now(), $2)
     ON CONFLICT (graph_id) DO UPDATE SET
       last_poll_at = now(),
       state        = connector_cursor.state || $2::jsonb`,
    [fh.graphId, JSON.stringify({ lastErrors: errors })]
  );
}

// ── pollOnce ──────────────────────────────────────────────────────────────────

/**
 * Run a single poll cycle:
 *   1. List open PRs
 *   2. Per PR: review comments + issue comments + reviews → comment events
 *      Tombstone: any external_id seen in the previous poll that is absent now (PR still open)
 *   3. Branch-head SHAs → check-runs → check events
 *   4. Update cursor with the new set of ingested ids
 */
export async function pollOnce(
  fh: Freehold,
  cfg: ConnectorConfig,
  client: GithubClient
): Promise<PollResult> {
  const { owner, repo } = cfg;
  const errors: string[] = [];
  let eventCount = 0;

  // Load cursor state (previously ingested ids per PR)
  const cursorState = await readCursor(fh);
  const prevIdsByPr = cursorState.ingestedIdsByPr ?? {};

  // 1. List open PRs
  let openPrs: GhPr[] = [];
  try {
    openPrs = await client.rest<GhPr[]>(
      `/repos/${owner}/${repo}/pulls?state=open&per_page=100`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`list-prs: ${msg}`);
    await writeCursorError(fh, errors);
    return { events: eventCount, errors };
  }

  const newIdsByPr: Record<string, string[]> = {};

  // 2. Per PR: gather comments and emit events
  for (const pr of openPrs) {
    const prKey = String(pr.number);
    const currentIds: string[] = [];

    // Collect all comments from this PR
    const allCommentIds: string[] = [];

    try {
      // Review comments (inline code comments)
      const reviewComments = await client.rest<GhReviewComment[]>(
        `/repos/${owner}/${repo}/pulls/${pr.number}/comments?per_page=100`
      );
      for (const rc of reviewComments) {
        const extId = String(rc.id);
        currentIds.push(extId);
        allCommentIds.push(extId);
        await handleConnectorEvent(fh, {
          kind: "comment",
          action: "created",
          id: extId,
          body: rc.body,
          author: rc.user.login,
          path: rc.path,
          commitSha: rc.commit_id,
          prNumber: pr.number,
          inReplyTo: rc.in_reply_to_id ? String(rc.in_reply_to_id) : undefined,
        });
        eventCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`pr-${pr.number}-review-comments: ${msg}`);
    }

    try {
      // Issue comments (general PR conversation)
      const issueComments = await client.rest<GhIssueComment[]>(
        `/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`
      );
      for (const ic of issueComments) {
        const extId = `issue:${ic.id}`;
        currentIds.push(extId);
        allCommentIds.push(extId);
        await handleConnectorEvent(fh, {
          kind: "comment",
          action: "created",
          id: extId,
          body: ic.body,
          author: ic.user.login,
          prNumber: pr.number,
        });
        eventCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`pr-${pr.number}-issue-comments: ${msg}`);
    }

    try {
      // Reviews (aggregate review submissions with body text)
      const reviews = await client.rest<GhReview[]>(
        `/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=100`
      );
      for (const rv of reviews) {
        if (!rv.body || rv.body.trim() === "") continue; // skip bodyless reviews
        const extId = `review:${rv.id}`;
        currentIds.push(extId);
        allCommentIds.push(extId);
        await handleConnectorEvent(fh, {
          kind: "comment",
          action: "created",
          id: extId,
          body: rv.body,
          author: rv.user.login,
          prNumber: pr.number,
        });
        eventCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`pr-${pr.number}-reviews: ${msg}`);
    }

    // Tombstone detection: ids that were in the previous poll but absent now
    const prevIds = prevIdsByPr[prKey] ?? [];
    const currentIdSet = new Set(currentIds);
    for (const prevId of prevIds) {
      if (!currentIdSet.has(prevId)) {
        // Previously ingested, now absent while PR is open → tombstone
        try {
          await handleConnectorEvent(fh, {
            kind: "comment",
            action: "deleted",
            id: prevId,
            body: "",
            author: "",
            prNumber: pr.number,
          });
          eventCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`tombstone-${prevId}: ${msg}`);
        }
      }
    }

    newIdsByPr[prKey] = currentIds;
  }

  // 3. Branch-head SHAs → check-runs
  const seenShas = new Set<string>();
  for (const pr of openPrs) {
    const sha = pr.head.sha;
    if (seenShas.has(sha)) continue;
    seenShas.add(sha);

    try {
      const response = await client.rest<GhCheckRunsResponse>(
        `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`
      );
      for (const cr of response.check_runs) {
        await handleConnectorEvent(fh, {
          kind: "check",
          sha,
          name: cr.name,
          status: cr.status,
          conclusion: cr.conclusion ?? undefined,
        });
        eventCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`check-runs-${sha}: ${msg}`);
    }
  }

  // 4. Update cursor
  const newState: CursorState = { ingestedIdsByPr: newIdsByPr };
  if (errors.length > 0) newState.lastErrors = errors;
  await writeCursor(fh, newState);

  return { events: eventCount, errors };
}

// ── startPoller ───────────────────────────────────────────────────────────────

/**
 * Start a polling loop for the given graph.
 *
 * The cfg and client providers are called on each tick so the poller picks up
 * config changes (including null → poller self-disables if config is removed).
 *
 * Skips overlapping runs. Errors are recorded to cursor state but never crash
 * the daemon. Returns { stop() } to cancel the interval.
 */
export function startPoller(
  fh: Freehold,
  cfgProvider: () => Promise<ConnectorConfig | null>,
  clientProvider: (cfg: ConnectorConfig) => Promise<GithubClient>
): { stop(): void } {
  let running = false;

  async function tick(): Promise<void> {
    if (running) return; // skip overlapping run
    running = true;
    try {
      const cfg = await cfgProvider();
      if (!cfg) return; // no config — skip
      const client = await clientProvider(cfg);
      await pollOnce(fh, cfg, client);
    } catch (err) {
      // Record error to cursor; never throw
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await writeCursorError(fh, [msg]);
      } catch {
        // ignore cursor write failure
      }
    } finally {
      running = false;
    }
  }

  // Determine interval from initial config (best-effort; changes picked up via cfgProvider)
  let intervalMs = 300_000; // default 5 min
  // Kick off an async read of config to get the real interval
  cfgProvider()
    .then((cfg) => {
      if (cfg) intervalMs = cfg.pollIntervalSec * 1000;
    })
    .catch(() => {});

  // Use a polling approach where we re-read the interval each tick
  // Since setInterval doesn't support dynamic intervals, we use a recursive setTimeout approach.
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  async function schedule(): Promise<void> {
    if (stopped) return;
    try {
      const cfg = await cfgProvider();
      if (cfg) intervalMs = cfg.pollIntervalSec * 1000;
    } catch { /* ignore */ }
    await tick();
    if (!stopped) {
      timeoutId = setTimeout(() => void schedule(), intervalMs);
    }
  }

  // Use setInterval for the poller (simpler, compatible with fake timers in tests)
  // We use a fixed interval based on the initial config; the cfgProvider is re-called
  // each tick for the actual poll but the interval doesn't change dynamically.
  let intervalId: ReturnType<typeof setInterval> | null = null;

  // Start with a best-effort config read, then set the interval
  cfgProvider()
    .then((cfg) => {
      if (cfg) intervalMs = cfg.pollIntervalSec * 1000;
      if (!stopped) {
        intervalId = setInterval(() => void tick(), intervalMs);
      }
    })
    .catch(() => {
      // Fall back to default interval
      if (!stopped) {
        intervalId = setInterval(() => void tick(), intervalMs);
      }
    });

  return {
    stop() {
      stopped = true;
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}
