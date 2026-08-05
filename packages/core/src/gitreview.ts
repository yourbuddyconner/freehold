/**
 * @freehold/core — Git proposal enumeration and two-phase signed decide.
 *
 * Enumerates branch heads, evaluates each commit against the graph's git-substrate
 * policy via wasm (git_checklist / git_satisfaction), and decides via the two-phase
 * seam (git_decision_payload → keys.ts sign → git_decision_attach → appendDecision →
 * optional pushNotes).
 *
 * No policy logic lives in this file. All evaluation is wasm-only.
 * All wasm calls go through withGraph.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { codeFile, codeRegions } from "./codeview.js";
import {
  appendDecision,
  branchHeads,
  commitMeta,
  diffTreeOps,
  headSha,
  pushNotes,
  readDecisions,
} from "./git.js";
import type { Freehold } from "./graphs.js";
import * as keys from "./keys.js";
import { withGraph } from "./lock.js";

// ── KeyMissingError ───────────────────────────────────────────────────────────

/**
 * Thrown by decideGit when the signing key for the given principal cannot be found
 * in any searched location. The `message` lists the locations tried.
 */
export class KeyMissingError extends Error {
  readonly code = "key-missing" as const;
  constructor(message: string) {
    super(message);
    this.name = "KeyMissingError";
  }
}

// ── GitProposal ───────────────────────────────────────────────────────────────

export interface GitProposal {
  sha: string;
  ref: string;
  author: string;
  timestamp: string;
  message: string;
  /** The ref evaluated against, e.g. refs/heads/main. */
  target: string;
  /** Rule names matched by git_checklist. */
  matched: string[];
  /** Wasm checklist entries (role requirements) as returned by git_checklist. */
  checklist: unknown[];
  /** Unmet role requirements from git_satisfaction with current note decisions. */
  unmet: string[];
  decided: "undecided" | "approved" | "rejected";
  paths: Array<{ verb: string; path: string; regions: string[]; indexed: boolean }>;
  /** CI check runs from the check_status table for this sha. */
  checks: Array<{ name: string; status: string; conclusion?: string }>;
}

// ── DecideResult ──────────────────────────────────────────────────────────────

export type DecideResult =
  | { outcome: "approved" | "rejected"; pushed: boolean; pushSkipped?: boolean; pushError?: string }
  | { outcome: "incomplete"; unmet: string[] };

// ── Internal wasm cast helpers ────────────────────────────────────────────────

/** git_checklist result shape (absent from @allod/core TS type; cast with explanatory comment). */
interface ChecklistResult {
  matched: string[];
  checklist: unknown;
}

/** git_satisfaction result shape. */
interface SatisfactionResult {
  unmet: string[];
}

/** git_decision_payload result shape. */
interface DecisionPayloadResult {
  record: unknown;
  payload: string;
}

/**
 * Call git_checklist on the wasm graph.
 * The method is not in the @allod/core TS type export — cast via unknown as done in codeview.ts.
 */
function wasmGitChecklist(
  graph: unknown,
  repo: string,
  targetRef: string,
  ops: [string, string][]
): ChecklistResult {
  return (
    graph as {
      git_checklist(repo: string, target_ref: string, ops: [string, string][]): ChecklistResult;
    }
  ).git_checklist(repo, targetRef, ops);
}

/**
 * Call git_satisfaction on the wasm graph.
 */
function wasmGitSatisfaction(
  graph: unknown,
  subject: string,
  checklist: unknown,
  decisions: unknown[]
): SatisfactionResult {
  return (
    graph as {
      git_satisfaction(
        subject: string,
        checklist: unknown,
        decisions: unknown[]
      ): SatisfactionResult;
    }
  ).git_satisfaction(subject, checklist, decisions);
}

/**
 * Call git_decision_payload on the wasm graph.
 */
function wasmGitDecisionPayload(
  graph: unknown,
  subject: string,
  verdict: string
): DecisionPayloadResult {
  return (
    graph as {
      git_decision_payload(subject: string, verdict: string): DecisionPayloadResult;
    }
  ).git_decision_payload(subject, verdict);
}

/**
 * Call git_decision_attach on the wasm graph.
 */
function wasmGitDecisionAttach(
  graph: unknown,
  record: unknown,
  principal: string,
  signature: string
): unknown {
  return (
    graph as {
      git_decision_attach(record: unknown, principal: string, signature: string): unknown;
    }
  ).git_decision_attach(record, principal, signature);
}

// ── decided status from note decisions ────────────────────────────────────────

/**
 * Derive the decided status from stored decisions.
 * A sha is "approved" if any decision has verdict "approve"; "rejected" if any has "reject".
 * Rejection takes precedence over approval (mirrors allod: rejected stays decided).
 */
function decidedStatus(decisions: unknown[]): "undecided" | "approved" | "rejected" {
  let approved = false;
  for (const d of decisions) {
    const record = d as Record<string, unknown>;
    const verdict = record.verdict as string | undefined;
    if (verdict === "reject") return "rejected";
    if (verdict === "approve") approved = true;
  }
  return approved ? "approved" : "undecided";
}

// ── evaluateSha ───────────────────────────────────────────────────────────────

/**
 * Evaluate a single sha against the graph's git policy.
 * Returns the GitProposal shape (without sha/ref/author/timestamp/message — those are merged in).
 */
async function evaluateSha(
  fh: Freehold,
  sha: string,
  ref: string,
  repoName: string
): Promise<GitProposal> {
  const meta = await commitMeta(fh.graphDir, sha);

  // Determine target ref: the ref this sha is the head of
  const target = ref;

  // Get diff ops for this sha
  const ops = await diffTreeOps(fh.graphDir, sha);

  // Call git_checklist via wasm
  let checklistResult: ChecklistResult = { matched: [], checklist: {} };
  try {
    checklistResult = await withGraph(fh.graph, () =>
      wasmGitChecklist(fh.graph, repoName, target, ops)
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // No policy installed → no rules match; any other error surfaces
    if (!/no.?policy/i.test(msg) && !/not found/i.test(msg)) {
      throw err;
    }
  }

  const matched = Array.isArray(checklistResult.matched) ? checklistResult.matched : [];
  const checklist = checklistResult.checklist;

  // Read existing note decisions for this sha
  const decisions = await readDecisions(fh.graphDir, sha);

  // Call git_satisfaction to get unmet requirements
  const subject = `git:${sha}`;
  let unmet: string[] = [];
  try {
    const satResult = await withGraph(fh.graph, () =>
      wasmGitSatisfaction(fh.graph, subject, checklist, decisions)
    );
    unmet = Array.isArray(satResult.unmet) ? satResult.unmet : [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no.?policy/i.test(msg) && !/not found/i.test(msg)) {
      throw err;
    }
  }

  // Decided status from decisions
  const decided = decidedStatus(decisions);

  // Build paths with region badges and indexed flags
  // Get region rules once (cached) for this graph + repo
  let regionRules: Awaited<ReturnType<typeof codeRegions>> = [];
  try {
    regionRules = await codeRegions(fh, repoName);
  } catch {
    // If codeRegions fails (e.g. no SourceFile nodes) — treat as empty
  }

  const paths = await Promise.all(
    ops.map(async ([verb, path]) => {
      // Region badges: which rules match this path
      const pathRegions = regionRules
        .filter((rule) => rule.paths.includes(path))
        .map((rule) => rule.rule);

      // Indexed: does a SourceFile node exist for this path?
      let indexed = false;
      try {
        const file = await codeFile(fh, path);
        indexed = file !== null;
      } catch {
        // treat as not indexed
      }

      return { verb, path, regions: pathRegions, indexed };
    })
  );

  // Query check_status for this sha
  let checks: Array<{ name: string; status: string; conclusion?: string }> = [];
  try {
    const rows = await fh.db.pg.query<{ name: string; status: string; conclusion: string | null }>(
      "SELECT name, status, conclusion FROM check_status WHERE graph_id = $1 AND sha = $2",
      [fh.graphId, sha]
    );
    checks = rows.rows.map((r) => ({
      name: r.name,
      status: r.status,
      ...(r.conclusion != null ? { conclusion: r.conclusion } : {}),
    }));
  } catch {
    // Table may not exist yet — treat as no checks
  }

  return {
    sha,
    ref,
    author: meta.author,
    timestamp: meta.timestamp,
    message: meta.message,
    target,
    matched,
    checklist: Array.isArray(checklist)
      ? checklist
      : checklist && typeof checklist === "object"
        ? [checklist]
        : [],
    unmet,
    decided,
    paths,
    checks,
  };
}

// ── listGitProposals ──────────────────────────────────────────────────────────

/**
 * List all branch heads (and HEAD) as GitProposals. Lists all tips regardless
 * of decided state so the Inbox can show both undecided and recent outcomes.
 */
export async function listGitProposals(fh: Freehold): Promise<GitProposal[]> {
  const repoName = basename(fh.graphDir);

  // Collect branch heads
  const heads = await branchHeads(fh.graphDir);

  // Also include HEAD if it differs from all branch heads
  const headRef = "HEAD";
  let headCommitSha: string;
  try {
    headCommitSha = await headSha(fh.graphDir);
    const headAlreadyCovered = heads.some((h) => h.sha === headCommitSha);
    if (!headAlreadyCovered) {
      heads.push({ ref: headRef, sha: headCommitSha });
    }
  } catch {
    // ignore if HEAD is unresolvable (empty repo)
  }

  // Deduplicate shas — multiple refs may point to the same sha
  const seenShas = new Set<string>();
  const proposals: GitProposal[] = [];
  for (const { ref, sha } of heads) {
    if (seenShas.has(sha)) continue;
    seenShas.add(sha);
    const proposal = await evaluateSha(fh, sha, ref, repoName);
    proposals.push(proposal);
  }

  return proposals;
}

// ── gitProposal ───────────────────────────────────────────────────────────────

/**
 * Return the GitProposal for a single sha, or null if the sha is unknown to git.
 */
export async function gitProposal(fh: Freehold, sha: string): Promise<GitProposal | null> {
  const repoName = basename(fh.graphDir);
  try {
    // commitMeta throws if sha is unknown
    await commitMeta(fh.graphDir, sha);
  } catch {
    return null;
  }

  // Find which ref this sha belongs to (best-effort; fallback to sha itself)
  let ref = sha;
  try {
    const heads = await branchHeads(fh.graphDir);
    const found = heads.find((h) => h.sha === sha);
    if (found) ref = found.ref;
  } catch {
    // keep ref = sha
  }

  return evaluateSha(fh, sha, ref, repoName);
}

// ── decideGit ─────────────────────────────────────────────────────────────────

/**
 * Two-phase signed decide for a git commit sha.
 *
 * 1. git_decision_payload("git:<sha>", verdict) → {record, payload}
 * 2. keys.resolveKey — throws KeyMissingError on failure
 * 3. keys.signPayload → git_decision_attach(record, principal, sig)
 * 4. appendDecision(graphDir, sha, signedRecord)
 * 5. Re-evaluate satisfaction; if unmet non-empty AND verdict="approve" → outcome "incomplete"
 * 6. autoPushNotes && originRemote → pushNotes; failure → pushed:false + pushError
 */
export async function decideGit(
  fh: Freehold,
  sha: string,
  verdict: "approve" | "reject",
  principal: string,
  entry: {
    allodGraphId: string;
    autoPushNotes: boolean;
    originRemote: string | null;
  }
): Promise<DecideResult> {
  const subject = `git:${sha}`;

  // Phase 1: build unsigned decision record + payload
  const { record, payload } = await withGraph(fh.graph, () =>
    wasmGitDecisionPayload(fh.graph, subject, verdict)
  );

  // Resolve key — wrap plain Error from resolveKey into KeyMissingError
  let resolvedKey: Awaited<ReturnType<typeof keys.resolveKey>>;
  try {
    resolvedKey = await keys.resolveKey(entry.allodGraphId, principal, {
      repoDir: fh.graphDir,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new KeyMissingError(msg);
  }

  // Sign the payload
  const signature = await keys.signPayload(resolvedKey, payload, entry.allodGraphId, {
    repoDir: fh.graphDir,
  });

  // Phase 2: attach decider signature to record.
  // git_decision_attach (Rust: attach_decider) prepends "principal:" to the name — pass bare name.
  const signedRecord = await withGraph(fh.graph, () =>
    wasmGitDecisionAttach(fh.graph, record, principal, signature)
  );

  // Persist the decision to notes
  await appendDecision(fh.graphDir, sha, signedRecord);

  // Re-evaluate satisfaction with the new decisions
  let finalUnmet: string[] = [];
  if (verdict === "approve") {
    // Only check satisfaction for approve; reject is always decided
    const decisions = await readDecisions(fh.graphDir, sha);

    // We need the checklist to re-evaluate. Get it from a fresh diffTreeOps + git_checklist.
    const ops = await diffTreeOps(fh.graphDir, sha);
    const repoName = basename(fh.graphDir);

    // Determine the ref this sha is on
    let targetRef = "refs/heads/main";
    try {
      const heads = await branchHeads(fh.graphDir);
      const found = heads.find((h) => h.sha === sha);
      if (found) targetRef = found.ref;
    } catch {
      // keep default
    }

    let checklist: unknown = {};
    try {
      const cl = await withGraph(fh.graph, () =>
        wasmGitChecklist(fh.graph, repoName, targetRef, ops)
      );
      checklist = cl.checklist;
    } catch {
      // no policy → unmet stays empty
    }

    try {
      const satResult = await withGraph(fh.graph, () =>
        wasmGitSatisfaction(fh.graph, subject, checklist, decisions)
      );
      finalUnmet = Array.isArray(satResult.unmet) ? satResult.unmet : [];
    } catch {
      // treat as satisfied
    }

    if (finalUnmet.length > 0) {
      return { outcome: "incomplete", unmet: finalUnmet };
    }
  }

  // Attempt push
  const outcome = verdict === "approve" ? "approved" : "rejected";
  if (entry.autoPushNotes && entry.originRemote) {
    try {
      await pushNotes(fh.graphDir, entry.originRemote);
      return { outcome, pushed: true };
    } catch (err: unknown) {
      const pushError = err instanceof Error ? err.message : String(err);
      return { outcome, pushed: false, pushError };
    }
  }

  return { outcome, pushed: false, pushSkipped: true };
}

// ── ReviewEntry + listReviewsForSha ──────────────────────────────────────────

export interface ReviewCommentEntry {
  commentId: string;
  body?: string;
  anchor?: string;
  span?: string;
  status: string;
}

export interface ReviewEntry {
  reviewId: string;
  verdict: string;
  body?: string;
  /** commit attribute value — contains the sha the review was posted against */
  commit: string;
  author: string;
  /** saved = admitted; pending = held in governance queue */
  status: "saved" | "pending";
  comments: ReviewCommentEntry[];
}

interface RawLogEntry {
  hash: string;
  author: string;
  op_count: number;
  intent: string;
}

/**
 * List all review/Review@1 and their review/ReviewComment@1 nodes for a
 * given git commit sha.
 *
 * Scans admitted changesets (via freehold.graph.log() + changeset YAML files) and
 * pending proposals (via freehold.graph.proposals() + proposal_get) so results are
 * available without syncIndex having been called.
 */

interface RawPendingProposal {
  hash: string;
  intent: string;
  author: string;
}

interface RawPendingChangeset {
  hash?: string;
  intent?: string;
  author?: { principal?: string } | string;
  operations?: Array<Record<string, unknown>>;
}

/**
 * Parse review-related operations from a changeset operations array into the
 * shared maps. Status is passed in so admitted vs pending can be distinguished.
 */
function parseChangesetOps(
  operations: Array<Record<string, unknown>>,
  author: string,
  status: "saved" | "pending",
  sha: string,
  repoBasename: string,
  reviews: Map<
    string,
    { attrs: Record<string, unknown>; author: string; status: "saved" | "pending" }
  >,
  comments: Map<string, { attrs: Record<string, unknown>; author: string }>,
  commentToReview: Map<string, string>
): void {
  // Accept both canonical `git:<repo>#<sha>` and the bare sha (back-compat with
  // any changesets written before the canonical format was adopted).
  const canonicalRef = `git:${repoBasename}#${sha}`;

  for (const op of operations) {
    if (!op || typeof op !== "object" || Array.isArray(op)) continue;
    const o = op as Record<string, unknown>;
    const inner = o.create as Record<string, unknown> | undefined;
    if (!inner || typeof inner !== "object") continue;

    // Review node
    if (
      inner.kind === "node" &&
      typeof inner.type === "string" &&
      inner.type.startsWith("review/Review")
    ) {
      const attrs = (inner.attributes as Record<string, unknown> | undefined) ?? {};
      const commit = attrs.commit as string | undefined;
      if (commit && (commit === canonicalRef || commit === sha)) {
        reviews.set(inner.id as string, { attrs, author, status });
      }
    }

    // ReviewComment node
    if (
      inner.kind === "node" &&
      typeof inner.type === "string" &&
      inner.type.startsWith("review/ReviewComment")
    ) {
      const attrs = (inner.attributes as Record<string, unknown> | undefined) ?? {};
      comments.set(inner.id as string, { attrs, author });
    }

    // part_of edge (from=comment node:..., to=review node:...)
    if (
      inner.kind === "edge" &&
      typeof inner.type === "string" &&
      inner.type.startsWith("review/part_of")
    ) {
      const from = typeof inner.from === "string" ? inner.from.replace(/^node:/, "") : null;
      const to = typeof inner.to === "string" ? inner.to.replace(/^node:/, "") : null;
      if (from && to) {
        commentToReview.set(from, to);
      }
    }
  }
}

export async function listReviewsForSha(fh: Freehold, sha: string): Promise<ReviewEntry[]> {
  const repoBasename = basename(fh.graphDir);

  // Maps: nodeId → { attrs, author, status }
  const reviews = new Map<
    string,
    { attrs: Record<string, unknown>; author: string; status: "saved" | "pending" }
  >();
  const comments = new Map<string, { attrs: Record<string, unknown>; author: string }>();
  // part_of edge: commentId → reviewId
  const commentToReview = new Map<string, string>();

  // ── 1. Admitted changesets ────────────────────────────────────────────────
  const log = await withGraph(fh.graph, () => {
    return (fh.graph as unknown as { log(): RawLogEntry[] }).log();
  });

  if (Array.isArray(log)) {
    const csDir = join(fh.graphDir, ".allod", "changesets");

    for (const entry of log) {
      const bareHash = entry.hash.replace("sha256:", "");
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

      const authorRef = entry.author ?? "";
      const author = authorRef.startsWith("principal:")
        ? authorRef.slice("principal:".length)
        : authorRef;

      // Admitted log entries are saved
      parseChangesetOps(
        operations as Array<Record<string, unknown>>,
        author,
        "saved",
        sha,
        repoBasename,
        reviews,
        comments,
        commentToReview
      );
    }
  }

  // ── 2. Pending proposals ──────────────────────────────────────────────────
  // proposals() returns the queue of held changesets awaiting governance approval.
  // Each may contain review/Review@1 nodes that are visible via POST but not yet
  // in the admitted log.
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

      parseChangesetOps(
        cs.operations as Array<Record<string, unknown>>,
        author,
        "pending",
        sha,
        repoBasename,
        reviews,
        comments,
        commentToReview
      );
    }
  });

  // Group comments by review
  const reviewComments = new Map<string, ReviewCommentEntry[]>();
  for (const [commentId, reviewId] of commentToReview) {
    if (reviews.has(reviewId)) {
      if (!reviewComments.has(reviewId)) reviewComments.set(reviewId, []);
      const c = comments.get(commentId);
      if (c) {
        reviewComments.get(reviewId)?.push({
          commentId,
          body: c.attrs.body as string | undefined,
          anchor: c.attrs.anchor as string | undefined,
          span: c.attrs.span as string | undefined,
          status: (c.attrs.status as string | undefined) ?? "open",
        });
      }
    }
  }

  return Array.from(reviews.entries()).map(([reviewId, { attrs, author, status }]) => ({
    reviewId,
    verdict: attrs.verdict as string,
    body: attrs.body as string | undefined,
    commit: attrs.commit as string,
    author,
    status,
    comments: reviewComments.get(reviewId) ?? [],
  }));
}
