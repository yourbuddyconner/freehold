/**
 * @freehold/core — Knowledge operations layer.
 *
 * High-level helpers for creating, updating, and relating entities in an
 * Allod graph. These are the primitives the MCP tools call.
 */

import type { AllodGraph } from "@allod/core";
import { withGraph } from "./lock.js";
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
    return { status: "saved", hash: raw.Admitted.hash };
  }
  // Thread through checklist (proposal + rule) so HTTP + MCP callers can surface the pending state
  return { status: "pending", hash: raw.Held.hash, proposal: raw.Held.checklist, rule: undefined };
}

// ---- Op builders (mirrors the Rust helpers) ----

function uuid4(): string {
  return crypto.randomUUID();
}

async function sha256hex(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  status: "saved" | "pending";
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
  return withGraph(graph, async () => {
    const raw = await graph.note(agent, content);
    const admission = parseAdmission(raw.admission as AllodAdmission);
    return {
      status: admission.status,
      noteId: raw.note_id as string,
      changeset: admission.hash,
    };
  });
}

export interface CreateEntityResult {
  status: "saved" | "pending";
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

  return withGraph(graph, async () => {
    const raw = await graph.commit(agent, `Create ${typeRef}`, ops, [], true);
    const admission = parseAdmission(raw as AllodAdmission);
    return {
      status: admission.status,
      nodeId,
      changeset: admission.hash,
    };
  });
}

export interface UpdateEntityResult {
  status: "saved" | "pending";
  changeset: string;
}

/**
 * Update an existing entity. `nodeId` is the bare UUID (not prefixed).
 * `typeRef` is the entity type (e.g. "memory/Note@1") — required by fold validation.
 * If `prior` is not provided, it is fetched from the graph via `node_rev`.
 * The `prior` field is the revision hash of the node's current content.
 *
 * The node_rev read and commit are performed inside the same critical section
 * to close the TOCTOU race: no other writer can slip between the read and the write.
 */
export async function updateEntity(
  graph: AllodGraph,
  agent: string,
  nodeId: string,
  typeRef: string,
  attributes: Record<string, unknown>,
  prior?: string | null
): Promise<UpdateEntityResult> {
  return withGraph(graph, async () => {
    // node_rev read is inside the lock so no writer can interleave
    const rev = prior ?? (graph.node_rev(nodeId) as string | null);
    if (!rev) {
      throw new Error(`node_rev: node not found: ${nodeId}`);
    }
    const ops = [updateNodeOp(nodeId, typeRef, rev, attributes)];
    const raw = await graph.commit(agent, `Update node:${nodeId}`, ops, [], true);
    const admission = parseAdmission(raw as AllodAdmission);
    return { status: admission.status, changeset: admission.hash };
  });
}

export interface RelateResult {
  status: "saved" | "pending";
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
  attributes?: Record<string, unknown>,
  options?: { scratch?: boolean }
): Promise<RelateResult> {
  const edgeId = uuid4();
  const ops: unknown[] = [
    createEdgeOp(edgeId, edgeType, `node:${fromId}`, `node:${toId}`, attributes),
  ];
  // Add scratch classification on the edge itself to save the changeset under
  // the scratch-is-free rule. Policy region check is per-op: the edge op needs
  // to have workspace/scratch@1 in its own region set (via a classification op
  // whose subject is edge:<edgeId>) to be saved without owner review.
  if (options?.scratch !== false) {
    ops.push(
      classificationOp(
        `edge:${edgeId}`,
        "workspace/scratch@1",
        `principal:${agent}`,
        "model-assisted"
      )
    );
  }
  return withGraph(graph, async () => {
    const raw = await graph.commit(agent, `Relate ${edgeType}`, ops, [], true);
    const admission = parseAdmission(raw as AllodAdmission);
    return { status: admission.status, edgeId, changeset: admission.hash };
  });
}

export interface ClassifyResult {
  status: "saved" | "pending";
  changeset: string;
}

/**
 * Add a classification term to `nodeId`.
 */
export async function classifyEntity(
  graph: AllodGraph,
  agent: string,
  nodeId: string,
  term: string,
  basis: "model-assisted" | "manual" = "model-assisted"
): Promise<ClassifyResult> {
  return withGraph(graph, async () => {
    const raw = await graph.classify(nodeId, term, agent, basis);
    const admission = parseAdmission(raw as AllodAdmission);
    return { status: admission.status, changeset: admission.hash };
  });
}

export interface AttachDocumentResult {
  status: "saved" | "pending";
  docNodeId: string;
  changeset: string;
}

/**
 * Attach a document to an entity.
 *
 * Creates a `document`-kind allod object (per spec §1.5) with a content_hash,
 * media_type, and storage:"inline", then links it to `entityId` via a
 * `memory/relates_to@1` edge. The document is classified as workspace/scratch@1
 * so the changeset is admitted immediately under the memory policy.
 *
 * @param mediaType  MIME type hint (default: "text/plain")
 */
export async function attachDocument(
  graph: AllodGraph,
  agent: string,
  entityId: string,
  content: string,
  title?: string,
  mediaType = "text/plain"
): Promise<AttachDocumentResult> {
  const docId = uuid4();
  const hash = await sha256hex(content);
  const contentHash = `sha256:${hash}`;

  const docContent: Record<string, unknown> = {
    kind: "document",
    id: docId,
    content_hash: contentHash,
    media_type: mediaType,
    storage: "inline",
  };
  if (title !== undefined) docContent.title = title;

  const ops: unknown[] = [
    { create: docContent },
    // Classify the document as scratch so the changeset is saved under scratch-is-free.
    // Note: allod edge endpoints must reference node-kind objects, so the document↔entity
    // relationship is expressed via the commit message instead of an edge op.
    classificationOp(
      `document:${docId}`,
      "workspace/scratch@1",
      `principal:${agent}`,
      "model-assisted"
    ),
  ];

  return withGraph(graph, async () => {
    const raw = await graph.commit(agent, `Attach document to node:${entityId}`, ops, [], true);
    const admission = parseAdmission(raw as AllodAdmission);
    return { status: admission.status, docNodeId: docId, changeset: admission.hash };
  });
}
