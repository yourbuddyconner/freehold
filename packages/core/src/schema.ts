/**
 * @freehold/core — Schema operations layer.
 *
 * Ontology introspection and schema change proposals.
 */

import type { AllodGraph } from "@allod/core";
import type { EdgeTypeView, EntityTypeView, SchemaDescription, TermView } from "./types.js";

// ---- Raw Allod shapes ----

interface RawAttributeView {
  name: string;
  type_expr: string;
  required: boolean;
}

interface RawEntityTypeView {
  name: string;
  version?: number | null;
  extends?: string | null;
  attributes: RawAttributeView[];
}

interface RawEdgeTypeView {
  name: string;
  version?: number | null;
  domain: string[];
  range: string[];
  cardinality?: string | null;
}

interface RawTermView {
  name: string;
  version?: number | null;
  parents: string[];
  status?: string | null;
}

interface RawSchemaDescription {
  entity_types: RawEntityTypeView[];
  edge_types: RawEdgeTypeView[];
  terms: RawTermView[];
}

// ---- Public API ----

/**
 * Return a human-friendly description of the ontology loaded in the graph.
 */
export function describeSchema(graph: AllodGraph): SchemaDescription {
  const raw = graph.describe_schema() as RawSchemaDescription;

  const entityTypes: EntityTypeView[] = (raw.entity_types ?? []).map((et) => {
    const attrs: Record<string, unknown> = {};
    for (const a of et.attributes ?? []) {
      attrs[a.name] = { type: a.type_expr, required: a.required };
    }
    // name from allod is already "package/TypeName"
    const parts = et.name.split("/");
    return {
      name: et.name,
      package: parts[0],
      attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
      extends: et.extends ?? undefined,
    };
  });

  const edgeTypes: EdgeTypeView[] = (raw.edge_types ?? []).map((edge) => ({
    name: edge.name,
    domain: (edge.domain ?? []).join(", ") || undefined,
    range: (edge.range ?? []).join(", ") || undefined,
  }));

  const terms: TermView[] = (raw.terms ?? []).map((t) => ({
    name: t.name,
    parent: (t.parents ?? [])[0],
  }));

  return { entityTypes, edgeTypes, terms };
}

export interface OntologyProposalResult {
  status: "admitted" | "held";
  hash: string;
}

/**
 * Propose a schema/ontology change by installing a YAML ontology document.
 *
 * `ontologyYaml` should be a YAML string in ontology projection form:
 * must have `ontology: <name>` at the top level, with optional `entity_types:`,
 * `edge_types:`, etc. It is submitted via `install_package` as a named doc.
 *
 * If `ontologyYaml` does not start with `ontology:`, a minimal wrapper is
 * applied so the compiler recognises it. The `packageName` is used as the
 * doc name key in the outer mapping.
 */
export async function proposeOntologyChange(
  graph: AllodGraph,
  by: string,
  packageName: string,
  ontologyYaml: string
): Promise<OntologyProposalResult> {
  // Ensure the document has the `ontology:` header that compile_schema_ops requires.
  let docYaml = ontologyYaml.trimStart();
  if (!docYaml.startsWith("ontology:")) {
    docYaml = `ontology: ${packageName}\n${docYaml}`;
  }

  // install_package expects a YAML mapping of {name: doc} pairs
  const indented = docYaml
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  const docsYaml = `${packageName}:\n${indented}`;

  const raw = await graph.install_package(docsYaml, by);

  if (raw && typeof raw === "object") {
    if ("Admitted" in (raw as object)) {
      const r = raw as { Admitted: { hash: string } };
      return { status: "admitted", hash: r.Admitted.hash };
    }
    if ("Held" in (raw as object)) {
      const r = raw as { Held: { hash: string } };
      return { status: "held", hash: r.Held.hash };
    }
  }

  // Fallback — treat as admitted if no known variant
  return { status: "admitted", hash: "" };
}
