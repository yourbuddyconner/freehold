import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllodGraph } from "@allod/core";
import { beforeEach, describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import { approve, pending, principals, registerAgent, verifyGraph } from "../src/governance.js";
import { createEntity, remember } from "../src/knowledge.js";

describe("governance", () => {
  let graph: AllodGraph;

  beforeEach(async () => {
    const graphDir = mkdtempSync(join(tmpdir(), "freehold-governance-test-"));
    graph = await createGraph(graphDir, "owner");
    await graph.principal_add("agent", "agent", "owner");
  });

  test("pending() returns a ProposalView array with derived summary, diff, and rules", async () => {
    // Create a held proposal by creating a Preference without scratch classification
    const created = await createEntity(graph, "agent", "memory/Preference@1", {
      statement: "prefers dark mode",
      strength: "soft",
    });
    expect(created.status).toBe("held");

    const proposals = pending(graph);
    expect(Array.isArray(proposals)).toBe(true);
    expect(proposals.length).toBeGreaterThanOrEqual(1);

    const p = proposals[0];
    expect(typeof p.hash).toBe("string");
    expect(p.hash.length).toBeGreaterThan(0);

    // agent is the principal name (not the raw "principal:<name>" reference)
    expect(typeof p.agent).toBe("string");
    expect(p.agent).toBe("agent"); // matches the agent we registered

    expect(typeof p.intent).toBe("string");

    // summary is a plain-language line derived from ops (not just the intent)
    // It should mention the agent name and the type of change
    expect(typeof p.summary).toBe("string");
    expect(p.summary.length).toBeGreaterThan(0);
    expect(p.summary).toContain("agent"); // the agent name appears in summary

    // rules are policy rule names that held this proposal (strings)
    expect(Array.isArray(p.rules)).toBe(true);
    // Under the memory policy, at least one rule holds Preference proposals
    expect(p.rules.length).toBeGreaterThan(0);
    for (const rule of p.rules) {
      expect(typeof rule).toBe("string");
    }

    // diff is op-level: for a create, before=null, after=attribute values
    expect(Array.isArray(p.diff)).toBe(true);
    expect(p.diff.length).toBeGreaterThan(0);
    const statementDiff = p.diff.find((d) => d.key === "statement");
    expect(statementDiff).toBeDefined();
    expect(statementDiff?.before).toBeNull();
    expect(statementDiff?.after).toBe("prefers dark mode");

    // isSchemaProposal is false for a Preference (not a meta/* type)
    expect(p.isSchemaProposal).toBe(false);
  });

  test("approve() resolves a held preference proposal (via propose_preference)", async () => {
    // Use the allod-native propose_preference which creates a proper self-attesting
    // envelope — this is the canonical way to create an approvable proposal.
    const noteResult = await graph.note("agent", "prefers dark mode");
    const prefResult = await graph.propose_preference(
      "agent",
      "dark mode over light mode",
      "soft",
      noteResult.note_id as string
    );
    expect(prefResult.admission?.Held).toBeDefined();

    const proposals = pending(graph);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const target = proposals.find((p) => p.hash === prefResult.hash);
    expect(target).toBeDefined();

    const result = await approve(graph, "owner", prefResult.hash as string);
    expect(result.status).toBe("admitted");

    // Proposal should no longer be pending
    const after = pending(graph);
    const stillPending = after.find((p) => p.hash === prefResult.hash);
    expect(stillPending).toBeUndefined();
  });

  test("verifyGraph() returns { ok: true } for a fresh graph", () => {
    const report = verifyGraph(graph);
    expect(report.ok).toBe(true);
    expect(typeof report.stateHash).toBe("string");
    expect(Array.isArray(report.degraded)).toBe(true);
  });

  test("principals() returns array including the owner", () => {
    const ps = principals(graph);
    expect(Array.isArray(ps)).toBe(true);
    // Owner is a User principal, agent is an Agent principal
    expect(ps.length).toBeGreaterThanOrEqual(1);
    const owner = ps.find((p) => p.name === "owner");
    expect(owner).toBeDefined();
    expect(["user", "agent", "service"]).toContain(owner?.kind.toLowerCase());
  });

  test("registerAgent() returns { name, mcpSnippet }", async () => {
    const result = await registerAgent(graph, "new-agent", "owner");
    expect(result.name).toBe("new-agent");
    expect(typeof result.mcpSnippet).toBe("string");
    expect(result.mcpSnippet.length).toBeGreaterThan(0);
    // Should contain the agent name
    expect(result.mcpSnippet).toContain("new-agent");
  });
});
