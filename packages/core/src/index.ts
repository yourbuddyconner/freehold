// @freehold/core — public API

// Graph mutex
export { withGraph } from "./lock.js";

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

// Graph registry
export { GraphManager } from "./manager.js";
export type { GraphEntry } from "./manager.js";

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
export { getEntity, traverse, entitiesOfType, changesetDirFor } from "./retrieval.js";
// Graph log type extensions
export type { RawLogEntry, LoggableGraph } from "./retrieval.js";

// Schema operations
export {
  describeSchema,
  proposeOntologyChange,
  installOntology,
  getPolicy,
  proposePolicyChange,
} from "./schema.js";
export type { OntologyProposalResult } from "./schema.js";

// Embedding
export { hashEmbedder, transformersEmbedder, makeEmbedder } from "./embed.js";
export type { Embedder } from "./embed.js";

// Database handle + graph-scoped helpers
export type { DbHandle, ObjectRow, UpsertObjectParams } from "./db.js";
export {
  DEFAULT_GRAPH_ID,
  fmtVec,
  getIndexedHead,
  setIndexedHead,
  deleteIndexedHead,
  upsertObject,
  listObjects,
  upsertEdge,
  upsertNodeTerm,
} from "./db.js";

// Index sync
export { syncIndex, reindex } from "./indexer.js";

// Recall
export { recall, recentMemories } from "./recall.js";

// Workspace views
export { memoryIndex, memoryGraph, deriveTitle } from "./graphview.js";
export type {
  MemoryIndexEntry,
  MemoryGraphView,
  GraphNode,
  GraphEdge,
} from "./graphview.js";
export type { RecallResult, RecallFilters } from "./recall.js";
