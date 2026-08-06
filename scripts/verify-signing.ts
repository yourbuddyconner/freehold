#!/usr/bin/env tsx
/**
 * Live verify: call postReview against the allod git repo using the conner key.
 *
 * This exercises the new code path: commit_payload is called with key_id so
 * wasm doesn't attempt its own key resolution (which fails for host-managed keys).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CORE_PKG = join(REPO_ROOT, "packages", "core");

const ALLOD_REPO = "/Users/conner/code/allod";
const TARGET_SHA = "354aef977f20d896056478bb9498bfb8d0b2f873";
const AUTHOR = "conner";

async function main() {
  console.log("=== verify-signing: postReview live test ===");
  console.log(`allod repo: ${ALLOD_REPO}`);
  console.log(`target sha: ${TARGET_SHA}`);
  console.log(`author:     ${AUTHOR}`);

  // Read the real allod graph_id from disk
  const { readFileSync } = await import("node:fs");
  const { load: yamlLoad } = await import(
    join(CORE_PKG, "node_modules", "js-yaml", "dist", "js-yaml.cjs.js")
  );
  const graphYaml = readFileSync(`${ALLOD_REPO}/.allod/graph.yaml`, "utf-8");
  const graphDoc = yamlLoad(graphYaml) as Record<string, unknown>;
  const allodGraphId = graphDoc.graph_id as string;
  console.log(`allodGraphId: ${allodGraphId}`);

  // Open a fresh PGlite DB for this run
  const pgDir = mkdtempSync(join(tmpdir(), "verify-signing-pg-"));

  const { openDb } = await import(join(CORE_PKG, "src", "db.js"));
  const { openFreehold } = await import(join(CORE_PKG, "src", "graphs.js"));
  const { postReview, listReviewsForSha } = await import(join(CORE_PKG, "src", "gitreview.js"));

  const db = await openDb(pgDir);
  const fh = await openFreehold({
    graphDir: ALLOD_REPO,
    db,
    home: ALLOD_REPO,
    graphName: "allod",
    graphId: "allod-verify",
    kind: "repo",
  });

  console.log("\n--- calling postReview ---");
  const result = await postReview(fh, {
    sha: TARGET_SHA,
    verdict: "approve-with-comments",
    body: "signing-path verification from verify-signing.ts",
    by: AUTHOR,
    comments: [
      {
        body: "signing-path verification",
        anchor: `git:allod#${TARGET_SHA}:README.md`,
        span: "L1",
      },
    ],
    allodGraphId,
  });

  console.log(`\nreviewId: ${result.reviewId}`);
  console.log(`status:   ${result.status}`);
  console.log(`commentIds: ${JSON.stringify(result.commentIds)}`);

  // Verify via listReviewsForSha
  console.log("\n--- calling listReviewsForSha ---");
  const reviews = await listReviewsForSha(fh, TARGET_SHA);
  const found = reviews.find((r) => r.reviewId === result.reviewId);
  if (!found) {
    console.error("ERROR: review not found in listReviewsForSha!");
    process.exit(1);
  }
  console.log(`found review: verdict=${found.verdict} comments=${found.comments.length}`);
  console.log("\n=== PASS ===");
}

main().catch((err) => {
  console.error(`\nFAIL: ${err}`);
  process.exit(1);
});
