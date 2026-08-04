/**
 * @freehold/core — Governance operations layer.
 *
 * Proposal lifecycle, principal management, and graph verification.
 */

import type { AllodGraph } from "@allod/core";
import type { PrincipalView, ProposalView, VerifyReport } from "./types.js";

// ---- Raw Allod shapes ----

interface RawProposalSummary {
  hash: string;
  intent: string;
  author: string;
}

interface RawStateNode {
  type_ref: string;
  label: string;
  derived_by: string | null;
}

interface RawStateView {
  state_hash: string;
  nodes: RawStateNode[];
}

interface RawVerifyReport {
  ok: boolean;
  state_hash: string;
  degraded: string[];
  changesets: unknown[];
  checkpoints: unknown[];
}

// ---- Public API ----

/**
 * List pending (held) proposals from the graph.
 */
export function pending(graph: AllodGraph): ProposalView[] {
  const raw = graph.proposals() as RawProposalSummary[];
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({
    hash: p.hash ?? "",
    agent: p.author ?? "",
    intent: p.intent ?? "",
    summary: p.intent ?? "",
    rules: [],
    diff: [],
    isSchemaProposal: (p.intent ?? "").toLowerCase().includes("schema"),
  }));
}

export interface ApproveResult {
  status: "admitted" | "rejected" | "still-unmet";
  hash: string;
}

/**
 * Approve a held proposal by hash.
 */
export async function approve(graph: AllodGraph, by: string, hash: string): Promise<ApproveResult> {
  const raw = await graph.decide(hash, by, "approve");
  if (raw && typeof raw === "object") {
    if ("Admitted" in raw) return { status: "admitted", hash };
    if ("Rejected" in raw) return { status: "rejected", hash };
    if ("StillUnmet" in raw) return { status: "still-unmet", hash };
  }
  return { status: "admitted", hash };
}

export interface RejectResult {
  status: "rejected";
  hash: string;
}

/**
 * Reject a held proposal by hash.
 */
export async function reject(graph: AllodGraph, by: string, hash: string): Promise<RejectResult> {
  await graph.decide(hash, by, "reject");
  return { status: "rejected", hash };
}

/**
 * Run the full cryptographic verification of the graph chain.
 */
export function verifyGraph(graph: AllodGraph): VerifyReport {
  const raw = graph.verify() as RawVerifyReport;
  return {
    ok: raw.ok ?? false,
    stateHash: raw.state_hash,
    degraded: (raw.degraded ?? []).map((reason, i) => ({ id: String(i), reason })),
  };
}

/**
 * Return the list of principals (users and agents) registered in the graph.
 */
export function principals(graph: AllodGraph): PrincipalView[] {
  const raw = graph.state() as RawStateView;
  if (!raw?.nodes) return [];
  return raw.nodes
    .filter((n) => {
      const bare = n.type_ref?.split("@")[0] ?? "";
      return bare === "core/User" || bare === "core/Agent" || bare === "core/Service";
    })
    .map((n) => {
      const bare = n.type_ref?.split("@")[0] ?? "";
      const kind = bare.split("/")[1]?.toLowerCase() ?? "user";
      return { name: n.label ?? "", kind };
    });
}

/**
 * Register a new agent principal in the graph.
 * Returns the agent's name and a ready-to-use MCP snippet string.
 */
export async function registerAgent(
  graph: AllodGraph,
  agentName: string,
  by: string
): Promise<{ name: string; mcpSnippet: string }> {
  await graph.principal_add(agentName, "agent", by);
  const mcpSnippet = JSON.stringify(
    {
      mcpServers: {
        freehold: {
          command: "npx",
          args: ["@freehold/mcp", "--agent", agentName],
        },
      },
    },
    null,
    2
  );
  return { name: agentName, mcpSnippet };
}
