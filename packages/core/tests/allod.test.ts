/**
 * Task F1 acceptance test: createGraph / openGraph wiring.
 *
 * Asserts the full founding loop through the @freehold/core wrappers:
 *   createGraph → principal_add → note (admitted) →
 *   propose_preference (held) → decide (approve) →
 *   verify().ok → openGraph → same state_hash
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createGraph, openGraph } from "../src/allod.js";

describe("@freehold/core allod wiring", () => {
  test("founding loop: create, govern, persist, reopen", async () => {
    const graphDir = mkdtempSync(join(tmpdir(), "freehold-test-"));

    // --- Phase 1: create a new graph ---
    const g = await createGraph(graphDir, "owner");

    // Register an agent principal
    await g.principal_add("agent", "agent", "owner");

    // Scratch note — admitted immediately under scratch-is-free policy
    const noteResult = await g.note("agent", "prefers quiet workspaces");
    expect(noteResult.admission.Admitted).toBeDefined();

    // Propose a preference — held for owner review under memory policy
    const prefResult = await g.propose_preference(
      "agent",
      "quiet workspaces over open offices",
      "hard", // enum: hard | soft  (not "strong")
      noteResult.note_id
    );
    expect(prefResult.admission.Held).toBeDefined();

    // Owner approves the held proposal
    const decided = await g.decide(prefResult.hash, "owner", "approve");
    // DecisionOutcome::Admitted { degraded: [] }
    expect(decided.Admitted).toBeDefined();

    // Verify the full graph: cryptographic integrity check
    const report = g.verify();
    expect(report.ok).toBe(true);

    const hashBefore = g.state().state_hash;

    // --- Phase 2: reopen from the same dir ---
    const g2 = await openGraph(graphDir);
    const hashAfter = g2.state().state_hash;

    // State hash must be identical — proves round-trip persistence is lossless
    expect(hashAfter).toEqual(hashBefore);
  });
});
