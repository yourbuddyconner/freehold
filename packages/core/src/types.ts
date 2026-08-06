// Shared types consumed throughout core + re-exported

export type AdmissionStatus = "saved" | "pending";

export interface Admission {
  status: AdmissionStatus;
  hash: string;
  proposal?: unknown;
  rule?: string[];
}

export interface EntityView {
  id: string;
  type: string;
  /** Current revision hash of the node's content — pass as `prior` on update */
  rev: string;
  attributes: Record<string, unknown>;
  classifications: string[];
  edges: EdgeView[];
  provenance?: unknown;
  revisions: RevisionView[];
}

export interface EdgeView {
  id: string;
  type: string;
  from: string;
  to: string;
  direction: "outgoing" | "incoming";
  attributes?: Record<string, unknown>;
}

export interface RevisionView {
  hash: string;
  timestamp?: string;
  author?: string;
}

export interface ProposalView {
  hash: string;
  agent: string;
  intent: string;
  summary: string;
  rules: string[];
  diff: AttributeDiff[];
  isSchemaProposal: boolean;
  /** The existing node this proposal targets (classification subject or
   *  update target), with its resolved display title. Null for creates —
   *  their content is the diff itself. */
  subject: { id: string; title: string } | null;
}

export interface AttributeDiff {
  key: string;
  before: unknown;
  after: unknown;
}

export interface VerifyReport {
  ok: boolean;
  stateHash?: string;
  degraded?: DegradedItem[];
}

export interface DegradedItem {
  id: string;
  reason: string;
}

export interface PrincipalView {
  name: string;
  kind: string;
}

export interface SchemaDescription {
  entityTypes: EntityTypeView[];
  edgeTypes: EdgeTypeView[];
  terms: TermView[];
}

export interface EntityTypeView {
  name: string;
  package?: string;
  attributes?: Record<string, unknown>;
  extends?: string;
}

export interface EdgeTypeView {
  name: string;
  domain?: string;
  range?: string;
}

export interface TermView {
  name: string;
  parent?: string;
}

export interface FreeholdConfig {
  token: string;
  graph: string;
  embedder: "transformers" | "hash";
  port: number;
  /** Default agent principal name used by MCP tools when no `agent` param is provided. */
  defaultAgent?: string;
  /**
   * Path to the allod binary. Defaults to "allod" (resolved on PATH).
   * Override via ~/.freehold/config.json: { "allodBin": "/path/to/allod" }
   */
  allodBin?: string;
}
