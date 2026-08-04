// @freehold/core — public API

// Types
export type {
  AdmissionStatus,
  Admission,
  EntityView,
  EdgeView,
  RevisionView,
  ProposalView,
  AttributeDiff,
  VerifyReport,
  DegradedItem,
  PrincipalView,
  SchemaDescription,
  EntityTypeView,
  EdgeTypeView,
  TermView,
  FreeholdConfig,
} from "./types.js";

// Allod wiring
export { openGraph, createGraph } from "./allod.js";

// Home / config
export { resolveHome, ensureHome } from "./home.js";
export { loadConfig, saveConfig } from "./config.js";

// Graph singleton
export { Freehold } from "./graphs.js";

// Knowledge operations
export {
  remember,
  createEntity,
  updateEntity,
  relate,
  classifyEntity,
  attachDocument,
} from "./knowledge.js";
export type {
  RememberResult,
  CreateEntityResult,
  UpdateEntityResult,
  RelateResult,
  ClassifyResult,
  AttachDocumentResult,
} from "./knowledge.js";

// Governance operations
export {
  pending,
  approve,
  reject,
  verifyGraph,
  principals,
  registerAgent,
} from "./governance.js";
export type { ApproveResult, RejectResult } from "./governance.js";

// Retrieval operations
export { getEntity, traverse, entitiesOfType } from "./retrieval.js";

// Schema operations
export { describeSchema, proposeOntologyChange, installOntology } from "./schema.js";
export type { OntologyProposalResult } from "./schema.js";
