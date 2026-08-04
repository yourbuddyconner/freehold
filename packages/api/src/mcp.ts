/**
 * Freehold MCP server — streamable HTTP transport.
 *
 * Exposes the twelve tool surface defined in the product spec.  Agents may
 * read and write knowledge, but they cannot approve/reject proposals, mutate
 * policy, or install ontologies directly.
 *
 * Stateless mode: a new McpServer + WebStandardStreamableHTTPServerTransport
 * is created per HTTP request.  This avoids the SDK's "already connected"
 * constraint and keeps the server simple — no session management needed.
 * Tool registrations happen once via a shared factory; the cost per request
 * is just the server/transport construction.
 */

import {
  attachDocument,
  classifyEntity,
  createEntity,
  describeSchema,
  getEntity,
  pending,
  proposeOntologyChange,
  recall,
  relate,
  remember,
  syncIndex,
  traverse,
  updateEntity,
} from "@freehold/core";
import type { Embedder, Freehold, FreeholdConfig } from "@freehold/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// ---- Agent principal resolution ----

/**
 * Resolve the agent name to use for a tool call.
 * Falls back to the config default agent, then to "agent".
 */
function resolveAgent(arg: string | undefined, config: FreeholdConfig): string {
  return arg ?? config.defaultAgent ?? "agent";
}

// ---- Tool registration helper ----

/**
 * Register all twelve tools on the given McpServer instance.
 * Called once per request (stateless transport model).
 */
function registerTools(
  server: McpServer,
  fh: Freehold,
  embedder: Embedder,
  config: FreeholdConfig
): void {
  // ------------------------------------------------------------------ //
  // Knowledge tools                                                       //
  // ------------------------------------------------------------------ //

  server.registerTool(
    "remember",
    {
      description:
        "Store a scratch note in the graph. Ergonomic fast path — admitted immediately under the memory policy.",
      inputSchema: {
        content: z.string().describe("The text content of the note to remember"),
        agent: z
          .string()
          .optional()
          .describe("Agent principal name (default: config defaultAgent)"),
      },
    },
    async ({ content, agent }) => {
      const by = resolveAgent(agent, config);
      const result = await remember(fh.graph, by, content);
      if (result.status === "admitted") {
        await syncIndex(fh, embedder);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.status,
              noteId: result.noteId,
              changeset: result.changeset,
              provenance: { author: by, tool: "freehold@0.1" },
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "create_entity",
    {
      description:
        "Create a typed entity node with optional classification and edge in one atomic changeset.",
      inputSchema: {
        type: z.string().describe("Entity type ref, e.g. memory/Preference@1"),
        attributes: z.record(z.unknown()).describe("Key/value attributes for the entity"),
        classify: z.string().optional().describe("Classification term, e.g. workspace/scratch@1"),
        relate: z
          .object({
            to: z.string().describe("Target node ID (bare UUID)"),
            edge_type: z.string().describe("Edge type ref"),
            attributes: z.record(z.unknown()).optional(),
          })
          .optional()
          .describe("Optional edge to create alongside the entity"),
        agent: z.string().optional().describe("Agent principal name"),
      },
    },
    async ({ type, attributes, classify, relate: rel, agent }) => {
      const by = resolveAgent(agent, config);
      const result = await createEntity(fh.graph, by, type, attributes as Record<string, unknown>, {
        classification: classify,
      });
      let edgeWarning: string | undefined;
      if (result.status === "admitted") {
        await syncIndex(fh, embedder);
        if (rel) {
          try {
            await relate(
              fh.graph,
              by,
              result.nodeId,
              rel.to,
              rel.edge_type,
              rel.attributes as Record<string, unknown> | undefined
            );
          } catch (e) {
            edgeWarning = `entity created; edge failed: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.status,
              nodeId: result.nodeId,
              changeset: result.changeset,
              provenance: { author: by, tool: "freehold@0.1" },
              ...(edgeWarning !== undefined ? { warning: edgeWarning } : {}),
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "update_entity",
    {
      description: "Revise an existing entity's attributes with optimistic concurrency.",
      inputSchema: {
        id: z.string().describe("Bare UUID of the node to update"),
        type: z.string().describe("Entity type ref (required for fold validation)"),
        attributes: z.record(z.unknown()).describe("Attributes to update"),
        prior: z
          .string()
          .optional()
          .describe("Revision hash for optimistic concurrency (fetched automatically if omitted)"),
        agent: z.string().optional().describe("Agent principal name"),
      },
    },
    async ({ id, type, attributes, prior, agent }) => {
      const by = resolveAgent(agent, config);
      const result = await updateEntity(
        fh.graph,
        by,
        id,
        type,
        attributes as Record<string, unknown>,
        prior
      );
      if (result.status === "admitted") {
        await syncIndex(fh, embedder);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.status,
              changeset: result.changeset,
              provenance: { author: by, tool: "freehold@0.1" },
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "relate",
    {
      description: "Create a typed directed edge between two entities.",
      inputSchema: {
        from: z.string().describe("Source node bare UUID"),
        to: z.string().describe("Target node bare UUID"),
        edge_type: z.string().describe("Edge type ref, e.g. memory/relates_to@1"),
        attributes: z.record(z.unknown()).optional().describe("Optional edge attributes"),
        agent: z.string().optional().describe("Agent principal name"),
      },
    },
    async ({ from, to, edge_type, attributes, agent }) => {
      const by = resolveAgent(agent, config);
      const result = await relate(
        fh.graph,
        by,
        from,
        to,
        edge_type,
        attributes as Record<string, unknown> | undefined
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.status,
              edgeId: result.edgeId,
              changeset: result.changeset,
              provenance: { author: by, tool: "freehold@0.1" },
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "classify",
    {
      description:
        "Place a node, edge, or document in the taxonomy. Classification routes policy — this can be held.",
      inputSchema: {
        subject: z.string().describe("Node bare UUID to classify"),
        term: z.string().describe("Classification term, e.g. workspace/personal@1"),
        agent: z.string().optional().describe("Agent principal name"),
      },
    },
    async ({ subject, term, agent }) => {
      const by = resolveAgent(agent, config);
      const result = await classifyEntity(fh.graph, by, subject, term);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.status,
              changeset: result.changeset,
              provenance: { author: by, tool: "freehold@0.1" },
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "attach_document",
    {
      description: "Anchor source material by content, linking it to an entity.",
      inputSchema: {
        entity_id: z.string().describe("Entity bare UUID to attach the document to"),
        content: z.string().describe("Document text content"),
        media_type: z.string().optional().describe("Media type hint, e.g. text/plain"),
        title: z.string().optional().describe("Optional document title"),
        agent: z.string().optional().describe("Agent principal name"),
      },
    },
    async ({ entity_id, content, media_type, title, agent }) => {
      const by = resolveAgent(agent, config);
      const result = await attachDocument(fh.graph, by, entity_id, content, title, media_type);
      if (result.status === "admitted") {
        await syncIndex(fh, embedder);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.status,
              docNodeId: result.docNodeId,
              changeset: result.changeset,
              provenance: { author: by, tool: "freehold@0.1" },
            }),
          },
        ],
      };
    }
  );

  // ------------------------------------------------------------------ //
  // Retrieval tools                                                       //
  // ------------------------------------------------------------------ //

  server.registerTool(
    "recall",
    {
      description: "Hybrid semantic + full-text search. Every result carries provenance.",
      inputSchema: {
        query: z.string().describe("Natural-language search query"),
        filters: z
          .object({
            type: z.string().optional().describe("Filter by entity type ref"),
            author: z.string().optional().describe("Filter by author principal name"),
            approval: z.string().optional().describe("Filter by approval status (admitted/held)"),
          })
          .optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
      },
    },
    async ({ query, filters, limit }) => {
      const results = await recall(fh, query, embedder, filters, limit ?? 10);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
      };
    }
  );

  server.registerTool(
    "get_entity",
    {
      description:
        "Fetch one entity in full: attributes, classifications, edges, provenance chain, revision history.",
      inputSchema: {
        id: z.string().describe("Bare UUID of the entity"),
      },
    },
    async ({ id }) => {
      const entity = getEntity(fh.graph, id);
      if (!entity) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: { code: "not_found", message: `Entity '${id}' not found` },
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(entity) }],
      };
    }
  );

  server.registerTool(
    "traverse",
    {
      description: "Walk the typed graph from a starting node, following edges of specified types.",
      inputSchema: {
        from: z.string().describe("Starting node bare UUID"),
        edge_types: z
          .array(z.string())
          .optional()
          .describe("Edge type refs to follow (all types if omitted)"),
        direction: z
          .enum(["out", "in", "both"])
          .optional()
          .describe("Traversal direction (default: out)"),
        depth: z.number().int().min(1).max(10).optional().describe("Maximum hops (default: 1)"),
      },
    },
    async ({ from, edge_types, direction, depth }) => {
      const results = traverse(
        fh.graph,
        from,
        edge_types,
        (direction ?? "out") as "out" | "in" | "both",
        depth ?? 1
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
      };
    }
  );

  server.registerTool(
    "pending_approvals",
    {
      description: "List the agent's own held proposals awaiting owner approval.",
      inputSchema: {
        agent: z
          .string()
          .optional()
          .describe("Agent principal name (filters to this agent's proposals)"),
      },
    },
    async ({ agent }) => {
      const by = resolveAgent(agent, config);
      const all = pending(fh.graph);
      const mine = all.filter((p) => p.agent === by);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ proposals: mine }) }],
      };
    }
  );

  // ------------------------------------------------------------------ //
  // Schema tools                                                          //
  // ------------------------------------------------------------------ //

  server.registerTool(
    "describe_schema",
    {
      description:
        "Return the graph's installed ontologies as data: entity types, edge types, taxonomy terms.",
      inputSchema: {},
    },
    async () => {
      const schema = describeSchema(fh.graph);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(schema) }],
      };
    }
  );

  server.registerTool(
    "propose_ontology_change",
    {
      description:
        "Propose a schema change (add entity type, edge type, or taxonomy term). Always held for owner review.",
      inputSchema: {
        package_name: z.string().describe("Ontology package name, e.g. 'custom' or 'myapp'"),
        ontology_yaml: z
          .string()
          .describe("YAML ontology document (must have `ontology: <name>` header)"),
        agent: z.string().optional().describe("Agent principal name"),
      },
    },
    async ({ package_name, ontology_yaml, agent }) => {
      const by = resolveAgent(agent, config);
      const result = await proposeOntologyChange(fh.graph, by, package_name, ontology_yaml);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.status,
              hash: result.hash,
              provenance: { author: by, tool: "freehold@0.1" },
            }),
          },
        ],
      };
    }
  );
}

// ---- Per-request handler ----

/**
 * Handle a single MCP HTTP request in stateless mode.
 *
 * Creates a fresh McpServer + WebStandardStreamableHTTPServerTransport per
 * request.  This satisfies the SDK's "one transport per server" constraint
 * without session tracking overhead.
 */
export async function handleMcpRequest(
  fh: Freehold,
  embedder: Embedder,
  config: FreeholdConfig,
  request: Request
): Promise<Response> {
  const server = new McpServer(
    { name: "freehold", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  registerTools(server, fh, embedder, config);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
