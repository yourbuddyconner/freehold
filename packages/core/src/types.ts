// Shared types consumed throughout core + re-exported

export type AdmissionStatus = "admitted" | "held";

export interface Admission {
  status: AdmissionStatus;
  hash: string;
  proposal?: unknown;
  rule?: string[];
}

export interface EntityView {
  id: string;
  type: string;
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
}
