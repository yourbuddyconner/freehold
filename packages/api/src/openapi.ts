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

const SessionInfo = z
  .object({
    defaultAgent: z.string().nullable().openapi({ description: "Default MCP agent name, if set" }),
    embedder: z.enum(["transformers", "hash"]).openapi({ description: "Active embedder backend" }),
    port: z.number().openapi({ description: "Freehold's local port" }),
    owner: z
      .string()
      .openapi({ description: "The graph's owner principal; console edits sign as this name" }),
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
  })
  .openapi("GraphInfo");

const RegisterGraphBody = z
  .object({
    path: z.string().openapi({ description: "Absolute path to the repo checkout" }),
    id: z.string().optional().openapi({ description: "Registry slug id; defaults to basename of path" }),
    name: z.string().optional().openapi({ description: "Display name; defaults to id" }),
  })
  .openapi("RegisterGraphBody");

const UpdateGraphBody = z
  .object({
    name: z.string().optional(),
    autoPushNotes: z.boolean().optional(),
    embedder: z.enum(["hash", "semantic"]).optional(),
  })
  .openapi("UpdateGraphBody");

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
  registry.register("ProposeOntologyBody", ProposeOntologyBody);
  registry.register("InstallOntologyBody", InstallOntologyBody);
  registry.register("PolicyBody", PolicyBody);
  registry.register("AdmissionResponse", AdmissionResponse);
  registry.register("RememberResponse", RememberResponse);
  registry.register("ProposalView", ProposalView);
  registry.register("RecallResult", RecallResult);
  registry.register("VerifyReport", VerifyReport);
  registry.register("SchemaDescription", SchemaDescription);
  registry.register("SessionInfo", SessionInfo);
  registry.register("GraphInfo", GraphInfo);
  registry.register("RegisterGraphBody", RegisterGraphBody);
  registry.register("UpdateGraphBody", UpdateGraphBody);

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

  // OpenAPI spec itself
  registry.registerPath({
    method: "get",
    path: "/api/v1/openapi.json",
    summary: "OpenAPI specification",
    responses: {
      "200": { description: "This document" },
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
