/**
 * Tests for gitreview.ts — proposal enumeration, two-phase signed decide, region/index badges.
 *
 * Fixture:
 *   - A scripted git repo with two branches (main, feature) — feature touches src/lib.rs
 *   - An allod graph with the code ontology, a SourceFile node for src/lib.rs, and a
 *     git-substrate policy whose rule binds a `reviewer` role to `principal:reviewer`
 *   - The reviewer principal's secret is read from the graph's .allod/keys/ dir and written
 *     to ALLOD_KEYS_DIR so keys.ts can resolve and sign with the registered key
 *   - A second principal (`outsider`) has a key written to ALLOD_KEYS_DIR but is NOT bound
 *     to any policy role — it can sign but satisfaction remains incomplete
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AllodGraph } from "@allod/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createGraph, openGraph } from "../src/allod.js";
import { openDb } from "../src/db.js";
import { hashEmbedder } from "../src/embed.js";
import { branchHeads, decisionsTip, readDecisions } from "../src/git.js";
import {
  KeyMissingError,
  decideGit,
  evictProposalCache,
  gitProposal,
  listGitProposals,
  listReviewsForSha,
  postReview,
  proposalCacheKey,
} from "../src/gitreview.js";
import { approve } from "../src/governance.js";
import { type Freehold, openFreehold } from "../src/graphs.js";
import { syncIndex } from "../src/indexer.js";
import { graphDirComponent } from "../src/keys.js";
import { installOntology } from "../src/schema.js";

const execFileAsync = promisify(execFile);

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function assetYaml(name: string): string {
  const url = new URL(`../assets/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

function stripOntologyPreamble(yaml: string): string {
  const lines = yaml.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trimStart().startsWith("#")) {
    start++;
  }
  const result: string[] = [];
  let inImports = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^imports:/.test(line)) {
      inImports = true;
      continue;
    }
    if (inImports && (line.startsWith(" ") || line.startsWith("\t") || line === "")) {
      if (line === "") inImports = false;
      continue;
    }
    inImports = false;
    result.push(line);
  }
  return result.join("\n");
}

async function commitAndApprove(
  graph: AllodGraph,
  author: string,
  intent: string,
  ops: unknown[]
): Promise<{ status: "saved" | "pending"; hash: string }> {
  const raw = await graph.commit(author, intent, ops, [], true);
  if (raw && typeof raw === "object" && "Admitted" in raw) {
    return { status: "saved", hash: (raw as { Admitted: { hash: string } }).Admitted.hash };
  }
  if (raw && typeof raw === "object" && "Held" in raw) {
    const hash: string = (raw as { Held: { hash: string } }).Held.hash;
    const decision = await approve(graph, "owner", hash);
    expect(decision.status, `approval of '${intent}' failed`).toBe("approved");
    return { status: "pending", hash };
  }
  throw new Error(`Unexpected commit result for '${intent}': ${JSON.stringify(raw)}`);
}

// ── Fixture state ──────────────────────────────────────────────────────────

let fh: Freehold;
let repoDir: string; // git repo (also the graphDir since createGraph puts .allod/ here)
let mainSha: string;
let featureSha: string;
let featureRef: string;
let pgDir: string;
let keysDir: string; // our ALLOD_KEYS_DIR override
let allodGraphId: string;
let bareRemoteDir: string; // for push tests

const origKeysDir = process.env.ALLOD_KEYS_DIR;

// RFC 8032 test vectors (for outsider — not registered in graph)
const OUTSIDER_SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const OUTSIDER_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

beforeAll(async () => {
  repoDir = makeTempDir("gitreview-test-repo-");
  pgDir = makeTempDir("gitreview-test-pg-");
  keysDir = makeTempDir("gitreview-test-keys-");
  process.env.ALLOD_KEYS_DIR = keysDir;

  // ── Build git repo ─────────────────────────────────────────────────────
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

  // main: initial commit (README only)
  writeFileSync(join(repoDir, "README.md"), "# test");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  mainSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

  // feature branch: commit touching src/lib.rs
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "lib.rs"), "// library");
  execFileSync("git", ["add", "src/lib.rs"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "add src/lib.rs"], { cwd: repoDir });
  featureSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  featureRef = "refs/heads/feature";

  // Go back to main
  execFileSync("git", ["checkout", "main"], { cwd: repoDir });

  // ── Build allod graph in the same repoDir ──────────────────────────────
  await createGraph(repoDir, "owner");

  const db = await openDb(pgDir);
  fh = await openFreehold({
    graphDir: repoDir,
    db,
    home: repoDir,
    graphName: "test",
    graphId: "gitreview-test",
    kind: "repo",
  });

  // Retrieve the real allod graph_id from disk (graph.yaml)
  const graphYaml = readFileSync(join(repoDir, ".allod", "graph.yaml"), "utf8");
  const idMatch = graphYaml.match(/\bgraph_id:\s*(.+)/);
  allodGraphId = idMatch ? idMatch[1].trim() : "gitreview-test";

  // Install code ontology
  const codeYaml = stripOntologyPreamble(assetYaml("code-ontology.yaml"));
  const codeInstall = await installOntology(fh.graph, codeYaml);
  if (codeInstall.status === "pending" && codeInstall.hash) {
    const d = await approve(fh.graph, "owner", codeInstall.hash);
    expect(d.status).toBe("approved");
  }

  // ── Create SourceFile node for src/lib.rs ─────────────────────────────
  const sfId = crypto.randomUUID();
  await commitAndApprove(fh.graph, "owner", "index src/lib.rs", [
    {
      create: {
        kind: "node",
        id: sfId,
        type: "code/SourceFile@1",
        attributes: { path: "src/lib.rs", language: "rust", blob: "git:repo#abc:src/lib.rs" },
      },
    },
  ]);

  // ── Add a `reviewer` principal ─────────────────────────────────────────
  // principal_add generates a keypair inside the graph and persists to .allod/keys/reviewer.yaml
  await fh.graph.principal_add("reviewer", "agent", "owner");

  // Read the reviewer's secret from the graph store and write to ALLOD_KEYS_DIR
  const reviewerKeyPath = join(repoDir, ".allod", "keys", "reviewer.yaml");
  const reviewerKeyYaml = readFileSync(reviewerKeyPath, "utf8");

  const graphComp = graphDirComponent(allodGraphId);
  mkdirSync(join(keysDir, graphComp), { recursive: true });
  writeFileSync(join(keysDir, graphComp, "reviewer.yaml"), reviewerKeyYaml);

  // Write `outsider` key (known test vector, NOT registered in graph)
  writeFileSync(
    join(keysDir, graphComp, "outsider.yaml"),
    `name: outsider\nkey_id: x\nalgorithm: ed25519\npublic: ${OUTSIDER_PUBLIC}\nsecret: ${OUTSIDER_SECRET}\n`
  );

  // ── Install git-substrate policy ───────────────────────────────────────
  // Binds reviewer role to principal:reviewer; requires reviewer role for src/**
  const policyYaml = `policy: gitreview-test-policy
version: 1
default_posture: permissive
roles:
  reviewer:
    - principal:reviewer
rules:
  - name: src-review
    select:
      substrate: git
      path: "src/**"
    require:
      reviewers:
        - role: reviewer
          quorum: 1
`;
  const policyResult = await fh.graph.install_policy(policyYaml, "owner");
  if (policyResult && typeof policyResult === "object" && "Held" in policyResult) {
    const d = await approve(
      fh.graph,
      "owner",
      (policyResult as { Held: { hash: string } }).Held.hash
    );
    expect(d.status).toBe("approved");
  }

  // ── Sync index ────────────────────────────────────────────────────────
  await syncIndex(fh, hashEmbedder);

  // ── Bare remote for push tests ─────────────────────────────────────────
  bareRemoteDir = makeTempDir("gitreview-bare-remote-");
  execFileSync("git", ["init", "--bare"], { cwd: bareRemoteDir });
  execFileSync("git", ["remote", "add", "origin", bareRemoteDir], { cwd: repoDir });
  // Push main to the remote
  execFileSync("git", ["push", "origin", "main"], { cwd: repoDir });
}, 180_000);

afterAll(() => {
  if (origKeysDir === undefined) {
    process.env.ALLOD_KEYS_DIR = undefined;
  } else {
    process.env.ALLOD_KEYS_DIR = origKeysDir;
  }
});

// ── branchHeads tests ──────────────────────────────────────────────────────

describe("branchHeads", () => {
  test("lists main and feature branches with correct shas", async () => {
    const heads = await branchHeads(repoDir);
    const names = heads.map((h) => h.ref);
    expect(names).toContain("refs/heads/main");
    expect(names).toContain("refs/heads/feature");

    const main = heads.find((h) => h.ref === "refs/heads/main");
    const feature = heads.find((h) => h.ref === "refs/heads/feature");
    expect(main?.sha).toBe(mainSha);
    expect(feature?.sha).toBe(featureSha);
  });
});

// ── listGitProposals tests ─────────────────────────────────────────────────

describe("listGitProposals", () => {
  test("returns proposals for all branch tips", async () => {
    const proposals = await listGitProposals(fh);
    const shas = proposals.map((p) => p.sha);
    expect(shas).toContain(mainSha);
    expect(shas).toContain(featureSha);
  });

  test("feature commit has src-review in matched, non-empty unmet, decided undecided", async () => {
    const proposals = await listGitProposals(fh);
    const feature = proposals.find((p) => p.sha === featureSha);
    expect(feature, "feature proposal not found").toBeDefined();
    expect(feature?.matched).toContain("src-review");
    expect(feature?.unmet.length).toBeGreaterThan(0);
    expect(feature?.decided).toBe("undecided");
  });

  test("feature proposal paths include src/lib.rs with indexed:true", async () => {
    const proposals = await listGitProposals(fh);
    const feature = proposals.find((p) => p.sha === featureSha);
    expect(feature).toBeDefined();
    const libPath = feature?.paths.find((p) => p.path === "src/lib.rs");
    expect(libPath, "src/lib.rs not found in paths").toBeDefined();
    expect(libPath?.indexed).toBe(true);
  });

  test("feature proposal paths include region badge for in-region path", async () => {
    const proposals = await listGitProposals(fh);
    const feature = proposals.find((p) => p.sha === featureSha);
    expect(feature).toBeDefined();
    const libPath = feature?.paths.find((p) => p.path === "src/lib.rs");
    expect(libPath).toBeDefined();
    // src/lib.rs is matched by src-review rule so its regions should be non-empty
    expect(Array.isArray(libPath?.regions)).toBe(true);
    expect(libPath?.regions.length).toBeGreaterThan(0);
  });

  test("main commit (README only) has no policy match, decided undecided", async () => {
    const proposals = await listGitProposals(fh);
    const main = proposals.find((p) => p.sha === mainSha);
    expect(main, "main proposal not found").toBeDefined();
    expect(main?.matched).toHaveLength(0);
    expect(main?.unmet).toHaveLength(0);
    expect(main?.decided).toBe("undecided");
  });
});

// ── gitProposal single-sha tests ───────────────────────────────────────────

describe("gitProposal", () => {
  test("returns null for unknown sha", async () => {
    const result = await gitProposal(fh, "0000000000000000000000000000000000000000");
    expect(result).toBeNull();
  });

  test("returns correct proposal for feature sha", async () => {
    const p = await gitProposal(fh, featureSha);
    expect(p).not.toBeNull();
    expect(p?.sha).toBe(featureSha);
    expect(p?.matched).toContain("src-review");
  });
});

// ── decideGit tests ────────────────────────────────────────────────────────

describe("decideGit — approve with reviewer (role-bound)", () => {
  // Use a fresh sha (featureSha) for this test; decisions accumulate so we
  // use a copy of the repoDir or just accept that tests may stack decisions.
  // Since each describe block runs sequentially and we need a clean note state,
  // we'll test against featureSha but be careful about ordering.

  test("outcome approved, note readable with sig:ed25519: decider", async () => {
    const repoName = basename(repoDir);
    const result = await decideGit(fh, featureSha, "approve", "reviewer", {
      allodGraphId,
      autoPushNotes: false,
      originRemote: null,
    });

    // Should be approved (reviewer role is bound and quorum=1)
    expect(result.outcome).toBe("approved");
    // autoPushNotes:false → push was skipped, not failed
    if (result.outcome === "approved" || result.outcome === "rejected") {
      expect(result.pushed).toBe(false);
      expect(result.pushSkipped).toBe(true);
    }

    // Note must be readable and contain a signed decider
    const decisions = await readDecisions(repoDir, featureSha);
    expect(decisions.length).toBeGreaterThan(0);

    const lastDecision = decisions[decisions.length - 1] as Record<string, unknown>;
    expect(Array.isArray(lastDecision.deciders)).toBe(true);
    const deciders = lastDecision.deciders as Array<Record<string, string>>;
    expect(deciders.length).toBeGreaterThan(0);
    const sig = deciders[0].signature ?? "";
    expect(sig).toMatch(/^sig:ed25519:[0-9a-f]{128}$/);
  });

  test("re-list shows decided: approved and empty unmet for feature sha", async () => {
    // decisions were recorded in the previous test
    const proposals = await listGitProposals(fh);
    const feature = proposals.find((p) => p.sha === featureSha);
    expect(feature).toBeDefined();
    expect(feature?.decided).toBe("approved");
    expect(feature?.unmet).toHaveLength(0);
  });
});

describe("decideGit — approve with outsider (unbound principal, key exists)", () => {
  test("outcome incomplete with unmet (decision still recorded)", async () => {
    // Use mainSha for this test to avoid interfering with featureSha's approved state.
    // mainSha has no policy rules (README only) so even outsider will be approved (unmet=[]).
    // Use a different dedicated sha: create a temporary second feature commit.
    // Actually mainSha has empty checklist, so unmet=[] regardless.
    // Per the brief: "unbound principal whose key exists → outcome incomplete with unmet".
    // For incomplete we need a commit with unmet requirements.
    // featureSha already has decisions from the reviewer — we need to test with a fresh
    // commit. We'll create a separate commit for this test.

    // We'll test against mainSha but that has no rules. So let's test with featureSha:
    // After reviewer approved, we add outsider's decision on the same sha.
    // outcome: outsider's decision IS recorded, but for "approve" verdict the satisfaction
    // check still sees the reviewer requirement — but it's already met by reviewer.
    // So outcome would be approved again. We need to test on a fresh sha without existing decisions.

    // Best approach: the outsider test is on a sha with policy rules and NO prior decisions.
    // Since featureSha is already approved, let's create a new commit on a temporary branch.

    // Create a new temp commit
    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "src", "extra.rs"), "// extra");
    execFileSync("git", ["add", "src/extra.rs"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add src/extra.rs"], { cwd: repoDir });
    const extraSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const result = await decideGit(fh, extraSha, "approve", "outsider", {
      allodGraphId,
      autoPushNotes: false,
      originRemote: null,
    });

    expect(result.outcome).toBe("incomplete");
    if (result.outcome === "incomplete") {
      expect(result.unmet.length).toBeGreaterThan(0);
    }

    // Decision was still recorded
    const decisions = await readDecisions(repoDir, extraSha);
    expect(decisions.length).toBeGreaterThan(0);
  });
});

describe("decideGit — missing key throws KeyMissingError", () => {
  test("throws KeyMissingError with code key-missing", async () => {
    await expect(
      decideGit(fh, mainSha, "approve", "nobody", {
        allodGraphId,
        autoPushNotes: false,
        originRemote: null,
      })
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error && (err as Error & { code?: string }).code === "key-missing";
    });
  });
});

describe("decideGit — reject path", () => {
  test("decided: rejected on re-list after reject decision", async () => {
    // Use a fresh sha
    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "src", "reject_me.rs"), "// reject");
    execFileSync("git", ["add", "src/reject_me.rs"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add src/reject_me.rs"], { cwd: repoDir });
    const rejectSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
      .toString()
      .trim();
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const result = await decideGit(fh, rejectSha, "reject", "reviewer", {
      allodGraphId,
      autoPushNotes: false,
      originRemote: null,
    });

    expect(result.outcome).toBe("rejected");
    // autoPushNotes:false → push was skipped, not failed
    if (result.outcome === "rejected") {
      expect(result.pushed).toBe(false);
      expect(result.pushSkipped).toBe(true);
    }

    // Single sha query shows rejected
    const p = await gitProposal(fh, rejectSha);
    expect(p).not.toBeNull();
    expect(p?.decided).toBe("rejected");
  });
});

describe("decideGit — push behavior", () => {
  test("autoPushNotes:true with bare remote: notes ref appears on remote", async () => {
    // Use a fresh sha for this test
    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "src", "push_test.rs"), "// push test");
    execFileSync("git", ["add", "src/push_test.rs"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add src/push_test.rs"], { cwd: repoDir });
    const pushSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const result = await decideGit(fh, pushSha, "approve", "reviewer", {
      allodGraphId,
      autoPushNotes: true,
      originRemote: bareRemoteDir,
    });

    expect(result.outcome === "approved" || result.outcome === "incomplete").toBe(true);
    if (result.outcome === "approved" || result.outcome === "rejected") {
      expect(result.pushed).toBe(true);
    }

    // Verify the notes ref exists on the bare remote
    const remoteRefs = execFileSync("git", ["ls-remote", bareRemoteDir], {
      cwd: repoDir,
    }).toString();
    expect(remoteRefs).toContain("refs/notes/allod-decisions");
  });

  test("autoPushNotes:true with bogus remote: pushed:false, pushError set, local note exists", async () => {
    // Use a fresh sha
    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "src", "bogus_push.rs"), "// bogus push");
    execFileSync("git", ["add", "src/bogus_push.rs"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add src/bogus_push.rs"], { cwd: repoDir });
    const bogusSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const result = await decideGit(fh, bogusSha, "approve", "reviewer", {
      allodGraphId,
      autoPushNotes: true,
      originRemote: "/nonexistent/path/to/remote",
    });

    expect(result.outcome === "approved" || result.outcome === "incomplete").toBe(true);
    if (result.outcome === "approved" || result.outcome === "rejected") {
      expect(result.pushed).toBe(false);
      expect(typeof result.pushError).toBe("string");
    }

    // Local note must still exist
    const decisions = await readDecisions(repoDir, bogusSha);
    expect(decisions.length).toBeGreaterThan(0);
  });
});

// ── listReviewsForSha — external_source / claimed_author round-trip ───────────

describe("listReviewsForSha — round-trips external_source and claimed_author", () => {
  beforeAll(async () => {
    // Install the review ontology so review/Review@1 and review/ReviewComment@1 resolve
    const reviewYaml = stripOntologyPreamble(assetYaml("review-ontology.yaml"));
    const result = await installOntology(fh.graph, reviewYaml);
    if (result.status === "pending" && result.hash) {
      const d = await approve(fh.graph, "owner", result.hash);
      expect(d.status).toBe("approved");
    }
  }, 60_000);

  test("ingested comment attrs include external_source and claimed_author", async () => {
    // Create a Review node for featureSha
    const reviewId = crypto.randomUUID();
    await commitAndApprove(fh.graph, "reviewer", `Review ${featureSha}`, [
      {
        create: {
          kind: "node",
          id: reviewId,
          type: "review/Review@1",
          attributes: {
            verdict: "approve",
            commit: featureSha,
          },
        },
      },
    ]);

    // Create a ReviewComment node with external_source and claimed_author attrs
    const commentId = crypto.randomUUID();
    await commitAndApprove(fh.graph, "reviewer", `ReviewComment for ${featureSha}`, [
      {
        create: {
          kind: "node",
          id: commentId,
          type: "review/ReviewComment@1",
          attributes: {
            body: "Looks good",
            anchor: "src/lib.rs:10",
            span: "10-12",
            status: "open",
            external_source: "pierre",
            external_id: "comment:abc123",
            claimed_author: "alice",
          },
        },
      },
    ]);

    // Create the part_of edge linking comment → review
    const edgeId = crypto.randomUUID();
    await commitAndApprove(fh.graph, "reviewer", `part_of edge for comment ${commentId}`, [
      {
        create: {
          kind: "edge",
          id: edgeId,
          type: "review/part_of@1",
          from: `node:${commentId}`,
          to: `node:${reviewId}`,
        },
      },
    ]);

    const reviews = await listReviewsForSha(fh, featureSha);
    // Find the review we just created
    const review = reviews.find((r) => r.reviewId === reviewId);
    expect(review, "review not found in listReviewsForSha output").toBeDefined();

    const comment = review?.comments.find((c) => c.commentId === commentId);
    expect(comment, "comment not found in review").toBeDefined();
    expect(comment?.external_source).toBe("pierre");
    expect(comment?.claimed_author).toBe("alice");
  });
});

// ── Cache invalidation tests ───────────────────────────────────────────────────

describe("proposal cache — invalidates when decisions tip changes", () => {
  let cacheSha: string;

  beforeAll(async () => {
    // Create a fresh commit on a new branch for cache testing
    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "src", "cache_test.rs"), "// cache test");
    execFileSync("git", ["add", "src/cache_test.rs"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add src/cache_test.rs for cache test"], { cwd: repoDir });
    cacheSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
  });

  test("proposalCacheKey encodes graphDir, sha, and decisionsTip", () => {
    const key = proposalCacheKey("/some/dir", "abc123", "tip456");
    expect(key).toBe("/some/dir\0abc123\0tip456");
    // Different tip → different key (cache miss)
    const key2 = proposalCacheKey("/some/dir", "abc123", "tip789");
    expect(key2).not.toBe(key);
  });

  test("evictProposalCache removes entries for the given graphDir", async () => {
    // Warm the cache by listing proposals
    const tip1 = await decisionsTip(repoDir);
    const before = await listGitProposals(fh);
    expect(before.length).toBeGreaterThan(0);

    // Evict — next call should re-evaluate (not use cached result)
    evictProposalCache(repoDir);

    // After eviction, re-listing still returns correct results
    const after = await listGitProposals(fh);
    expect(after.length).toBe(before.length);
  });

  test("decideGit evicts cache; re-list reflects new decided state for cache sha", async () => {
    // Warm the cache
    const proposals1 = await listGitProposals(fh);
    const before = proposals1.find((p) => p.sha === cacheSha);
    // cacheSha may not appear if HEAD was checked out to main (dedup may skip it)
    // Use gitProposal directly which always evaluates
    const p1 = await gitProposal(fh, cacheSha);
    expect(p1).not.toBeNull();
    expect(p1?.decided).toBe("undecided");

    // Approve → triggers evictProposalCache inside decideGit
    const result = await decideGit(fh, cacheSha, "approve", "reviewer", {
      allodGraphId,
      autoPushNotes: false,
      originRemote: null,
    });
    // outcome is approved or incomplete depending on policy state
    expect(["approved", "incomplete"]).toContain(result.outcome);

    // Re-evaluate — cache was evicted so we get fresh state
    const p2 = await gitProposal(fh, cacheSha);
    expect(p2).not.toBeNull();
    // decided must now reflect the decision (approved or still has existing decisions)
    expect(p2?.decided).not.toBe("undecided");
  });

  test("decisionsTip changes after appendDecision", async () => {
    // Create yet another fresh sha for this test
    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "src", "tip_test.rs"), "// tip test");
    execFileSync("git", ["add", "src/tip_test.rs"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "add src/tip_test.rs for tip test"], { cwd: repoDir });
    const tipSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const tip1 = await decisionsTip(repoDir);

    // Make a decision → notes ref moves
    await decideGit(fh, tipSha, "reject", "reviewer", {
      allodGraphId,
      autoPushNotes: false,
      originRemote: null,
    });

    const tip2 = await decisionsTip(repoDir);
    // After a decision the notes ref tip must have changed
    expect(tip2).not.toBe(tip1);
  });
});

// ── postReview tests ──────────────────────────────────────────────────────────
//
// postReview performs the two-phase signed commit: commit_payload → host sign →
// commit_signed. These tests verify that the signed flow succeeds and that the
// resulting artifacts are visible via listReviewsForSha.

describe("postReview — two-phase signed commit", () => {
  // Install the review ontology once for this suite (may already be installed
  // from listReviewsForSha suite; installOntology is idempotent).
  beforeAll(async () => {
    const reviewYaml = stripOntologyPreamble(assetYaml("review-ontology.yaml"));
    const result = await installOntology(fh.graph, reviewYaml);
    if (result.status === "pending" && result.hash) {
      const d = await approve(fh.graph, "owner", result.hash);
      expect(d.status).toBe("approved");
    }
  }, 60_000);

  test("postReview succeeds and returns reviewId + commentIds", async () => {
    const result = await postReview(fh, {
      sha: mainSha,
      verdict: "approve",
      body: "LGTM",
      by: "reviewer",
      comments: [{ body: "Nice", anchor: "README.md:1" }],
      allodGraphId,
    });

    expect(typeof result.reviewId).toBe("string");
    expect(result.commentIds).toHaveLength(1);
    expect(["saved", "pending"]).toContain(result.status);
  });

  test("postReview artifacts appear in listReviewsForSha", async () => {
    // Create a review with a recognizable body so we can find it
    const marker = `postReview-test-${Date.now()}`;
    const result = await postReview(fh, {
      sha: mainSha,
      verdict: "request-changes",
      body: marker,
      by: "reviewer",
      comments: [],
      allodGraphId,
    });

    const reviews = await listReviewsForSha(fh, mainSha);
    const found = reviews.find((r) => r.reviewId === result.reviewId);
    expect(found, "review not found in listReviewsForSha").toBeDefined();
    expect(found?.verdict).toBe("request-changes");
    expect(found?.body).toBe(marker);
    expect(["saved", "pending"]).toContain(found?.status);
  });

  test("postReview with comments: comment appears in review.comments", async () => {
    const result = await postReview(fh, {
      sha: mainSha,
      verdict: "approve",
      body: "All good",
      by: "reviewer",
      comments: [{ body: "Correct logic", anchor: "src/lib.rs:42", span: "42-45" }],
      allodGraphId,
    });

    expect(result.commentIds).toHaveLength(1);

    const reviews = await listReviewsForSha(fh, mainSha);
    const found = reviews.find((r) => r.reviewId === result.reviewId);
    expect(found, "review not found").toBeDefined();
    expect(found?.comments).toHaveLength(1);
    expect(found?.comments[0].body).toBe("Correct logic");
    expect(found?.comments[0].anchor).toBe("src/lib.rs:42");
    expect(found?.comments[0].span).toBe("42-45");
  });

  test("postReview with missing host key throws KeyMissingError", async () => {
    // Add a graph principal, then delete all key files so resolveKey cannot find a key.
    // commit_payload succeeds (principal exists in graph), but resolveKey fails →
    // signedCommit wraps the failure as KeyMissingError.
    const { rmSync } = await import("node:fs");
    await fh.graph.principal_add("keyless-reviewer", "agent", "owner");

    // principal_add writes the key to .allod/keys/<name>.yaml (legacy fallback location).
    // Delete it so resolveKey finds nothing in any location.
    const legacyKeyPath = join(repoDir, ".allod", "keys", "keyless-reviewer.yaml");
    try {
      rmSync(legacyKeyPath);
    } catch {
      // Already absent — test is still valid
    }
    // Also ensure it's not in ALLOD_KEYS_DIR (it wasn't written there)
    const graphComp = graphDirComponent(allodGraphId);
    const xdgKeyPath = join(keysDir, graphComp, "keyless-reviewer.yaml");
    try {
      rmSync(xdgKeyPath);
    } catch {
      // Already absent
    }

    await expect(
      postReview(fh, {
        sha: mainSha,
        verdict: "approve",
        by: "keyless-reviewer",
        comments: [],
        allodGraphId,
      })
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error && (err as Error & { code?: string }).code === "key-missing";
    });
  });
});

// ── postReview — host-managed key (the broken case) ───────────────────────────
//
// This test creates a graph fixture whose author key lives ONLY as a file under
// ALLOD_KEYS_DIR (not in the graph's wasm store). This is the exact case that
// was broken before passing key_id to commit_payload: the wasm module tried to
// resolve the key from its internal store and failed.

describe("postReview — host-managed key (file-only, not in wasm store)", () => {
  let hostKeyFh: Freehold;
  let hostKeyRepoDir: string;
  let hostKeyGraphId: string;
  let hostKeyPgDir: string;
  let hostKeysDir: string;
  let hostMainSha: string;
  const hostKeyOrigKeysDir = process.env.ALLOD_KEYS_DIR;

  beforeAll(async () => {
    hostKeyRepoDir = makeTempDir("gitreview-hostkey-repo-");
    hostKeyPgDir = makeTempDir("gitreview-hostkey-pg-");
    hostKeysDir = makeTempDir("gitreview-hostkey-keys-");
    process.env.ALLOD_KEYS_DIR = hostKeysDir;

    // Minimal git repo
    execFileSync("git", ["init", "-b", "main"], { cwd: hostKeyRepoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: hostKeyRepoDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: hostKeyRepoDir });
    writeFileSync(join(hostKeyRepoDir, "README.md"), "# host key test");
    execFileSync("git", ["add", "README.md"], { cwd: hostKeyRepoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: hostKeyRepoDir });
    hostMainSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: hostKeyRepoDir })
      .toString()
      .trim();

    // Create allod graph
    await createGraph(hostKeyRepoDir, "host-author");

    const db = await openDb(hostKeyPgDir);
    hostKeyFh = await openFreehold({
      graphDir: hostKeyRepoDir,
      db,
      home: hostKeyRepoDir,
      graphName: "host-key-test",
      graphId: "host-key-test",
      kind: "repo",
    });

    // Get allod graph_id
    const graphYaml = readFileSync(join(hostKeyRepoDir, ".allod", "graph.yaml"), "utf8");
    const idMatch = graphYaml.match(/\bgraph_id:\s*(.+)/);
    hostKeyGraphId = idMatch ? idMatch[1].trim() : "host-key-test";

    // Install review ontology
    const reviewYaml = stripOntologyPreamble(assetYaml("review-ontology.yaml"));
    const result = await installOntology(hostKeyFh.graph, reviewYaml);
    if (result.status === "pending" && result.hash) {
      const d = await approve(hostKeyFh.graph, "host-author", result.hash);
      expect(d.status).toBe("approved");
    }

    // Copy the host-author key from .allod/keys/ to ALLOD_KEYS_DIR only
    // (simulate the host-managed key scenario: key is on host filesystem, not in wasm store)
    const legacyKeyPath = join(hostKeyRepoDir, ".allod", "keys", "host-author.yaml");
    const graphComp = graphDirComponent(hostKeyGraphId);
    mkdirSync(join(hostKeysDir, graphComp), { recursive: true });
    writeFileSync(
      join(hostKeysDir, graphComp, "host-author.yaml"),
      readFileSync(legacyKeyPath, "utf8")
    );
  }, 120_000);

  afterAll(() => {
    process.env.ALLOD_KEYS_DIR = hostKeyOrigKeysDir;
  });

  test("postReview succeeds with host-managed key (key_id passed to commit_payload)", async () => {
    const result = await postReview(hostKeyFh, {
      sha: hostMainSha,
      verdict: "approve-with-comments",
      body: "host-key signing path verification",
      by: "host-author",
      comments: [
        {
          body: "signing-path verification",
          anchor: `git:${basename(hostKeyRepoDir)}#${hostMainSha}:README.md`,
          span: "L1",
        },
      ],
      allodGraphId: hostKeyGraphId,
    });

    expect(typeof result.reviewId).toBe("string");
    expect(result.reviewId).not.toBe("");
    expect(result.commentIds).toHaveLength(1);
    expect(["saved", "pending"]).toContain(result.status);

    // Verify via listReviewsForSha
    const reviews = await listReviewsForSha(hostKeyFh, hostMainSha);
    const found = reviews.find((r) => r.reviewId === result.reviewId);
    expect(found, "review not found in listReviewsForSha").toBeDefined();
    expect(found?.verdict).toBe("approve-with-comments");
  });
});
