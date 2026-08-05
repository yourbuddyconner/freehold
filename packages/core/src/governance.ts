/**
 * @freehold/core — Governance operations layer.
 *
 * Proposal lifecycle, principal management, and graph verification.
 */

import type { AllodGraph } from "@allod/core";
import { withGraph } from "./lock.js";
import type { AttributeDiff, PrincipalView, ProposalView, VerifyReport } from "./types.js";

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

// ---- Changeset op shapes ----

interface RawOpPayload {
  kind: "node" | "edge" | "classification";
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
  from?: string;
  to?: string;
  subject?: string;
  term?: string;
}

interface RawOp {
  create?: RawOpPayload;
  update?: RawOpPayload;
  delete?: RawOpPayload;
}

interface RawAuthor {
  principal?: string;
}

interface RawChangeset {
  hash?: string;
  intent?: string;
  author?: RawAuthor;
  operations?: RawOp[];
}

// ---- Helpers ----

/**
 * Extract the principal name from a "principal:<name>" reference.
 */
function principalName(ref: string | undefined): string {
  if (!ref) return "?";
  return ref.startsWith("principal:") ? ref.slice("principal:".length) : ref;
}

/**
 * Build a plain-language summary line from the ops in a changeset.
 *
 * Examples:
 *   "jarvis wants to create a memory/Preference: \"tea over coffee\""
 *   "jarvis wants to add an entity type: Colleague"
 *   "jarvis wants to update node <id>"
 */
/**
 * Resolve a display title for a node reference ("node:<uuid>") from fold
 * state: title, name, statement, first content line, then the short id.
 * Must be called from within a withGraph critical section.
 */
function subjectTitle(graph: AllodGraph, ref: string): string {
  const colon = ref.indexOf(":");
  const id = colon >= 0 ? ref.slice(colon + 1) : ref;
  try {
    const obj = (
      graph as unknown as {
        object_get(kind: string, id: string): { content?: Record<string, unknown> } | null;
      }
    ).object_get("node", id);
    const attrs = (obj?.content?.attributes ?? {}) as Record<string, unknown>;
    for (const key of ["title", "name", "statement"]) {
      const v = attrs[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    const body = attrs.content;
    if (typeof body === "string" && body.trim()) {
      const first = body
        .trim()
        .split("\n")[0]
        .replace(/^#+\s*/, "")
        .trim();
      if (first) return first.length > 60 ? `${first.slice(0, 60)}…` : first;
    }
  } catch {
    // Node not in fold state — fall through to the short id
  }
  return `${id.slice(0, 8)}…`;
}

function buildSummary(graph: AllodGraph, agent: string, ops: RawOp[]): string {
  // Find the first substantive node op (not a classification op)
  const nodeOp = ops.find(
    (o) => (o.create?.kind === "node" || o.update?.kind === "node") && o.create?.type !== undefined
  );
  if (nodeOp?.create) {
    const p = nodeOp.create;
    const typeRef = p.type ?? "";
    const bare = typeRef.split("@")[0];
    const attrs = p.attributes ?? {};
    // Schema change: meta/* types
    if (bare.startsWith("meta/")) {
      const name = (attrs.name as string) ?? (attrs.display_name as string) ?? p.id ?? "?";
      return `${agent} wants to add an entity type: ${name}`;
    }
    // Pick a human-readable attribute value
    const body =
      (attrs.statement as string) ??
      (attrs.content as string) ??
      (attrs.name as string) ??
      (attrs.display_name as string);
    const typePart = bare.split("/")[1] ?? bare;
    if (body) {
      return `${agent} wants to create a ${bare}: "${body}"`;
    }
    return `${agent} wants to create a ${typePart}`;
  }
  if (nodeOp?.update) {
    const p = nodeOp.update;
    const typeRef = p.type ?? "";
    const bare = typeRef.split("@")[0];
    const attrs = p.attributes ?? {};
    const body = (attrs.statement as string) ?? (attrs.content as string) ?? (attrs.name as string);
    if (body) {
      return `${agent} wants to update ${bare}: "${body}"`;
    }
    return `${agent} wants to update node ${p.id ?? "?"}`;
  }
  // Classification-only proposal: say what gets labeled as what
  const classOp = ops.find((o) => o.create?.kind === "classification");
  if (classOp?.create?.subject && classOp.create.term) {
    const term = classOp.create.term.split("@")[0];
    const title = subjectTitle(graph, classOp.create.subject);
    return `${agent} wants to label "${title}" as ${term}`;
  }
  // Fallback: use intent
  return `${agent} wants to make a change`;
}

/**
 * Build op-level diffs from changeset ops.
 * For create ops, `before` is null, `after` is the new attribute value.
 * For update ops, `before` is the current value from object_get, `after` is the new value.
 *
 * Called from within a withGraph critical section — must NOT call withGraph itself.
 */
function buildDiff(graph: AllodGraph, ops: RawOp[]): AttributeDiff[] {
  const diffs: AttributeDiff[] = [];

  for (const op of ops) {
    const payload = op.create ?? op.update;
    if (!payload) continue;

    if (payload.kind === "classification" && payload.subject && payload.term) {
      diffs.push({
        key: "label",
        before: null,
        after: `${subjectTitle(graph, payload.subject)} → ${payload.term.split("@")[0]}`,
      });
      continue;
    }

    if (payload.kind !== "node") continue;

    const attrs = payload.attributes ?? {};
    const isUpdate = !!op.update;
    let currentAttrs: Record<string, unknown> = {};

    if (isUpdate) {
      // Fetch the current object state for before values
      try {
        const obj = (
          graph as unknown as {
            object_get(kind: string, id: string): { content: Record<string, unknown> } | null;
          }
        ).object_get("node", payload.id);
        if (obj?.content) {
          const content = obj.content as Record<string, unknown>;
          currentAttrs = (content.attributes as Record<string, unknown>) ?? {};
        }
      } catch {
        // If object_get fails, before values stay empty
      }
    }

    for (const [key, afterVal] of Object.entries(attrs)) {
      const beforeVal = isUpdate ? (currentAttrs[key] ?? null) : null;
      diffs.push({ key, before: beforeVal, after: afterVal });
    }
  }

  return diffs;
}

/**
 * The existing node a proposal targets: a classification's subject or an
 * update's node. Creates return null — their content is the diff.
 * Must be called from within a withGraph critical section.
 */
function resolveSubject(graph: AllodGraph, ops: RawOp[]): { id: string; title: string } | null {
  const classOp = ops.find((o) => o.create?.kind === "classification" && o.create.subject);
  if (classOp?.create?.subject) {
    const ref = classOp.create.subject;
    const colon = ref.indexOf(":");
    const id = colon >= 0 ? ref.slice(colon + 1) : ref;
    return { id, title: subjectTitle(graph, ref) };
  }
  const updateOp = ops.find((o) => o.update?.kind === "node" && o.update.id);
  if (updateOp?.update?.id) {
    const id = updateOp.update.id;
    return { id, title: subjectTitle(graph, `node:${id}`) };
  }
  return null;
}

/**
 * Check whether any op targets a meta/* type node (schema change indicator).
 */
function checkIsSchemaProposal(ops: RawOp[]): boolean {
  return ops.some((op) => {
    const payload = op.create ?? op.update ?? op.delete;
    if (!payload) return false;
    const typeRef = payload.type ?? "";
    const bare = typeRef.split("@")[0];
    return bare.startsWith("meta/");
  });
}

// ---- Public API ----

/**
 * List proposals pending approval from the graph, each enriched with
 * a plain-language summary, op-level diff, matched policy rule names,
 * and a schema-proposal flag.
 */
/**
 * Per-proposal enrichment (checklist re-evaluation, diff, subject lookup)
 * costs real wasm time. Beyond this many proposals, the rest return slim
 * entries so the Inbox stays responsive under a flooded queue.
 */
const ENRICH_CAP = 100;

export async function pending(graph: AllodGraph): Promise<ProposalView[]> {
  return withGraph(graph, () => {
    const raw = graph.proposals() as RawProposalSummary[];
    if (!Array.isArray(raw)) return [];

    return raw.map((p, index) => {
      if (index >= ENRICH_CAP) {
        const hash = p.hash ?? "";
        const agent = principalName(p.author);
        return {
          hash,
          agent,
          intent: p.intent ?? "",
          summary: p.intent ?? `${agent} wants to make a change`,
          rules: [],
          diff: [],
          isSchemaProposal: false,
          subject: null,
        };
      }
      const hash = p.hash ?? "";
      const intent = p.intent ?? "";
      const agent = principalName(p.author);

      // Fetch full changeset to get operations
      let ops: RawOp[] = [];
      try {
        const cs = (graph as unknown as { proposal_get(hash: string): RawChangeset }).proposal_get(
          hash
        );
        ops = cs?.operations ?? [];
      } catch {
        // Fall back to empty ops — summary/diff will be generic
      }

      // Fetch matched rule names via policy re-evaluation
      let rules: string[] = [];
      try {
        const checklist = (
          graph as unknown as { proposal_checklist(hash: string): string[] }
        ).proposal_checklist(hash);
        if (Array.isArray(checklist)) {
          rules = checklist;
        }
      } catch {
        // Leave rules empty on failure
      }

      const summary = buildSummary(graph, agent, ops);
      const diff = buildDiff(graph, ops);
      const isSchemaProposal = checkIsSchemaProposal(ops);
      const subject = resolveSubject(graph, ops);

      return { hash, agent, intent, summary, rules, diff, isSchemaProposal, subject };
    });
  });
}

export interface ApproveResult {
  status: "approved" | "rejected" | "incomplete";
  hash: string;
  degraded?: string[];
  unmet?: string[];
}

/**
 * Parse a DecisionOutcome from allod.decide() into a normalized result.
 *
 * allod serializes outcomes in three shapes:
 *   - Bare string "Rejected" → {status:"rejected"}
 *   - Object {Admitted:{degraded:[...]}} → {status:"approved", degraded}
 *   - Object {StillUnmet:{unmet:[...]}} → {status:"incomplete", unmet}
 */
function parseDecisionOutcome(raw: unknown): {
  status: "approved" | "rejected" | "incomplete";
  degraded?: string[];
  unmet?: string[];
} {
  // Handle bare string "Rejected"
  if (raw === "Rejected") {
    return { status: "rejected" };
  }

  if (raw && typeof raw === "object") {
    // {Admitted:{degraded:[...]}}
    if ("Admitted" in raw) {
      const admitted = (raw as { Admitted?: { degraded?: string[] } }).Admitted;
      return { status: "approved", degraded: admitted?.degraded };
    }
    // {Rejected:{...}} — empty object for reject variant
    if ("Rejected" in raw) {
      return { status: "rejected" };
    }
    // {StillUnmet:{unmet:[...]}}
    if ("StillUnmet" in raw) {
      const stillUnmet = (raw as { StillUnmet?: { unmet?: string[] } }).StillUnmet;
      return { status: "incomplete", unmet: stillUnmet?.unmet };
    }
  }

  // Fallback (shouldn't happen with valid allod outcomes)
  return { status: "approved" };
}

/**
 * Approve a held proposal by hash.
 */
export async function approve(graph: AllodGraph, by: string, hash: string): Promise<ApproveResult> {
  return withGraph(graph, async () => {
    const raw = await graph.decide(hash, by, "approve");
    const parsed = parseDecisionOutcome(raw);
    return { hash, ...parsed };
  });
}

export interface RejectResult {
  status: "rejected";
  hash: string;
}

/**
 * Reject a held proposal by hash.
 */
export async function reject(graph: AllodGraph, by: string, hash: string): Promise<RejectResult> {
  return withGraph(graph, async () => {
    const raw = await graph.decide(hash, by, "reject");
    const parsed = parseDecisionOutcome(raw);
    return { hash, status: parsed.status as "rejected" };
  });
}

/**
 * Run the full cryptographic verification of the graph chain.
 */
export async function verifyGraph(graph: AllodGraph): Promise<VerifyReport> {
  return withGraph(graph, () => {
    const raw = graph.verify() as RawVerifyReport;
    return {
      ok: raw.ok ?? false,
      stateHash: raw.state_hash,
      degraded: (raw.degraded ?? []).map((reason, i) => ({ id: String(i), reason })),
    };
  });
}

/**
 * Return the list of principals (users and agents) registered in the graph.
 */
export async function principals(graph: AllodGraph): Promise<PrincipalView[]> {
  return withGraph(graph, () => {
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
  });
}

/**
 * Register a new agent principal in the graph.
 * Returns the agent's name and a ready-to-use MCP snippet string.
 *
 * NOTE: The mcpSnippet shape is a placeholder — F6 finalizes the exact MCP
 * server configuration format including the transport, port, and auth.
 */
export async function registerAgent(
  graph: AllodGraph,
  agentName: string,
  by: string
): Promise<{ name: string; mcpSnippet: string }> {
  return withGraph(graph, async () => {
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
  });
}
