import { writeFileSync } from "node:fs";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Required: extend zod with .openapi() metadata method
extendZodWithOpenApi(z);

// ---- Request body schemas (mirrored from route files) ----

const RememberBody = z
  .object({
    agent: z.string().openapi({ description: "Agent name performing the write" }),
    content: z.string().openapi({ description: "Free-text note content" }),
  })
  .openapi("RememberBody");

const CreateEntityBody = z
  .object({
    agent: z.string(),
    type: z.string().openapi({ description: "Entity type ref, e.g. memory/Preference@1" }),
    attributes: z.record(z.unknown()),
    classification: z.string().optional(),
  })
  .openapi("CreateEntityBody");

const UpdateEntityBody = z
  .object({
    agent: z.string(),
    type: z.string(),
    attributes: z.record(z.unknown()),
    prior: z.string().optional().openapi({ description: "Hash of the changeset being superseded" }),
  })
  .openapi("UpdateEntityBody");

const RelateBody = z
  .object({
    agent: z.string(),
    from: z.string(),
    to: z.string(),
    edgeType: z.string(),
    attributes: z.record(z.unknown()).optional(),
    scratch: z.boolean().optional(),
  })
  .openapi("RelateBody");

const ClassifyBody = z
  .object({
    agent: z.string(),
    nodeId: z.string(),
    term: z.string(),
    basis: z.enum(["model-assisted", "manual"]).optional().openapi({
      description: "How the classification was derived; manual assertions skip the envelope rule",
    }),
  })
  .openapi("ClassifyBody");

const AttachDocumentBody = z
  .object({
    agent: z.string(),
    entityId: z.string(),
    content: z.string(),
    title: z.string().optional(),
  })
  .openapi("AttachDocumentBody");

const RegisterAgentBody = z
  .object({
    name: z.string(),
  })
  .openapi("RegisterAgentBody");

const AddPrincipalBody = z
  .object({
    name: z.string(),
    kind: z.enum(["user", "agent", "service"]).optional().default("user"),
    role: z.string().optional(),
  })
  .openapi("AddPrincipalBody");

const ProposeOntologyBody = z
  .object({
    agent: z.string(),
    packageName: z.string(),
    ontologyYaml: z.string(),
  })
  .openapi("ProposeOntologyBody");

const InstallOntologyBody = z
  .object({
    docsYaml: z.string(),
  })
  .openapi("InstallOntologyBody");

const PolicyBody = z
  .object({
    policy_yaml: z
      .string()
      .openapi({ description: "Complete replacement policy document (YAML or JSON)" }),
    agent: z.string().optional().openapi({
      description: "Authoring agent principal; omitted means the owner proposes",
    }),
  })
  .openapi("PolicyBody");

const SessionGraphEntry = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["memory", "repo"]),
  })
  .openapi("SessionGraphEntry");

const SessionInfo = z
  .object({
    defaultAgent: z.string().nullable().openapi({ description: "Default MCP agent name, if set" }),
    embedder: z.enum(["transformers", "hash"]).openapi({ description: "Active embedder backend" }),
    port: z.number().openapi({ description: "Freehold's local port" }),
    owner: z
      .string()
      .openapi({ description: "The graph's owner principal; console edits sign as this name" }),
    graphs: z
      .array(SessionGraphEntry)
      .openapi({ description: "Slim list of registered graphs (id, name, kind)" }),
    defaultGraph: z.string().openapi({ description: "ID of the default graph" }),
  })
  .openapi("SessionInfo");

const GraphInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    kind: z.enum(["memory", "repo"]),
    autoPushNotes: z.boolean(),
    embedder: z.enum(["hash", "semantic"]),
    allodGraphId: z.string(),
    originRemote: z.string().nullable(),
    signingPrincipal: z.string().openapi({
      description: "The principal name whose key signs decide/review operations on this graph",
    }),
    ignoreBranches: z.array(z.string()).openapi({
      description:
        "Glob patterns matched against bare branch names (no refs/heads/ prefix). Matching branches are excluded from proposal listings. Default: [].",
    }),
  })
  .openapi("GraphInfo");

const RegisterGraphBody = z
  .object({
    path: z.string().openapi({ description: "Absolute path to the repo checkout" }),
    id: z
      .string()
      .optional()
      .openapi({ description: "Registry slug id; defaults to basename of path" }),
    name: z.string().optional().openapi({ description: "Display name; defaults to id" }),
    signingPrincipal: z
      .string()
      .optional()
      .openapi({ description: "Signing principal; defaults to 'owner'" }),
  })
  .openapi("RegisterGraphBody");

const UpdateGraphBody = z
  .object({
    name: z.string().optional(),
    autoPushNotes: z.boolean().optional(),
    embedder: z.enum(["hash", "semantic"]).optional(),
    ignoreBranches: z.array(z.string()).optional().openapi({
      description:
        "Glob patterns to exclude from proposal listings (matched against bare branch names). Placeholder: worktree-*.",
    }),
  })
  .openapi("UpdateGraphBody");

// ---- Repo onboarding schemas ----

const OnboardStep = z
  .object({
    step: z.string().openapi({ description: "Step name, e.g. 'allod init'" }),
    status: z.enum(["ok", "skipped", "failed"]),
    detail: z.string().optional().openapi({ description: "Error or skip reason" }),
  })
  .openapi("OnboardStep");

const OnboardRepoBody = z
  .object({
    path: z.string().openapi({ description: "Absolute path to the repository checkout" }),
    name: z
      .string()
      .optional()
      .openapi({ description: "Display name; defaults to basename of path" }),
    id: z
      .string()
      .optional()
      .openapi({ description: "Registry slug id; defaults to basename of path" }),
    principal: z
      .string()
      .optional()
      .openapi({ description: "Signing principal; defaults to 'owner'" }),
    noIndex: z.boolean().optional().openapi({ description: "Skip the initial git index step" }),
    defaultBranch: z
      .string()
      .optional()
      .openapi({ description: "Default branch for git index; defaults to 'main'" }),
  })
  .openapi("OnboardRepoBody");

const OnboardRepoResult = z
  .object({
    steps: z.array(OnboardStep),
    entry: GraphInfo,
    keyPath: z.string().openapi({ description: "Absolute path to the generated key file" }),
    principal: z.string().openapi({ description: "Principal whose key was generated or verified" }),
  })
  .openapi("OnboardRepoResult");

// ---- Code view schemas ----

const CodeItem = z
  .object({
    nodeId: z.string(),
    type: z.string(),
    name: z.string(),
    signature: z.string().optional(),
    span: z.string().optional(),
    terms: z.array(z.string()),
    /** File path of the source file declaring this item. Present on caller/callee rows. */
    filePath: z.string().optional(),
  })
  .openapi("CodeItem");

const CodeTreeNode: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      path: z.string(),
      kind: z.enum(["dir", "file"]),
      language: z.string().optional(),
      terms: z.array(z.string()),
      children: z.array(CodeTreeNode).optional(),
    })
    .openapi("CodeTreeNode")
);

const CodeFileView = z
  .object({
    path: z.string(),
    language: z.string().optional(),
    nodeId: z.string(),
    blobRef: z.string().optional(),
    terms: z.array(z.string()),
    items: z.array(CodeItem),
  })
  .openapi("CodeFileView");

const CodeItemView = CodeItem.extend({
  filePath: z.string().optional(),
  callersIn: z.array(CodeItem),
  callsOut: z.array(CodeItem),
}).openapi("CodeItemView");

const RegionRule = z
  .object({
    rule: z.string(),
    region: z.string().optional(),
    reviewers: z.unknown(),
    paths: z.array(z.string()),
  })
  .openapi("RegionRule");

const CodeNeighborhoodNode = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  terms: z.array(z.string()),
});

const CodeNeighborhoodEdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.string(),
});

const CodeNeighborhood = z
  .object({
    nodes: z.array(CodeNeighborhoodNode),
    edges: z.array(CodeNeighborhoodEdge),
  })
  .openapi("CodeNeighborhood");

const CodeSource = z
  .object({
    path: z.string(),
    content: z.string().openapi({ description: "UTF-8 source text (empty when binary)" }),
    truncated: z.boolean().openapi({ description: "True when file exceeded 512 KB read limit" }),
    binary: z
      .boolean()
      .openapi({ description: "True when a NUL byte was detected in the first 8 KB" }),
    size: z
      .number()
      .int()
      .openapi({ description: "File size in bytes (full file, not truncated)" }),
  })
  .openapi("CodeSource");

// ---- Response schemas ----

const AdmissionResponse = z
  .object({
    status: z.enum(["saved", "pending"]),
    hash: z.string(),
    proposal: z.unknown().optional(),
    rule: z.array(z.string()).optional(),
  })
  .openapi("AdmissionResponse");

const RememberResponse = AdmissionResponse.extend({
  noteId: z.string().optional(),
  changeset: z.string().optional(),
}).openapi("RememberResponse");

const ProposalView = z
  .object({
    hash: z.string(),
    agent: z.string(),
    intent: z.string(),
    summary: z.string(),
    rules: z.array(z.string()),
    diff: z.array(z.object({ key: z.string(), before: z.unknown(), after: z.unknown() })),
    isSchemaProposal: z.boolean(),
    subject: z.object({ id: z.string(), title: z.string() }).nullable().openapi({
      description:
        "The existing node this proposal targets, with its resolved title; null for creates",
    }),
  })
  .openapi("ProposalView");

const RecallResult = z
  .object({
    id: z.string(),
    type: z.string(),
    content: z.unknown(),
    author: z.string(),
    method: z.string().nullable().openapi({
      description: "Provenance method (model-assisted, manual, etc.) or null for unrecorded",
    }),
    approval: z
      .string()
      .openapi({ description: "approval field; maps from the `status` query parameter" }),
    changeset: z.string(),
    score: z.number(),
  })
  .openapi("RecallResult");

const MemoryIndexEntry = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string().openapi({
      description: "Display title derived from attributes (title, name, statement, first line)",
    }),
    approval: z.string(),
    author: z.string(),
    updatedAt: z.string(),
    terms: z.array(z.string()).openapi({ description: "Taxonomy terms from fold state" }),
  })
  .openapi("MemoryIndexEntry");

const GraphNode = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    approval: z.string(),
    terms: z.array(z.string()),
  })
  .openapi("GraphNode");

const GraphEdge = z
  .object({
    id: z.string(),
    type: z.string(),
    from: z.string(),
    to: z.string(),
  })
  .openapi("GraphEdge");

const MemoryGraphView = z
  .object({
    nodes: z.array(GraphNode),
    edges: z.array(GraphEdge),
    truncated: z.boolean().openapi({ description: "True when the node cap cut the listing short" }),
  })
  .openapi("MemoryGraphView");

const VerifyReport = z
  .object({
    ok: z.boolean(),
    stateHash: z.string().optional(),
    degraded: z.array(z.object({ id: z.string(), reason: z.string() })).optional(),
  })
  .openapi("VerifyReport");

const SchemaDescription = z
  .object({
    entityTypes: z.array(
      z.object({
        name: z.string(),
        package: z.string().optional(),
        attributes: z.record(z.unknown()).optional(),
        extends: z.string().optional(),
      })
    ),
    edgeTypes: z.array(
      z.object({
        name: z.string(),
        domain: z.string().optional(),
        range: z.string().optional(),
      })
    ),
    terms: z.array(
      z.object({
        name: z.string(),
        parent: z.string().optional(),
      })
    ),
  })
  .openapi("SchemaDescription");

// ---- Connector schemas ----

const ConnectorStatus = z
  .object({
    lastPollAt: z
      .string()
      .optional()
      .openapi({ description: "ISO timestamp of last successful poll" }),
    lastErrors: z
      .array(z.string())
      .optional()
      .openapi({ description: "Errors from last poll cycle" }),
  })
  .openapi("ConnectorStatus");

const ConnectorConfigView = z
  .object({
    mode: z.enum(["credential", "app"]).openapi({ description: "Authentication mode" }),
    owner: z.string(),
    repo: z.string(),
    pollIntervalSec: z.number(),
    webhooksEnabled: z.boolean(),
    appId: z.string().optional(),
    appSlug: z.string().optional(),
    installationId: z.string().optional(),
  })
  .openapi("ConnectorConfigView");

const ConnectorResponse = z
  .object({
    configured: z.boolean(),
    config: ConnectorConfigView.optional(),
    status: ConnectorStatus,
  })
  .openapi("ConnectorResponse");

const PutConnectorBody = z
  .union([
    z.object({
      mode: z
        .literal("credential")
        .openapi({ description: "Credential mode uses gh CLI token discovery" }),
      pollIntervalSec: z
        .number()
        .int()
        .positive()
        .optional()
        .openapi({ description: "Poll interval in seconds (default 300)" }),
      webhooksEnabled: z
        .boolean()
        .optional()
        .openapi({ description: "Enable webhook delivery (requires publicUrl)" }),
      publicUrl: z.string().optional().openapi({ description: "Public URL for webhook delivery" }),
    }),
    z.object({
      webhooksEnabled: z.boolean().openapi({ description: "Enable or disable webhook delivery" }),
      publicUrl: z.string().optional().openapi({ description: "Public URL for webhook delivery" }),
    }),
  ])
  .openapi("PutConnectorBody");

const PollResult = z
  .object({
    events: z.number().openapi({ description: "Number of events processed" }),
    errors: z
      .array(z.string())
      .openapi({ description: "Non-fatal errors encountered during poll" }),
    unchanged: z.number().openapi({ description: "Number of items unchanged" }),
  })
  .openapi("PollResult");

// ---- Code comment schemas ----

const CodeComment = z
  .object({
    commentId: z.string(),
    body: z.string(),
    span: z.string(),
    status: z.enum(["open"]),
    author: z.string(),
    anchorSha: z.string(),
    currentHead: z.boolean(),
  })
  .openapi("CodeComment");

const PostCodeCommentBody = z
  .object({
    path: z.string().openapi({ description: "Repo-relative file path" }),
    span: z.string().openapi({ description: "Line span, e.g. L10 or L10-L20" }),
    body: z.string().openapi({ description: "Comment text" }),
    by: z.string().openapi({ description: "Principal name signing the comment" }),
  })
  .openapi("PostCodeCommentBody");

const PostCodeCommentResult = z
  .object({
    commentId: z.string(),
    status: z.enum(["saved", "pending"]),
    anchorSha: z.string(),
  })
  .openapi("PostCodeCommentResult");

// ---- Registry setup ----

function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  // Security scheme
  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "token",
  });

  // Register schemas as components
  registry.register("RememberBody", RememberBody);
  registry.register("CreateEntityBody", CreateEntityBody);
  registry.register("UpdateEntityBody", UpdateEntityBody);
  registry.register("RelateBody", RelateBody);
  registry.register("ClassifyBody", ClassifyBody);
  registry.register("AttachDocumentBody", AttachDocumentBody);
  registry.register("RegisterAgentBody", RegisterAgentBody);
  registry.register("AddPrincipalBody", AddPrincipalBody);
  registry.register("ProposeOntologyBody", ProposeOntologyBody);
  registry.register("InstallOntologyBody", InstallOntologyBody);
  registry.register("PolicyBody", PolicyBody);
  registry.register("AdmissionResponse", AdmissionResponse);
  registry.register("RememberResponse", RememberResponse);
  registry.register("ProposalView", ProposalView);
  registry.register("RecallResult", RecallResult);
  registry.register("VerifyReport", VerifyReport);
  registry.register("SchemaDescription", SchemaDescription);
  registry.register("SessionGraphEntry", SessionGraphEntry);
  registry.register("SessionInfo", SessionInfo);
  registry.register("GraphInfo", GraphInfo);
  registry.register("RegisterGraphBody", RegisterGraphBody);
  registry.register("UpdateGraphBody", UpdateGraphBody);
  registry.register("OnboardStep", OnboardStep);
  registry.register("OnboardRepoBody", OnboardRepoBody);
  registry.register("OnboardRepoResult", OnboardRepoResult);
  registry.register("CodeItem", CodeItem);
  registry.register("CodeFileView", CodeFileView);
  registry.register("CodeItemView", CodeItemView);
  registry.register("RegionRule", RegionRule);
  registry.register("CodeNeighborhood", CodeNeighborhood);
  registry.register("ConnectorStatus", ConnectorStatus);
  registry.register("ConnectorConfigView", ConnectorConfigView);
  registry.register("ConnectorResponse", ConnectorResponse);
  registry.register("PutConnectorBody", PutConnectorBody);
  registry.register("PollResult", PollResult);
  registry.register("CodeComment", CodeComment);
  registry.register("PostCodeCommentBody", PostCodeCommentBody);
  registry.register("PostCodeCommentResult", PostCodeCommentResult);

  const auth = [{ bearerAuth: [] }];

  // ---- Routes ----

  // Health
  registry.registerPath({
    method: "get",
    path: "/health",
    summary: "Health check",
    responses: {
      "200": {
        description: "Service is up",
        content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
      },
    },
  });

  // Knowledge — remember
  registry.registerPath({
    method: "post",
    path: "/api/v1/remember",
    summary: "Write a scratch note",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: RememberBody } } },
    },
    responses: {
      "200": {
        description: "Admission result",
        content: { "application/json": { schema: RememberResponse } },
      },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Knowledge — create entity
  registry.registerPath({
    method: "post",
    path: "/api/v1/entities",
    summary: "Create an entity",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: CreateEntityBody } } },
    },
    responses: {
      "200": {
        description: "Admission result",
        content: { "application/json": { schema: AdmissionResponse } },
      },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Knowledge — update entity
  registry.registerPath({
    method: "patch",
    path: "/api/v1/entities/{id}",
    summary: "Update an entity",
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { required: true, content: { "application/json": { schema: UpdateEntityBody } } },
    },
    responses: {
      "200": {
        description: "Admission result",
        content: { "application/json": { schema: AdmissionResponse } },
      },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
      "404": { description: "Entity not found" },
    },
  });

  // Knowledge — relate
  registry.registerPath({
    method: "post",
    path: "/api/v1/relations",
    summary: "Create a relation (edge)",
    security: auth,
    request: { body: { required: true, content: { "application/json": { schema: RelateBody } } } },
    responses: {
      "200": {
        description: "Admission result",
        content: { "application/json": { schema: AdmissionResponse } },
      },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Knowledge — classify
  registry.registerPath({
    method: "post",
    path: "/api/v1/classifications",
    summary: "Add a classification",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: ClassifyBody } } },
    },
    responses: {
      "200": {
        description: "Admission result",
        content: { "application/json": { schema: AdmissionResponse } },
      },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Knowledge — attach document
  registry.registerPath({
    method: "post",
    path: "/api/v1/documents",
    summary: "Attach a document",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: AttachDocumentBody } } },
    },
    responses: {
      "200": {
        description: "Admission result",
        content: { "application/json": { schema: AdmissionResponse } },
      },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Retrieval — recent memories (no-query browse)
  registry.registerPath({
    method: "get",
    path: "/api/v1/memories",
    summary: "List recent memories",
    description:
      "Most recently indexed memories, newest first. Same result shape as recall (score is 0). The `status` query param maps to the `approval` field. With `scope=all`, returns the full workspace index instead — every non-meta node including pending proposals, as MemoryIndexEntry — and the other query params are ignored.",
    security: auth,
    request: {
      query: z.object({
        scope: z.string().optional().openapi({
          description: "Set to `all` for the full workspace index (MemoryIndexEntry shape)",
        }),
        type: z.string().optional(),
        author: z.string().optional(),
        status: z.string().optional(),
        limit: z.string().optional().openapi({ description: "Max results (default 50, cap 1000)" }),
      }),
    },
    responses: {
      "200": {
        description: "Recent memories with provenance, or the full index with scope=all",
        content: {
          "application/json": {
            schema: z.object({
              results: z.union([z.array(RecallResult), z.array(MemoryIndexEntry)]),
            }),
          },
        },
      },
    },
  });

  // Retrieval — graph export for the workspace canvas
  registry.registerPath({
    method: "get",
    path: "/api/v1/graph",
    summary: "Memory graph export",
    description:
      "All non-meta nodes and the typed edges between saved nodes, for the graph canvas.",
    security: auth,
    responses: {
      "200": {
        description: "Nodes and edges",
        content: { "application/json": { schema: MemoryGraphView } },
      },
      "401": { description: "Unauthorized" },
    },
  });

  // Retrieval — recall
  registry.registerPath({
    method: "get",
    path: "/api/v1/recall",
    summary: "Hybrid semantic recall",
    description:
      "Semantic + full-text search fused via RRF. The `status` query param maps to the `approval` field in RecallResult.",
    security: auth,
    request: {
      query: z.object({
        q: z.string().openapi({ description: "Search query (required)" }),
        type: z.string().optional(),
        author: z.string().optional(),
        status: z.string().optional().openapi({
          description: "Filter by approval state — maps to the `approval` field on RecallResult",
        }),
      }),
    },
    responses: {
      "200": {
        description: "Recall results with provenance",
        content: { "application/json": { schema: z.object({ results: z.array(RecallResult) }) } },
      },
      "400": { description: "Missing query parameter q" },
      "401": { description: "Unauthorized" },
    },
  });

  // Retrieval — get entity
  registry.registerPath({
    method: "get",
    path: "/api/v1/entities/{id}",
    summary: "Get an entity by ID",
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      "200": { description: "Entity view" },
      "401": { description: "Unauthorized" },
      "404": { description: "Entity not found" },
    },
  });

  // Retrieval — traverse
  registry.registerPath({
    method: "get",
    path: "/api/v1/entities/{id}/traverse",
    summary: "Traverse from an entity",
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({
        edgeTypes: z.string().optional(),
        direction: z.enum(["out", "in", "both"]).optional(),
        depth: z.string().optional(),
      }),
    },
    responses: {
      "200": { description: "Traversal results" },
      "401": { description: "Unauthorized" },
    },
  });

  // Governance — proposals
  registry.registerPath({
    method: "get",
    path: "/api/v1/proposals",
    summary: "List pending proposals",
    security: auth,
    responses: {
      "200": {
        description: "Pending proposals",
        content: { "application/json": { schema: z.object({ proposals: z.array(ProposalView) }) } },
      },
      "401": { description: "Unauthorized" },
    },
  });

  // Governance — approve
  registry.registerPath({
    method: "post",
    path: "/api/v1/proposals/{hash}/approve",
    summary: "Approve a proposal",
    security: auth,
    request: { params: z.object({ hash: z.string() }) },
    responses: {
      "200": { description: "Approval result" },
      "401": { description: "Unauthorized" },
      "404": { description: "Proposal not found" },
    },
  });

  // Governance — reject
  registry.registerPath({
    method: "post",
    path: "/api/v1/proposals/{hash}/reject",
    summary: "Reject a proposal",
    security: auth,
    request: { params: z.object({ hash: z.string() }) },
    responses: {
      "200": { description: "Rejection result" },
      "401": { description: "Unauthorized" },
      "404": { description: "Proposal not found" },
    },
  });

  // Governance — verify
  registry.registerPath({
    method: "get",
    path: "/api/v1/verify",
    summary: "Verify the graph integrity",
    security: auth,
    responses: {
      "200": {
        description: "Integrity report",
        content: { "application/json": { schema: VerifyReport } },
      },
      "401": { description: "Unauthorized" },
    },
  });

  // Governance — reindex
  registry.registerPath({
    method: "post",
    path: "/api/v1/reindex",
    summary: "Rebuild the search index",
    security: auth,
    responses: {
      "200": { description: "Reindex complete" },
      "401": { description: "Unauthorized" },
    },
  });

  // Governance — principals
  registry.registerPath({
    method: "get",
    path: "/api/v1/principals",
    summary: "List principals",
    security: auth,
    responses: {
      "200": { description: "Principals list" },
      "401": { description: "Unauthorized" },
    },
  });

  // Governance — add principal
  registry.registerPath({
    method: "post",
    path: "/api/v1/principals",
    summary: "Add a principal",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: AddPrincipalBody } } },
    },
    responses: {
      "200": { description: "Principal added" },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Governance — register agent
  registry.registerPath({
    method: "post",
    path: "/api/v1/agents",
    summary: "Register a new agent",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: RegisterAgentBody } } },
    },
    responses: {
      "200": { description: "Agent registration result" },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Schema — describe
  registry.registerPath({
    method: "get",
    path: "/api/v1/schema",
    summary: "Describe the schema",
    security: auth,
    responses: {
      "200": {
        description: "Schema description",
        content: { "application/json": { schema: SchemaDescription } },
      },
      "401": { description: "Unauthorized" },
    },
  });

  // Schema — propose ontology
  registry.registerPath({
    method: "post",
    path: "/api/v1/schema/proposals",
    summary: "Propose an ontology change",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: ProposeOntologyBody } } },
    },
    responses: {
      "200": { description: "Proposal result" },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Schema — install ontology
  registry.registerPath({
    method: "post",
    path: "/api/v1/schema/install",
    summary: "Install an ontology (owner)",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: InstallOntologyBody } } },
    },
    responses: {
      "200": { description: "Install result" },
      "400": { description: "Validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Policy — get
  registry.registerPath({
    method: "get",
    path: "/api/v1/policy",
    summary: "Get policy rules",
    security: auth,
    responses: {
      "200": { description: "Policy rules list" },
      "401": { description: "Unauthorized" },
    },
  });

  // Policy — propose
  registry.registerPath({
    method: "post",
    path: "/api/v1/policy",
    summary: "Propose a policy change",
    security: auth,
    request: { body: { required: true, content: { "application/json": { schema: PolicyBody } } } },
    responses: {
      "200": { description: "Policy proposal result" },
      "400": { description: "Invalid JSON body" },
      "401": { description: "Unauthorized" },
    },
  });

  // Log
  registry.registerPath({
    method: "get",
    path: "/api/v1/log",
    summary: "Get the changeset log",
    security: auth,
    responses: {
      "200": { description: "Changeset log entries" },
      "401": { description: "Unauthorized" },
    },
  });

  // Session — daemon config visible to authenticated console
  registry.registerPath({
    method: "get",
    path: "/api/v1/session",
    summary: "Get session config",
    description:
      "Returns non-secret Freehold configuration (defaultAgent, embedder, port). The bearer token is NOT returned here — it is injected as a meta tag by the server.",
    security: auth,
    responses: {
      "200": {
        description: "Session config",
        content: { "application/json": { schema: SessionInfo } },
      },
      "401": { description: "Unauthorized" },
    },
  });

  // Graphs — list
  registry.registerPath({
    method: "get",
    path: "/api/v1/graphs",
    summary: "List registered graphs",
    security: auth,
    responses: {
      "200": {
        description: "All registered graphs",
        content: { "application/json": { schema: z.object({ graphs: z.array(GraphInfo) }) } },
      },
      "401": { description: "Unauthorized" },
    },
  });

  // Graphs — register
  registry.registerPath({
    method: "post",
    path: "/api/v1/graphs",
    summary: "Register a repo graph",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: RegisterGraphBody } } },
    },
    responses: {
      "201": {
        description: "Registered graph entry",
        content: { "application/json": { schema: GraphInfo } },
      },
      "400": { description: "Validation error or invalid repo path" },
      "401": { description: "Unauthorized" },
    },
  });

  // Graphs — update
  registry.registerPath({
    method: "patch",
    path: "/api/v1/graphs/{id}",
    summary: "Update graph settings",
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { required: true, content: { "application/json": { schema: UpdateGraphBody } } },
    },
    responses: {
      "200": {
        description: "Updated graph entry",
        content: { "application/json": { schema: GraphInfo } },
      },
      "401": { description: "Unauthorized" },
      "404": { description: "Graph not found" },
    },
  });

  // Graphs — remove
  registry.registerPath({
    method: "delete",
    path: "/api/v1/graphs/{id}",
    summary: "Remove a registered graph",
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      "204": { description: "Graph removed" },
      "401": { description: "Unauthorized" },
      "404": { description: "Graph not found" },
      "409": { description: "Cannot remove the default graph" },
    },
  });

  // Repos — onboard
  registry.registerPath({
    method: "post",
    path: "/api/v1/repos/onboard",
    summary: "Onboard a repository",
    description:
      "Server-side repo onboarding: runs allod init if needed, generates a signing key, registers the graph, and optionally indexes. Returns a step list with per-step status.",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: OnboardRepoBody } } },
    },
    responses: {
      "201": {
        description: "Onboarding complete — graph registered",
        content: { "application/json": { schema: OnboardRepoResult } },
      },
      "400": { description: "Onboarding failed — step list included in body" },
      "401": { description: "Unauthorized" },
    },
  });

  // Code view — tree
  registry.registerPath({
    method: "get",
    path: "/api/v1/code/tree",
    summary: "Code file tree",
    description:
      "Nested directory tree of all indexed SourceFile nodes. Only available for repo graphs.",
    security: auth,
    responses: {
      "200": {
        description: "Nested file tree",
        content: {
          "application/json": {
            schema: z.object({ tree: z.array(z.unknown()) }),
          },
        },
      },
      "400": { description: "Not a repo graph" },
      "401": { description: "Unauthorized" },
    },
  });

  // Code view — file
  registry.registerPath({
    method: "get",
    path: "/api/v1/code/file",
    summary: "Code file view",
    description: "View a single SourceFile with its declared items. 404 if path is not indexed.",
    security: auth,
    request: {
      query: z.object({
        path: z.string().openapi({ description: "Repo-relative file path" }),
      }),
    },
    responses: {
      "200": {
        description: "File view with declared items",
        content: { "application/json": { schema: CodeFileView } },
      },
      "400": { description: "Not a repo graph, or missing path param" },
      "401": { description: "Unauthorized" },
      "404": { description: "Path not indexed" },
    },
  });

  // Code view — item
  registry.registerPath({
    method: "get",
    path: "/api/v1/code/item/{nodeId}",
    summary: "Code item view",
    description: "Single code item (function, class, etc.) with callers and callees.",
    security: auth,
    request: { params: z.object({ nodeId: z.string() }) },
    responses: {
      "200": {
        description: "Item view",
        content: { "application/json": { schema: CodeItemView } },
      },
      "400": { description: "Not a repo graph" },
      "401": { description: "Unauthorized" },
      "404": { description: "Node not found" },
    },
  });

  // Code view — regions
  registry.registerPath({
    method: "get",
    path: "/api/v1/code/regions",
    summary: "Policy region membership",
    description: "Maps policy rules to the file paths they match via git_checklist.",
    security: auth,
    responses: {
      "200": {
        description: "Region rules",
        content: {
          "application/json": {
            schema: z.object({ rules: z.array(RegionRule) }),
          },
        },
      },
      "400": { description: "Not a repo graph" },
      "401": { description: "Unauthorized" },
    },
  });

  // Code view — neighborhood
  registry.registerPath({
    method: "get",
    path: "/api/v1/code/neighborhood",
    summary: "Code neighborhood graph",
    description: "Nodes and edges one hop from the given file path.",
    security: auth,
    request: {
      query: z.object({
        path: z.string().openapi({ description: "Repo-relative file path" }),
      }),
    },
    responses: {
      "200": {
        description: "Neighborhood graph",
        content: {
          "application/json": {
            schema: CodeNeighborhood,
          },
        },
      },
      "400": { description: "Not a repo graph or missing path param" },
      "401": { description: "Unauthorized" },
    },
  });

  // Code view — source
  registry.registerPath({
    method: "get",
    path: "/api/v1/code/source",
    summary: "Working-tree file source",
    description:
      'Read raw file content from the checkout working tree. Binary files return content:"". Files over 512 KB are truncated.',
    security: auth,
    request: {
      query: z.object({
        path: z.string().openapi({ description: "Repo-relative file path" }),
      }),
    },
    responses: {
      "200": {
        description: "File source content",
        content: { "application/json": { schema: CodeSource } },
      },
      "400": { description: "Not a repo graph, missing path param, or path traversal attempt" },
      "401": { description: "Unauthorized" },
      "404": { description: "File not found on disk" },
    },
  });

  // Code comments — list
  registry.registerPath({
    method: "get",
    path: "/api/v1/code/comments",
    summary: "List code comments for a file",
    description:
      "List all standalone line-anchored code comments (review/ReviewComment@1) for the given file path. Returns both saved (admitted) and pending comments across all anchor shas.",
    security: auth,
    request: {
      query: z.object({
        path: z.string().openapi({ description: "Repo-relative file path" }),
      }),
    },
    responses: {
      "200": {
        description: "Code comments for the file",
        content: {
          "application/json": { schema: z.object({ comments: z.array(CodeComment) }) },
        },
      },
      "400": { description: "Not a repo graph or missing path parameter" },
      "401": { description: "Unauthorized" },
    },
  });

  // Code comments — post
  registry.registerPath({
    method: "post",
    path: "/api/v1/code/comments",
    summary: "Post a code comment on a file line",
    description:
      "Creates a standalone review/ReviewComment@1 anchored to the current HEAD sha of the repo. No Review node or part_of edge.",
    security: auth,
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: PostCodeCommentBody } },
      },
    },
    responses: {
      "200": {
        description: "Created code comment",
        content: { "application/json": { schema: PostCodeCommentResult } },
      },
      "400": { description: "Not a repo graph or validation error" },
      "401": { description: "Unauthorized" },
      "409": { description: "Signing key not found for the specified principal" },
    },
  });

  // OpenAPI spec itself
  registry.registerPath({
    method: "get",
    path: "/api/v1/openapi.json",
    summary: "OpenAPI specification",
    responses: {
      "200": { description: "This document" },
    },
  });

  // ---- Git proposal schemas ----

  const GitProposalPath = z
    .object({
      verb: z.string(),
      path: z.string(),
      regions: z.array(z.string()),
      indexed: z.boolean(),
    })
    .openapi("GitProposalPath");

  const GitProposalCheck = z
    .object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
    })
    .openapi("GitProposalCheck");

  const GitProposal = z
    .object({
      sha: z.string(),
      ref: z.string(),
      author: z.string(),
      timestamp: z.string(),
      message: z.string(),
      target: z.string(),
      matched: z.array(z.string()),
      checklist: z.array(z.unknown()),
      unmet: z.array(z.string()),
      decided: z.enum(["undecided", "approved", "rejected"]),
      paths: z.array(GitProposalPath),
      checks: z.array(GitProposalCheck).optional(),
    })
    .openapi("GitProposal");

  const DecideBody = z
    .object({
      verdict: z.enum(["approve", "reject"]),
      by: z.string().openapi({ description: "Principal name performing the decision" }),
    })
    .openapi("DecideBody");

  const DecideResult = z
    .union([
      z.object({
        outcome: z.enum(["approved", "rejected"]),
        pushed: z.boolean(),
        pushSkipped: z.boolean().optional().openapi({
          description:
            "True when push was not attempted because auto-push is off or no remote is configured.",
        }),
        pushError: z.string().optional(),
        statusPosted: z
          .boolean()
          .optional()
          .openapi({ description: "True when a GitHub commit status was successfully posted." }),
        statusError: z
          .string()
          .optional()
          .openapi({ description: "Present when statusPosted is false due to an error." }),
      }),
      z.object({
        outcome: z.literal("incomplete"),
        unmet: z.array(z.string()),
      }),
    ])
    .openapi("DecideResult");

  const ReviewCommentInput = z
    .object({
      body: z.string(),
      anchor: z.string().optional(),
      span: z.string().optional(),
    })
    .openapi("ReviewCommentInput");

  const PostReviewBody = z
    .object({
      verdict: z.enum(["approve", "approve-with-comments", "request-changes"]),
      body: z.string().optional(),
      by: z.string().openapi({ description: "Author principal" }),
      comments: z.array(ReviewCommentInput).optional(),
      decide: z.boolean().optional().openapi({
        description:
          "When true (default), automatically call decide after committing the review. Verdict mapping: approve/approve-with-comments → approve; request-changes → reject.",
      }),
    })
    .openapi("PostReviewBody");

  const PostReviewResult = z
    .object({
      reviewId: z.string(),
      commentIds: z.array(z.string()),
      status: z.enum(["saved", "pending"]),
      alreadyDecided: z.boolean().optional().openapi({
        description: "True when decide=true was requested but a decision already existed.",
      }),
      decideResult: z
        .union([
          z.object({
            outcome: z.enum(["approved", "rejected"]),
            pushed: z.boolean(),
            pushSkipped: z.boolean().optional(),
            pushError: z.string().optional(),
            statusPosted: z.boolean().optional(),
            statusError: z.string().optional(),
          }),
          z.object({ outcome: z.literal("incomplete"), unmet: z.array(z.string()) }),
        ])
        .optional()
        .openapi({ description: "Present when decide=true and the auto-decide ran." }),
    })
    .openapi("PostReviewResult");

  const ReviewComment = z
    .object({
      commentId: z.string(),
      body: z.string().optional(),
      anchor: z.string().optional(),
      span: z.string().optional(),
      status: z.string(),
      external_source: z.string().optional(),
      claimed_author: z.string().optional(),
    })
    .openapi("ReviewComment");

  const ReviewEntry = z
    .object({
      reviewId: z.string(),
      verdict: z.string(),
      body: z.string().optional(),
      commit: z.string(),
      author: z.string(),
      status: z.enum(["saved", "pending"]),
      comments: z.array(ReviewComment),
    })
    .openapi("ReviewEntry");

  const DiffFile = z
    .object({
      path: z.string(),
      oldPath: z.string().optional(),
      verb: z.enum(["A", "M", "D", "R"]),
      binary: z.boolean(),
      oldContent: z.string(),
      newContent: z.string(),
      truncated: z.boolean(),
    })
    .openapi("DiffFile");

  const DiffResponse = z
    .object({
      files: z.array(DiffFile),
      truncated: z.boolean(),
    })
    .openapi("DiffResponse");

  registry.register("GitProposalPath", GitProposalPath);
  registry.register("GitProposalCheck", GitProposalCheck);
  registry.register("GitProposal", GitProposal);
  registry.register("DecideBody", DecideBody);
  registry.register("DecideResult", DecideResult);
  registry.register("ReviewCommentInput", ReviewCommentInput);
  registry.register("PostReviewBody", PostReviewBody);
  registry.register("PostReviewResult", PostReviewResult);
  registry.register("ReviewComment", ReviewComment);
  registry.register("ReviewEntry", ReviewEntry);
  registry.register("DiffFile", DiffFile);
  registry.register("DiffResponse", DiffResponse);

  // Git proposals — list
  registry.registerPath({
    method: "get",
    path: "/api/v1/git/proposals",
    summary: "List git proposals",
    description:
      "Lists all branch-head commits as proposals with checklist and decided state. Only available for repo graphs.",
    security: auth,
    responses: {
      "200": {
        description: "Git proposals",
        content: {
          "application/json": {
            schema: z.object({ proposals: z.array(GitProposal) }),
          },
        },
      },
      "400": { description: "Not a repo graph" },
      "401": { description: "Unauthorized" },
    },
  });

  // Git proposals — detail
  registry.registerPath({
    method: "get",
    path: "/api/v1/git/proposals/{sha}",
    summary: "Get a git proposal by sha",
    security: auth,
    request: { params: z.object({ sha: z.string() }) },
    responses: {
      "200": {
        description: "Git proposal",
        content: { "application/json": { schema: GitProposal } },
      },
      "400": { description: "Not a repo graph" },
      "401": { description: "Unauthorized" },
      "404": { description: "Proposal not found" },
    },
  });

  // Git proposals — decide
  registry.registerPath({
    method: "post",
    path: "/api/v1/git/proposals/{sha}/decide",
    summary: "Decide a git proposal",
    description:
      "Signs a decision record (approve/reject) via the key backend and appends it to refs/notes/allod-decisions.",
    security: auth,
    request: {
      params: z.object({ sha: z.string() }),
      body: { required: true, content: { "application/json": { schema: DecideBody } } },
    },
    responses: {
      "200": {
        description: "Decision result",
        content: { "application/json": { schema: DecideResult } },
      },
      "400": { description: "Not a repo graph or validation error" },
      "401": { description: "Unauthorized" },
      "404": { description: "Proposal not found" },
      "409": { description: "No signing key for the given principal (code: key-missing)" },
    },
  });

  // Git proposals — post review
  registry.registerPath({
    method: "post",
    path: "/api/v1/git/proposals/{sha}/reviews",
    summary: "Post a code review for a git proposal",
    description:
      "Creates a review/Review@1 node and optional review/ReviewComment@1 nodes with part_of edges.",
    security: auth,
    request: {
      params: z.object({ sha: z.string() }),
      body: { required: true, content: { "application/json": { schema: PostReviewBody } } },
    },
    responses: {
      "200": {
        description: "Created review artifacts",
        content: { "application/json": { schema: PostReviewResult } },
      },
      "400": { description: "Not a repo graph or validation error" },
      "401": { description: "Unauthorized" },
    },
  });

  // Git proposals — diff
  registry.registerPath({
    method: "get",
    path: "/api/v1/git/proposals/{sha}/diff",
    summary: "Get per-file full contents for a git proposal",
    description:
      "Returns per-file old and new content for each file changed in the commit. Binary files have empty content strings. Files over 512 KB are individually truncated. Only available for repo graphs.",
    security: auth,
    request: { params: z.object({ sha: z.string() }) },
    responses: {
      "200": {
        description: "Diff with full file contents",
        content: { "application/json": { schema: DiffResponse } },
      },
      "400": { description: "Not a repo graph or invalid sha" },
      "401": { description: "Unauthorized" },
      "404": { description: "Proposal not found" },
    },
  });

  // Git proposals — push notes
  registry.registerPath({
    method: "post",
    path: "/api/v1/git/proposals/{sha}/push-notes",
    summary: "Push decision notes to remote",
    description:
      "Pushes refs/notes/allod-decisions to the graph's origin remote. Returns {pushed:true} on success or {pushed:false, pushError} on failure.",
    security: auth,
    request: { params: z.object({ sha: z.string() }) },
    responses: {
      "200": {
        description: "Push result",
        content: {
          "application/json": {
            schema: z.object({
              pushed: z.boolean(),
              pushError: z.string().optional(),
            }),
          },
        },
      },
      "400": { description: "Not a repo graph or no remote configured" },
      "401": { description: "Unauthorized" },
    },
  });

  // Git proposals — get reviews
  registry.registerPath({
    method: "get",
    path: "/api/v1/git/proposals/{sha}/reviews",
    summary: "List reviews for a git proposal",
    security: auth,
    request: { params: z.object({ sha: z.string() }) },
    responses: {
      "200": {
        description: "Reviews and their comments",
        content: {
          "application/json": {
            schema: z.object({ reviews: z.array(ReviewEntry) }),
          },
        },
      },
      "400": { description: "Not a repo graph" },
      "401": { description: "Unauthorized" },
    },
  });

  // Git proposals — apply suggestion as commit
  const ApplySuggestionBody = z
    .object({
      branch: z.string().openapi({ description: "Branch name (without refs/heads/ prefix)" }),
      path: z.string().openapi({ description: "Repo-relative file path" }),
      span: z.string().openapi({ description: 'Additions-side span, e.g. "L5" or "L5-L9"' }),
      suggestion: z.string().openapi({ description: "Replacement text for the spanned lines" }),
      by: z.string().openapi({ description: "Principal name for commit attribution" }),
    })
    .openapi("ApplySuggestionBody");

  const ApplySuggestionResult = z
    .object({
      newSha: z.string().openapi({ description: "SHA of the new commit" }),
    })
    .openapi("ApplySuggestionResult");

  registry.register("ApplySuggestionBody", ApplySuggestionBody);
  registry.register("ApplySuggestionResult", ApplySuggestionResult);

  registry.registerPath({
    method: "post",
    path: "/api/v1/git/proposals/{sha}/suggestions/apply",
    summary: "Apply a review suggestion as a git commit",
    description:
      "Reads the blob at the branch tip, splices the span lines with the suggestion text, and commits the result via git plumbing (no working-tree mutation). The :sha must equal the current branch tip; concurrent pushes return 409. Binary files and old-side spans return 422.",
    security: auth,
    request: {
      params: z.object({ sha: z.string() }),
      body: {
        required: true,
        content: { "application/json": { schema: ApplySuggestionBody } },
      },
    },
    responses: {
      "200": {
        description: "New commit SHA",
        content: { "application/json": { schema: ApplySuggestionResult } },
      },
      "400": { description: "Not a repo graph or validation error" },
      "401": { description: "Unauthorized" },
      "404": { description: "Proposal not found" },
      "409": {
        description: "Branch tip moved since the suggestion was authored (code: branch-moved)",
      },
      "422": {
        description:
          "Binary file, old-side span, or invalid span format (codes: binary-file, old-side-span, invalid-span)",
      },
    },
  });

  // Code comments schemas
  const CodeComment = z
    .object({
      commentId: z.string(),
      body: z.string(),
      span: z.string(),
      status: z.literal("open"),
      author: z.string(),
      anchorSha: z.string(),
      currentHead: z.boolean(),
    })
    .openapi("CodeComment");

  const PostCodeCommentBody = z
    .object({
      path: z.string(),
      span: z.string(),
      body: z.string(),
      by: z.string(),
    })
    .openapi("PostCodeCommentBody");

  const PostCodeCommentResult = z
    .object({
      commentId: z.string(),
      status: z.enum(["saved", "pending"]),
      anchorSha: z.string(),
    })
    .openapi("PostCodeCommentResult");

  registry.register("CodeComment", CodeComment);
  registry.register("PostCodeCommentBody", PostCodeCommentBody);
  registry.register("PostCodeCommentResult", PostCodeCommentResult);

  // Code comments — list
  registry.registerPath({
    method: "get",
    path: "/api/v1/code/comments",
    summary: "List code comments for a file",
    security: auth,
    request: {
      query: z.object({ path: z.string().openapi({ description: "Repo-relative file path" }) }),
    },
    responses: {
      "200": {
        description: "Code comments for the file",
        content: {
          "application/json": {
            schema: z.object({ comments: z.array(CodeComment) }),
          },
        },
      },
      "400": { description: "Not a repo graph or missing path param" },
      "401": { description: "Unauthorized" },
    },
  });

  // Code comments — post
  registry.registerPath({
    method: "post",
    path: "/api/v1/code/comments",
    summary: "Post a standalone line-anchored code comment",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: PostCodeCommentBody } } },
    },
    responses: {
      "200": {
        description: "Created comment",
        content: { "application/json": { schema: PostCodeCommentResult } },
      },
      "400": { description: "Not a repo graph or validation error" },
      "401": { description: "Unauthorized" },
      "409": { description: "No signing key (code: key-missing)" },
    },
  });

  // Connector — GET
  registry.registerPath({
    method: "get",
    path: "/api/v1/connector",
    summary: "Get connector status and config",
    security: auth,
    responses: {
      "200": {
        description: "Connector status",
        content: { "application/json": { schema: ConnectorResponse } },
      },
      "400": { description: "Not a repo graph" },
      "401": { description: "Unauthorized" },
    },
  });

  // Connector — PUT (credential mode)
  registry.registerPath({
    method: "put",
    path: "/api/v1/connector",
    summary: "Configure the connector in credential mode",
    security: auth,
    request: {
      body: { required: true, content: { "application/json": { schema: PutConnectorBody } } },
    },
    responses: {
      "200": {
        description: "Connector configured",
        content: { "application/json": { schema: z.object({ config: ConnectorConfigView }) } },
      },
      "400": { description: "Not a repo graph or invalid body" },
      "401": { description: "Unauthorized" },
      "409": { description: "No credential found or missing origin remote" },
    },
  });

  // Connector — POST /connector/poll
  registry.registerPath({
    method: "post",
    path: "/api/v1/connector/poll",
    summary: "Run a connector poll immediately",
    security: auth,
    responses: {
      "200": {
        description: "Poll result",
        content: { "application/json": { schema: PollResult } },
      },
      "400": { description: "Not a repo graph" },
      "401": { description: "Unauthorized" },
      "409": { description: "Connector not configured" },
    },
  });

  // Connector — DELETE
  registry.registerPath({
    method: "delete",
    path: "/api/v1/connector",
    summary: "Remove connector config",
    security: auth,
    responses: {
      "200": {
        description: "Connector config removed",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
      "400": { description: "Not a repo graph" },
      "401": { description: "Unauthorized" },
    },
  });

  return registry;
}

export function getOpenApiDoc(): object {
  const registry = buildRegistry();
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Freehold API",
      version: "0.1.0",
      description: "Governed memory backend for AI agents, built on the Allod format.",
    },
    servers: [{ url: "http://127.0.0.1:8710", description: "Local Freehold" }],
  });
}

export function writeOpenApi(outPath: string): void {
  const doc = getOpenApiDoc();
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  console.log(`OpenAPI spec written to ${outPath}`);
}
