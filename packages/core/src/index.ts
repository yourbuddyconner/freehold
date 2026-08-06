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

// Code graph views
export {
  codeTree,
  codeFile,
  codeItem,
  codeNeighborhood,
  codeRegions,
  codeSource,
  PathTraversalError,
} from "./codeview.js";
export type {
  CodeTreeNode,
  CodeItem,
  CodeFileView,
  CodeItemView,
  CodeNeighborhood,
  RegionRule,
  CodeSource,
} from "./codeview.js";
export type { RecallResult, RecallFilters } from "./recall.js";

// Git suggestion apply
export {
  applySuggestion,
  BranchMovedError,
  BinaryFileError,
  OldSideSpanError,
  InvalidSpanError,
} from "./gitapply.js";
export type { ApplySuggestionInput, ApplySuggestionResult } from "./gitapply.js";

// Git proposal review
export {
  listGitProposals,
  gitProposal,
  decideGit,
  KeyMissingError,
  listReviewsForSha,
  postReview,
  evictProposalCache,
  proposalCacheKey,
} from "./gitreview.js";
export { branchHeads, pushNotes, commitDiff, decisionsTip } from "./git.js";
export type { DiffFile } from "./git.js";
export type {
  GitProposal,
  DecideResult,
  ReviewEntry,
  ReviewCommentEntry,
  PostReviewInput,
  PostReviewResult,
  PostReviewComment,
} from "./gitreview.js";

// Code comments
export {
  postCodeComment,
  listCodeComments,
  CodeCommentKeyMissingError,
} from "./codecomments.js";
export type { PostCodeCommentInput, CodeCommentEntry } from "./codecomments.js";

// Connector core
export { makeTokenClient, parseOriginRemote, discoverCredential } from "./connector/github.js";
export type { GithubClient } from "./connector/github.js";
export {
  getConnector,
  setConnector,
  getSecret,
  deriveEncKey,
} from "./connector/config.js";
export type { ConnectorConfig, ConnectorMode } from "./connector/config.js";
export { handleConnectorEvent, getCommentNodeByExternalId } from "./connector/events.js";
export type { ConnectorEvent, IngestResult, CommentNodeInfo } from "./connector/events.js";

// Connector polling transport
export { pollOnce, startPoller } from "./connector/poll.js";
export type { PollResult } from "./connector/poll.js";

// Connector GitHub App mode (JWT minting, installation tokens, manifest builder)
export {
  mintAppJwt,
  makeAppClient,
  clearAppClientCache,
  buildConnectorManifest,
} from "./connector/app.js";
export type { AppManifest } from "./connector/app.js";
