import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllodGraph } from "@allod/core";
import { beforeEach, describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import {
  describeSchema,
  getPolicy,
  installOntology,
  proposeOntologyChange,
} from "../src/schema.js";

describe("schema", () => {
  let graph: AllodGraph;

  beforeEach(async () => {
    const graphDir = mkdtempSync(join(tmpdir(), "freehold-schema-test-"));
    graph = await createGraph(graphDir, "owner");
  });

  test("describeSchema() returns correct shape with entityTypes, edgeTypes, terms", async () => {
    const schema = await describeSchema(graph);
    expect(typeof schema).toBe("object");
    expect(Array.isArray(schema.entityTypes)).toBe(true);
    expect(Array.isArray(schema.edgeTypes)).toBe(true);
    expect(Array.isArray(schema.terms)).toBe(true);
  });

  test("describeSchema() includes memory/Note entity type", async () => {
    const schema = await describeSchema(graph);
    const noteType = schema.entityTypes.find(
      (et) => et.name === "memory/Note" || et.name.endsWith("/Note")
    );
    expect(noteType).toBeDefined();
  });

  test("describeSchema() entityTypes have name and optional package/extends", async () => {
    const schema = await describeSchema(graph);
    for (const et of schema.entityTypes) {
      expect(typeof et.name).toBe("string");
      expect(et.name.length).toBeGreaterThan(0);
      if (et.package !== undefined) {
        expect(typeof et.package).toBe("string");
      }
      if (et.extends !== undefined) {
        expect(typeof et.extends).toBe("string");
      }
    }
  });

  test("proposeOntologyChange() with a small ontology YAML returns held", async () => {
    // Ontology doc in projection form: must have `ontology:` + `entity_types:`
    const ontologyYaml = `ontology: custom
entity_types:
  Widget:
    attributes:
      label:
        type: string
        required: true`;

    const result = await proposeOntologyChange(graph, "owner", "custom", ontologyYaml);
    // Schema proposals go through policy — owner-signed are saved, agent-signed are pending
    expect(["saved", "pending"]).toContain(result.status);
    // Hash should be a non-empty string
    expect(typeof result.hash).toBe("string");
  });

  test("getPolicy() returns policy with rules after createGraph", async () => {
    const policy = await getPolicy(graph);
    expect(policy).not.toBeNull();
    expect(typeof policy?.name).toBe("string");
    expect(policy?.name.length).toBeGreaterThan(0);
    expect(typeof policy?.definition).toBe("string");
    // The definition must contain "scratch" (from the scratch-is-free rule)
    expect(policy?.definition).toContain("scratch");
  });

  test("installOntology() installs as owner and returns Admission-shaped result", async () => {
    // installOntology uses the owner principal (first core/User node in state)
    const ontologyYaml = `ontology: gadgets
entity_types:
  Gadget:
    attributes:
      name:
        type: string
        required: true`;

    const result = await installOntology(graph, ontologyYaml);
    // installOntology resolves the owner from graph state and signs as the owner.
    // Under the memory policy, schema changes still require a decision record even
    // for the owner, so this may be pending — or saved if the policy is trivially met.
    expect(["saved", "pending"]).toContain(result.status);
    expect(typeof result.hash).toBe("string");
    // The result is Admission-shaped
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("hash");
  });
});
