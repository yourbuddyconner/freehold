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

export type RememberBody = Schemas["RememberBody"];
export type CreateEntityBody = Schemas["CreateEntityBody"];
export type UpdateEntityBody = Schemas["UpdateEntityBody"];
export type RelateBody = Schemas["RelateBody"];
export type ClassifyBody = Schemas["ClassifyBody"];
export type AttachDocumentBody = Schemas["AttachDocumentBody"];
export type RegisterAgentBody = Schemas["RegisterAgentBody"];
export type ProposeOntologyBody = Schemas["ProposeOntologyBody"];
export type InstallOntologyBody = Schemas["InstallOntologyBody"];

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
}

export class FreeholdClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor({ baseUrl, token }: FreeholdClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  // -------------------------------------------------------------------------
  // Internal fetch helper
  // -------------------------------------------------------------------------

  private async fetch<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined> } = {}
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

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

  /** GET /api/v1/openapi.json */
  async openapiSpec(): Promise<unknown> {
    return this.fetch<unknown>("GET", "/api/v1/openapi.json");
  }
}
