import { writeFileSync } from "node:fs";

const ROUTES: Array<[string, string, string, boolean]> = [
  ["get", "/health", "Health check", false],
  ["get", "/api/v1/openapi.json", "OpenAPI specification", false],
  ["post", "/api/v1/remember", "Write a scratch note", true],
  ["post", "/api/v1/entities", "Create an entity", true],
  ["patch", "/api/v1/entities/{id}", "Update an entity", true],
  ["post", "/api/v1/relations", "Create a relation (edge)", true],
  ["post", "/api/v1/classifications", "Add a classification", true],
  ["post", "/api/v1/documents", "Attach a document", true],
  ["get", "/api/v1/recall", "Hybrid semantic recall", true],
  ["get", "/api/v1/entities/{id}", "Get an entity by ID", true],
  ["get", "/api/v1/entities/{id}/traverse", "Traverse from an entity", true],
  ["get", "/api/v1/proposals", "List pending proposals", true],
  ["post", "/api/v1/proposals/{hash}/approve", "Approve a proposal", true],
  ["post", "/api/v1/proposals/{hash}/reject", "Reject a proposal", true],
  ["get", "/api/v1/verify", "Verify the graph integrity", true],
  ["post", "/api/v1/reindex", "Rebuild the search index", true],
  ["get", "/api/v1/principals", "List principals", true],
  ["post", "/api/v1/agents", "Register a new agent", true],
  ["get", "/api/v1/schema", "Describe the schema", true],
  ["post", "/api/v1/schema/proposals", "Propose an ontology change", true],
  ["post", "/api/v1/schema/install", "Install an ontology (owner)", true],
  ["get", "/api/v1/policy", "Get policy rules", true],
  ["post", "/api/v1/policy", "Propose a policy change", true],
  ["get", "/api/v1/log", "Get the changeset log", true],
];

const bearerScheme = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  },
};

export function getOpenApiDoc(): object {
  const paths: Record<string, Record<string, object>> = {};

  for (const [method, path, summary, requiresAuth] of ROUTES) {
    if (!paths[path]) paths[path] = {};
    const operation: Record<string, unknown> = {
      summary,
      responses: {
        "200": { description: "Success" },
        "400": { description: "Validation error" },
        "401": { description: "Unauthorized" },
        "404": { description: "Not found" },
        "409": { description: "Policy rejected" },
      },
    };
    if (requiresAuth) {
      operation.security = [{ bearerAuth: [] }];
    }
    paths[path][method] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Freehold API",
      version: "0.1.0",
      description: "Governed memory backend for AI agents, built on the Allod format.",
    },
    servers: [{ url: "http://127.0.0.1:8710", description: "Local daemon" }],
    components: {
      securitySchemes: bearerScheme,
    },
    paths,
  };
}

export function writeOpenApi(outPath: string): void {
  const doc = getOpenApiDoc();
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  console.log(`OpenAPI spec written to ${outPath}`);
}
