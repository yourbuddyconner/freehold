/**
 * @freehold/core — Schema operations layer.
 *
 * Ontology introspection and schema change proposals.
 */

import type { AllodGraph } from "@allod/core";
import { withGraph } from "./lock.js";
import type {
  Admission,
  EdgeTypeView,
  EntityTypeView,
  SchemaDescription,
  TermView,
} from "./types.js";

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
export async function describeSchema(graph: AllodGraph): Promise<SchemaDescription> {
  return withGraph(graph, () => {
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
  });
}

export type OntologyProposalResult = Admission;

// ---- Internal helpers ----

interface RawStateNode {
  type_ref: string;
  label: string;
  derived_by: string | null;
}

interface RawStateView {
  state_hash: string;
  nodes: RawStateNode[];
}

/**
 * Resolve the graph owner name (display_name of the first live core/User node).
 * Returns "owner" as a fallback if no user node is found.
 *
 * Called from within a withGraph critical section — must NOT call withGraph itself.
 */
function resolveOwner(graph: AllodGraph): string {
  const raw = graph.state() as RawStateView;
  const userNode = (raw.nodes ?? []).find((n) => (n.type_ref ?? "").split("@")[0] === "core/User");
  return userNode?.label ?? "owner";
}

/**
 * Normalise a raw Allod install_package admission result into an Admission object.
 */
function parseInstallAdmission(raw: unknown): OntologyProposalResult {
  if (raw && typeof raw === "object") {
    if ("Admitted" in (raw as object)) {
      const r = raw as { Admitted: { hash: string; matched_rules: string[] } };
      return { status: "saved", hash: r.Admitted.hash };
    }
    if ("Held" in (raw as object)) {
      const r = raw as { Held: { hash: string; checklist: unknown } };
      return { status: "pending", hash: r.Held.hash };
    }
  }
  return { status: "saved", hash: "" };
}

/**
 * Build the `docs_yaml` wrapper expected by `install_package`:
 *   `{packageName}:\n  {indented ontologyYaml}`
 *
 * Ensures the document has the `ontology:` header required by compile_schema_ops.
 */
function wrapDocsYaml(packageName: string, ontologyYaml: string): string {
  let docYaml = ontologyYaml.trimStart();
  if (!docYaml.startsWith("ontology:")) {
    docYaml = `ontology: ${packageName}\n${docYaml}`;
  }
  const indented = docYaml
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return `${packageName}:\n${indented}`;
}

// ---- Public API ----

/**
 * Propose a schema/ontology change by installing a YAML ontology document.
 *
 * `ontologyYaml` should be a YAML string in ontology projection form:
 * must have `ontology: <name>` at the top level, with optional `entity_types:`,
 * `edge_types:`, etc. It is submitted via `install_package` as a named doc.
 * Under the memory policy, schema changes require owner review and will be Held.
 */
export async function proposeOntologyChange(
  graph: AllodGraph,
  by: string,
  packageName: string,
  ontologyYaml: string
): Promise<OntologyProposalResult> {
  const docsYaml = wrapDocsYaml(packageName, ontologyYaml);
  return withGraph(graph, async () => {
    const raw = await graph.install_package(docsYaml, by);
    return parseInstallAdmission(raw);
  });
}

// ---- Policy accessor ----

/**
 * Return the raw YAML definition of the graph's active policy via the WASM
 * `get_policy()` binding. Returns `null` when no policy node is found.
 *
 * `graph.get_policy()` returns the parsed policy Value (the serde_yaml::Value
 * deserialized to a plain JS object) or `null` when no policy node exists.
 * The `definition` field is the JSON-stringified policy for stable string consumers.
 */
export async function getPolicy(
  graph: AllodGraph
): Promise<{ name: string; definition: string; rules?: unknown[] } | null> {
  return withGraph(graph, () => {
    try {
      const raw = (
        graph as unknown as { get_policy(): Record<string, unknown> | null }
      ).get_policy();
      if (!raw) return null;
      const name = typeof raw.name === "string" ? raw.name : "memory-baseline";
      const definition = JSON.stringify(raw);
      const rules = Array.isArray(raw.rules) ? (raw.rules as unknown[]) : undefined;
      return { name, definition, rules };
    } catch {
      return null;
    }
  });
}

/**
 * Propose a policy change by installing `policyYaml`.
 *
 * Calls `install_policy(policyYaml, by)` on the WASM graph, which routes
 * through `install_package` with `Some(policy)` — empty docs, policy-only
 * changeset. The `set-policy` operation is governed, so the proposal stays
 * pending until the owner approves it — whether the author is the owner or
 * an agent.
 *
 * @param author - Authoring principal. Defaults to the graph owner; pass an
 *   agent name for agent-authored proposals.
 */
export async function proposePolicyChange(
  graph: AllodGraph,
  policyYaml: string,
  author?: string
): Promise<OntologyProposalResult> {
  return withGraph(graph, async () => {
    const by = author ?? resolveOwner(graph);
    const raw = await (
      graph as unknown as { install_policy(yaml: string, by: string): Promise<unknown> }
    ).install_policy(policyYaml, by);
    return parseInstallAdmission(raw);
  });
}

/**
 * Install an ontology package as the graph owner (owner-signed path).
 *
 * This is the privileged path for admins: the owner principal signs the
 * changeset, so it may be admitted immediately if the policy allows owner
 * self-approval. Under the reference memory policy, schema changes still
 * require a decision record even for the owner, so the result may be Held.
 *
 * The owner name is resolved from the graph's state (first core/User node).
 * This is the same principal used by `approve()` — the graph root authority.
 *
 * @param graph  - The open graph.
 * @param docsYaml - YAML ontology document (or a YAML mapping `{name: doc}`).
 */
export async function installOntology(
  graph: AllodGraph,
  docsYaml: string
): Promise<OntologyProposalResult> {
  return withGraph(graph, async () => {
    const owner = resolveOwner(graph);
    // Check if docsYaml is already a mapping (contains `:` on the first non-blank line
    // and the first key is not `ontology:`). If it looks like a bare ontology doc,
    // wrap it under a default package name.
    const trimmed = docsYaml.trimStart();
    let wrappedYaml: string;
    if (trimmed.startsWith("ontology:")) {
      // Bare ontology doc — extract the ontology name for the key
      const nameMatch = trimmed.match(/^ontology:\s*(\S+)/);
      const pkgName = nameMatch?.[1] ?? "custom";
      wrappedYaml = wrapDocsYaml(pkgName, docsYaml);
    } else {
      // Assume it's already a `{name: doc}` mapping
      wrappedYaml = docsYaml;
    }
    const raw = await graph.install_package(wrappedYaml, owner);
    return parseInstallAdmission(raw);
  });
}
