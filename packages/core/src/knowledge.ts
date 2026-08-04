/**
 * @freehold/core — Knowledge operations layer.
 *
 * High-level helpers for creating, updating, and relating entities in an
 * Allod graph. These are the primitives the MCP tools call.
 */

import type { AllodGraph } from "@allod/core";
import type { Admission } from "./types.js";

// ---- Raw Allod admission shapes ----

interface AllodAdmitted {
  Admitted: { hash: string; matched_rules: string[] };
}

interface AllodHeld {
  Held: { hash: string; checklist: unknown };
}

type AllodAdmission = AllodAdmitted | AllodHeld;

function parseAdmission(raw: AllodAdmission): Admission {
  if ("Admitted" in raw) {
    return { status: "admitted", hash: raw.Admitted.hash };
  }
  return { status: "held", hash: raw.Held.hash };
}

// ---- Op builders (mirrors the Rust helpers) ----

function uuid4(): string {
  return crypto.randomUUID();
}

function createNodeOp(
  id: string,
  typeRef: string,
  attributes: Record<string, unknown>,
  provenance?: unknown
) {
  const node: Record<string, unknown> = {
    kind: "node",
    id,
    type: typeRef,
    attributes,
  };
  if (provenance !== undefined) {
    node.provenance = provenance;
  }
  return { create: node };
}

function updateNodeOp(
  id: string,
  typeRef: string,
  prior: string,
  attributes: Record<string, unknown>
) {
  return {
    update: {
      kind: "node",
      id,
      type: typeRef,
      prior,
      attributes,
    },
  };
}

function createEdgeOp(
  id: string,
  typeRef: string,
  from: string,
  to: string,
  attributes?: Record<string, unknown>
) {
  const edge: Record<string, unknown> = {
    kind: "edge",
    id,
    type: typeRef,
    from,
    to,
  };
  if (attributes !== undefined) {
    edge.attributes = attributes;
  }
  return { create: edge };
}

function classificationOp(subject: string, term: string, assertedBy: string, basis: string) {
  return {
    create: {
      kind: "classification",
      id: uuid4(),
      subject,
      term,
      asserted_by: assertedBy,
      basis,
    },
  };
}

// ---- Public API ----

export interface RememberResult {
  status: "admitted" | "held";
  noteId: string;
  changeset: string;
}

/**
 * Write a scratch note for `agent` with `content`.
 * Under the memory policy, scratch notes are admitted immediately.
 */
export async function remember(
  graph: AllodGraph,
  agent: string,
  content: string
): Promise<RememberResult> {
  const raw = await graph.note(agent, content);
  const admission = parseAdmission(raw.admission as AllodAdmission);
  return {
    status: admission.status,
    noteId: raw.note_id as string,
    changeset: admission.hash,
  };
}

export interface CreateEntityResult {
  status: "admitted" | "held";
  nodeId: string;
  changeset: string;
}

/**
 * Create an entity node of `typeRef` with `attributes`.
 * Optionally classify with `classification` (e.g. "workspace/scratch@1").
 */
export async function createEntity(
  graph: AllodGraph,
  agent: string,
  typeRef: string,
  attributes: Record<string, unknown>,
  options?: {
    classification?: string;
    provenance?: unknown;
  }
): Promise<CreateEntityResult> {
  const nodeId = uuid4();
  const provenance = options?.provenance ?? {
    derived_by: `principal:${agent}`,
    method: "model-assisted",
    tool: "freehold@0.1",
  };

  const ops: unknown[] = [createNodeOp(nodeId, typeRef, attributes, provenance)];

  if (options?.classification) {
    ops.push(
      classificationOp(
        `node:${nodeId}`,
        options.classification,
        `principal:${agent}`,
        "model-assisted"
      )
    );
  }

  const raw = await graph.commit(agent, `Create ${typeRef}`, ops, []);
  const admission = parseAdmission(raw as AllodAdmission);
  return {
    status: admission.status,
    nodeId,
    changeset: admission.hash,
  };
}

export interface UpdateEntityResult {
  status: "admitted" | "held";
  changeset: string;
}

/**
 * Update an existing entity. `nodeId` is the bare UUID (not prefixed).
 * `typeRef` is the entity type (e.g. "memory/Note@1") — required by fold validation.
 * If `prior` is not provided, it is fetched from the graph via `node_rev`.
 * The `prior` field is the revision hash of the node's current content.
 */
export async function updateEntity(
  graph: AllodGraph,
  agent: string,
  nodeId: string,
  typeRef: string,
  attributes: Record<string, unknown>,
  prior?: string | null
): Promise<UpdateEntityResult> {
  // If prior not supplied, look it up from graph state.
  const rev = prior ?? (graph.node_rev(nodeId) as string | null);
  if (!rev) {
    throw new Error(`node_rev: node not found: ${nodeId}`);
  }
  const ops = [updateNodeOp(nodeId, typeRef, rev, attributes)];
  const raw = await graph.commit(agent, `Update node:${nodeId}`, ops, []);
  const admission = parseAdmission(raw as AllodAdmission);
  return { status: admission.status, changeset: admission.hash };
}

export interface RelateResult {
  status: "admitted" | "held";
  edgeId: string;
  changeset: string;
}

/**
 * Create a directed edge of `edgeType` from `fromId` to `toId`.
 * IDs are bare UUIDs; the function prefixes them with "node:".
 */
export async function relate(
  graph: AllodGraph,
  agent: string,
  fromId: string,
  toId: string,
  edgeType: string,
  attributes?: Record<string, unknown>
): Promise<RelateResult> {
  const edgeId = uuid4();
  const ops = [createEdgeOp(edgeId, edgeType, `node:${fromId}`, `node:${toId}`, attributes)];
  const raw = await graph.commit(agent, `Relate ${edgeType}`, ops, []);
  const admission = parseAdmission(raw as AllodAdmission);
  return { status: admission.status, edgeId, changeset: admission.hash };
}

export interface ClassifyResult {
  status: "admitted" | "held";
  changeset: string;
}

/**
 * Add a classification term to `nodeId`.
 */
export async function classifyEntity(
  graph: AllodGraph,
  agent: string,
  nodeId: string,
  term: string
): Promise<ClassifyResult> {
  const raw = await graph.classify(nodeId, term, agent, "model-assisted");
  const admission = parseAdmission(raw as AllodAdmission);
  return { status: admission.status, changeset: admission.hash };
}

export interface AttachDocumentResult {
  status: "admitted" | "held";
  docNodeId: string;
  changeset: string;
}

/**
 * Attach a text document to an entity.
 * Creates a memory/Document node and links it to `entityId`.
 */
export async function attachDocument(
  graph: AllodGraph,
  agent: string,
  entityId: string,
  content: string,
  title?: string
): Promise<AttachDocumentResult> {
  const docId = uuid4();
  const attrs: Record<string, unknown> = { content };
  if (title !== undefined) attrs.title = title;

  const provenance = {
    derived_by: `principal:${agent}`,
    method: "model-assisted",
    tool: "freehold@0.1",
  };

  const ops: unknown[] = [
    createNodeOp(docId, "memory/Note@1", attrs, provenance),
    classificationOp(
      `node:${docId}`,
      "workspace/scratch@1",
      `principal:${agent}`,
      "model-assisted"
    ),
    createEdgeOp(uuid4(), "memory/relates_to@1", `node:${entityId}`, `node:${docId}`),
  ];

  const raw = await graph.commit(agent, `Attach document to node:${entityId}`, ops, []);
  const admission = parseAdmission(raw as AllodAdmission);
  return { status: admission.status, docNodeId: docId, changeset: admission.hash };
}
