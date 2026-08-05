/**
 * FreeholdClient — typed fetch wrapper for the Freehold API.
 *
 * Generated types come from src/types.ts (auto-generated, never hand-edit).
 * This file IS hand-edited.
 *
 * NOTE: This source is exported from packages/client/src/client.ts as-is.
 * Before F10 bundling is implemented, consuming code must run within the
 * monorepo workspace; bare npm consumption will encounter ".js" import paths
 * that assume pnpm workspaces. Revisit export strategy post-F10.
 */

import type { components, paths } from "./types.js";

// ---------------------------------------------------------------------------
// Re-export schema types for consumers
// ---------------------------------------------------------------------------

export type Schemas = components["schemas"];
export type AdmissionResponse = Schemas["AdmissionResponse"];
export type RememberResponse = Schemas["RememberResponse"];
export type ProposalView = Schemas["ProposalView"];
export type RecallResult = Schemas["RecallResult"];
export type VerifyReport = Schemas["VerifyReport"];
export type SchemaDescription = Schemas["SchemaDescription"];

export type SessionInfo = Schemas["SessionInfo"];
export type SessionGraphEntry = Schemas["SessionGraphEntry"];
export type MemoryIndexEntry = Schemas["MemoryIndexEntry"];
export type MemoryGraphView = Schemas["MemoryGraphView"];
export type GraphNode = Schemas["GraphNode"];
export type GraphEdge = Schemas["GraphEdge"];

export type RememberBody = Schemas["RememberBody"];
export type CreateEntityBody = Schemas["CreateEntityBody"];
export type UpdateEntityBody = Schemas["UpdateEntityBody"];
export type RelateBody = Schemas["RelateBody"];
export type ClassifyBody = Schemas["ClassifyBody"];
export type AttachDocumentBody = Schemas["AttachDocumentBody"];
export type RegisterAgentBody = Schemas["RegisterAgentBody"];
export type ProposeOntologyBody = Schemas["ProposeOntologyBody"];
export type InstallOntologyBody = Schemas["InstallOntologyBody"];
export type GraphInfo = Schemas["GraphInfo"];
export type RegisterGraphBody = Schemas["RegisterGraphBody"];
export type UpdateGraphBody = Schemas["UpdateGraphBody"];
export type CodeItem = Schemas["CodeItem"];
export type CodeFileView = Schemas["CodeFileView"];
export type CodeItemView = Schemas["CodeItemView"];
export type RegionRule = Schemas["RegionRule"];
export type CodeNeighborhood = Schemas["CodeNeighborhood"];
export type CodeSource = Schemas["CodeSource"];

export type GitProposal = Schemas["GitProposal"];
export type GitProposalPath = Schemas["GitProposalPath"];
export type DecideBody = Schemas["DecideBody"];
export type DecideResult = Schemas["DecideResult"];
export type PostReviewBody = Schemas["PostReviewBody"];
export type PostReviewResult = Schemas["PostReviewResult"];
export type ReviewEntry = Schemas["ReviewEntry"];
export type ReviewComment = Schemas["ReviewComment"];
export type ReviewCommentInput = Schemas["ReviewCommentInput"];
export type DiffFile = Schemas["DiffFile"];
export type DiffResponse = Schemas["DiffResponse"];

// ---------------------------------------------------------------------------
// Health response (inline in openapi)
// ---------------------------------------------------------------------------
export interface HealthResponse {
  status: "ok";
}

// ---------------------------------------------------------------------------
// ApiError — thrown on { error: { code, message } } responses
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ErrorBody {
  error?: { code?: string; message?: string };
}

// ---------------------------------------------------------------------------
// FreeholdClient
// ---------------------------------------------------------------------------

export interface FreeholdClientOptions {
  baseUrl: string;
  token: string;
  /**
   * When set, all graph-scoped /api/v1/... paths are rewritten to
   * /api/v1/graphs/<graphId>/... Graph-agnostic routes (session, agents,
   * openapi.json, graphs CRUD) are never rewritten.
   */
  graphId?: string;
}

/**
 * Routes under /api/v1/ that are NOT graph-scoped.
 * Paths starting with these segments are passed through unchanged even when
 * graphId is set.
 */
const GRAPH_AGNOSTIC_PREFIXES = [
  "/api/v1/session",
  "/api/v1/agents",
  "/api/v1/openapi.json",
  "/api/v1/graphs",
];

export class FreeholdClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private graphId: string | undefined;

  constructor({ baseUrl, token, graphId }: FreeholdClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.graphId = graphId;
  }

  /** Switch the active graph. Call after updating localStorage. */
  setGraphId(id: string | undefined): void {
    this.graphId = id;
  }

  /** Returns the currently active graph id, or undefined for the default. */
  getGraphId(): string | undefined {
    return this.graphId;
  }

  /**
   * Rewrite a /api/v1/... path to /api/v1/graphs/<graphId>/... when graphId
   * is set and the path is graph-scoped.
   */
  private scopePath(path: string): string {
    if (!this.graphId) return path;
    if (GRAPH_AGNOSTIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
      return path;
    }
    if (path.startsWith("/api/v1/")) {
      return `/api/v1/graphs/${this.graphId}/${path.slice("/api/v1/".length)}`;
    }
    return path;
  }

  // -------------------------------------------------------------------------
  // Internal fetch helper
  // -------------------------------------------------------------------------

  private async fetch<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined> } = {}
  ): Promise<T> {
    let url = `${this.baseUrl}${this.scopePath(path)}`;

    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) params.set(k, v);
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };

    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body });
    } catch (err) {
      // Network error / ECONNREFUSED
      throw Object.assign(new Error(`Network error: ${(err as Error).message}`), {
        code: "ECONNREFUSED",
      });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      if (!res.ok) {
        throw new ApiError("http_error", `HTTP ${res.status}`, res.status);
      }
      return undefined as unknown as T;
    }

    if (!res.ok) {
      const eb = json as ErrorBody;
      const code = eb?.error?.code ?? "http_error";
      const message = eb?.error?.message ?? `HTTP ${res.status}`;
      throw new ApiError(code, message, res.status);
    }

    return json as T;
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /** GET /health */
  async health(): Promise<HealthResponse> {
    return this.fetch<HealthResponse>("GET", "/health");
  }

  /** POST /api/v1/remember */
  async remember(body: RememberBody): Promise<RememberResponse> {
    return this.fetch<RememberResponse>("POST", "/api/v1/remember", { body });
  }

  /** POST /api/v1/entities */
  async createEntity(body: CreateEntityBody): Promise<AdmissionResponse> {
    return this.fetch<AdmissionResponse>("POST", "/api/v1/entities", { body });
  }

  /** PATCH /api/v1/entities/{id} */
  async updateEntity(id: string, body: UpdateEntityBody): Promise<AdmissionResponse> {
    return this.fetch<AdmissionResponse>("PATCH", `/api/v1/entities/${id}`, { body });
  }

  /** GET /api/v1/entities/{id} */
  async getEntity(id: string): Promise<unknown> {
    return this.fetch<unknown>("GET", `/api/v1/entities/${id}`);
  }

  /** POST /api/v1/relations */
  async createRelation(body: RelateBody): Promise<AdmissionResponse> {
    return this.fetch<AdmissionResponse>("POST", "/api/v1/relations", { body });
  }

  /** POST /api/v1/classifications */
  async classify(body: ClassifyBody): Promise<AdmissionResponse> {
    return this.fetch<AdmissionResponse>("POST", "/api/v1/classifications", { body });
  }

  /** POST /api/v1/documents */
  async attachDocument(body: AttachDocumentBody): Promise<AdmissionResponse> {
    return this.fetch<AdmissionResponse>("POST", "/api/v1/documents", { body });
  }

  /** GET /api/v1/memories — recent memories, newest first */
  async recentMemories(
    opts: { type?: string; author?: string; status?: string; limit?: string } = {}
  ): Promise<{ results: RecallResult[] }> {
    return this.fetch<{ results: RecallResult[] }>("GET", "/api/v1/memories", {
      query: { type: opts.type, author: opts.author, status: opts.status, limit: opts.limit },
    });
  }

  /** GET /api/v1/memories?scope=all — full workspace index for the tree */
  async memoryIndex(): Promise<{ results: MemoryIndexEntry[] }> {
    return this.fetch<{ results: MemoryIndexEntry[] }>("GET", "/api/v1/memories", {
      query: { scope: "all" },
    });
  }

  /** GET /api/v1/graph — nodes and edges for the graph canvas */
  async graph(): Promise<MemoryGraphView> {
    return this.fetch<MemoryGraphView>("GET", "/api/v1/graph");
  }

  /** GET /api/v1/recall */
  async recall(
    q: string,
    opts: { type?: string; author?: string; status?: string } = {}
  ): Promise<{ results: RecallResult[] }> {
    return this.fetch<{ results: RecallResult[] }>("GET", "/api/v1/recall", {
      query: { q, type: opts.type, author: opts.author, status: opts.status },
    });
  }

  /** GET /api/v1/entities/{id}/traverse */
  async traverse(
    id: string,
    opts: { edgeTypes?: string; direction?: "out" | "in" | "both"; depth?: string } = {}
  ): Promise<unknown> {
    return this.fetch<unknown>("GET", `/api/v1/entities/${id}/traverse`, {
      query: {
        edgeTypes: opts.edgeTypes,
        direction: opts.direction,
        depth: opts.depth,
      },
    });
  }

  /** GET /api/v1/proposals */
  async proposals(): Promise<{ proposals: ProposalView[] }> {
    return this.fetch<{ proposals: ProposalView[] }>("GET", "/api/v1/proposals");
  }

  /** POST /api/v1/proposals/{hash}/approve */
  async approve(hash: string): Promise<unknown> {
    return this.fetch<unknown>("POST", `/api/v1/proposals/${hash}/approve`);
  }

  /** POST /api/v1/proposals/{hash}/reject */
  async reject(hash: string): Promise<unknown> {
    return this.fetch<unknown>("POST", `/api/v1/proposals/${hash}/reject`);
  }

  /** GET /api/v1/verify */
  async verify(): Promise<VerifyReport> {
    return this.fetch<VerifyReport>("GET", "/api/v1/verify");
  }

  /** POST /api/v1/reindex */
  async reindex(): Promise<{ status: string }> {
    return this.fetch<{ status: string }>("POST", "/api/v1/reindex");
  }

  /** GET /api/v1/principals */
  async principals(): Promise<unknown> {
    return this.fetch<unknown>("GET", "/api/v1/principals");
  }

  /** POST /api/v1/agents */
  async registerAgent(body: RegisterAgentBody): Promise<unknown> {
    return this.fetch<unknown>("POST", "/api/v1/agents", { body });
  }

  /** GET /api/v1/schema */
  async schema(): Promise<SchemaDescription> {
    return this.fetch<SchemaDescription>("GET", "/api/v1/schema");
  }

  /** POST /api/v1/schema/proposals */
  async proposeOntology(body: ProposeOntologyBody): Promise<unknown> {
    return this.fetch<unknown>("POST", "/api/v1/schema/proposals", { body });
  }

  /** POST /api/v1/schema/install */
  async installOntology(body: InstallOntologyBody): Promise<unknown> {
    return this.fetch<unknown>("POST", "/api/v1/schema/install", { body });
  }

  /** GET /api/v1/policy */
  async getPolicy(): Promise<unknown> {
    return this.fetch<unknown>("GET", "/api/v1/policy");
  }

  /** POST /api/v1/policy */
  async proposePolicy(body: Record<string, unknown>): Promise<unknown> {
    return this.fetch<unknown>("POST", "/api/v1/policy", { body });
  }

  /** GET /api/v1/log */
  async log(): Promise<unknown> {
    return this.fetch<unknown>("GET", "/api/v1/log");
  }

  /** GET /api/v1/session */
  async session(): Promise<SessionInfo> {
    return this.fetch<SessionInfo>("GET", "/api/v1/session");
  }

  /** GET /api/v1/openapi.json */
  async openapiSpec(): Promise<unknown> {
    return this.fetch<unknown>("GET", "/api/v1/openapi.json");
  }

  /** GET /api/v1/graphs — list all registered graphs */
  async listGraphs(): Promise<{ graphs: GraphInfo[] }> {
    return this.fetch<{ graphs: GraphInfo[] }>("GET", "/api/v1/graphs");
  }

  /** POST /api/v1/graphs — register a new graph */
  async registerGraph(body: RegisterGraphBody): Promise<GraphInfo> {
    return this.fetch<GraphInfo>("POST", "/api/v1/graphs", { body });
  }

  /** PATCH /api/v1/graphs/:id — update graph metadata */
  async updateGraph(id: string, body: UpdateGraphBody): Promise<GraphInfo> {
    return this.fetch<GraphInfo>("PATCH", `/api/v1/graphs/${id}`, { body });
  }

  /** GET /api/v1/code/tree — file tree for the active graph (must be repo kind) */
  async codeTree(): Promise<{ tree: unknown[] }> {
    return this.fetch<{ tree: unknown[] }>("GET", "/api/v1/code/tree");
  }

  /** GET /api/v1/code/file?path= — file view for the given path */
  async codeFile(path: string): Promise<CodeFileView> {
    return this.fetch<CodeFileView>("GET", "/api/v1/code/file", { query: { path } });
  }

  /** GET /api/v1/code/item/:nodeId — item view with callers/callees */
  async codeItem(nodeId: string): Promise<CodeItemView> {
    return this.fetch<CodeItemView>("GET", `/api/v1/code/item/${nodeId}`);
  }

  /** GET /api/v1/code/regions — policy region membership */
  async codeRegions(): Promise<{ rules: RegionRule[] }> {
    return this.fetch<{ rules: RegionRule[] }>("GET", "/api/v1/code/regions");
  }

  /** GET /api/v1/code/neighborhood?path= — nodes and edges one hop from the file */
  async codeNeighborhood(path: string): Promise<CodeNeighborhood> {
    return this.fetch<CodeNeighborhood>("GET", "/api/v1/code/neighborhood", { query: { path } });
  }

  /** GET /api/v1/code/source?path= — working-tree file content */
  async codeSource(path: string): Promise<CodeSource> {
    return this.fetch<CodeSource>("GET", "/api/v1/code/source", { query: { path } });
  }

  /** GET /api/v1/git/proposals — list all branch-head git proposals */
  async listGitProposals(): Promise<{ proposals: GitProposal[] }> {
    return this.fetch<{ proposals: GitProposal[] }>("GET", "/api/v1/git/proposals");
  }

  /** GET /api/v1/git/proposals/:sha — get a single git proposal by sha */
  async getGitProposal(sha: string): Promise<GitProposal> {
    return this.fetch<GitProposal>("GET", `/api/v1/git/proposals/${sha}`);
  }

  /** POST /api/v1/git/proposals/:sha/decide — sign a decision for a git proposal */
  async decideGitProposal(sha: string, body: DecideBody): Promise<DecideResult> {
    return this.fetch<DecideResult>("POST", `/api/v1/git/proposals/${sha}/decide`, { body });
  }

  /** POST /api/v1/git/proposals/:sha/reviews — post a code review */
  async postGitReview(sha: string, body: PostReviewBody): Promise<PostReviewResult> {
    return this.fetch<PostReviewResult>("POST", `/api/v1/git/proposals/${sha}/reviews`, { body });
  }

  /** GET /api/v1/git/proposals/:sha/reviews — list reviews for a git proposal */
  async listGitReviews(sha: string): Promise<{ reviews: ReviewEntry[] }> {
    return this.fetch<{ reviews: ReviewEntry[] }>("GET", `/api/v1/git/proposals/${sha}/reviews`);
  }

  /** POST /api/v1/git/proposals/:sha/push-notes — push decision notes to remote */
  async pushGitNotes(sha: string): Promise<{ pushed: boolean; pushError?: string }> {
    return this.fetch<{ pushed: boolean; pushError?: string }>(
      "POST",
      `/api/v1/git/proposals/${sha}/push-notes`
    );
  }

  /** GET /api/v1/git/proposals/:sha/diff — get per-file unified diff for a commit */
  async gitProposalDiff(sha: string): Promise<DiffResponse> {
    return this.fetch<DiffResponse>("GET", `/api/v1/git/proposals/${sha}/diff`);
  }

  /** GET /connector — get connector status and config */
  async getConnector(): Promise<{
    configured: boolean;
    config?: Record<string, unknown>;
    status: { lastPollAt?: string; lastErrors?: string[] };
  }> {
    return this.fetch("GET", "/api/v1/connector");
  }

  /** PUT /connector — configure credential mode or update webhook settings */
  async putConnector(
    body:
      | {
          mode: "credential";
          pollIntervalSec?: number;
          webhooksEnabled?: boolean;
          publicUrl?: string;
        }
      | { webhooksEnabled: boolean; publicUrl?: string }
  ): Promise<Record<string, unknown>> {
    return this.fetch("PUT", "/api/v1/connector", { body });
  }

  /** DELETE /connector — remove connector config */
  async deleteConnector(): Promise<{ ok: boolean }> {
    return this.fetch("DELETE", "/api/v1/connector");
  }

  /** POST /connector/poll — run a poll immediately */
  async pollConnector(): Promise<{ events: number; unchanged: number; errors: string[] }> {
    return this.fetch("POST", "/api/v1/connector/poll");
  }

  /** POST /connector/app/manifest — get manifest + URL for GitHub App creation form-POST */
  async getConnectorManifest(): Promise<{
    manifestUrl: string;
    manifest: Record<string, unknown>;
    state: string;
  }> {
    return this.fetch("POST", "/api/v1/connector/app/manifest");
  }
}
