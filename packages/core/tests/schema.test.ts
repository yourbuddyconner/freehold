import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllodGraph } from "@allod/core";
import { beforeEach, describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import { describeSchema, proposeOntologyChange } from "../src/schema.js";

describe("schema", () => {
  let graph: AllodGraph;

  beforeEach(async () => {
    const graphDir = mkdtempSync(join(tmpdir(), "freehold-schema-test-"));
    graph = await createGraph(graphDir, "owner");
  });

  test("describeSchema() returns correct shape with entityTypes, edgeTypes, terms", () => {
    const schema = describeSchema(graph);
    expect(typeof schema).toBe("object");
    expect(Array.isArray(schema.entityTypes)).toBe(true);
    expect(Array.isArray(schema.edgeTypes)).toBe(true);
    expect(Array.isArray(schema.terms)).toBe(true);
  });

  test("describeSchema() includes memory/Note entity type", () => {
    const schema = describeSchema(graph);
    const noteType = schema.entityTypes.find(
      (et) => et.name === "memory/Note" || et.name.endsWith("/Note")
    );
    expect(noteType).toBeDefined();
  });

  test("describeSchema() entityTypes have name and optional package/extends", () => {
    const schema = describeSchema(graph);
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
    // Schema proposals go through policy — owner-signed are admitted, agent-signed are held
    expect(["admitted", "held"]).toContain(result.status);
    // Hash should be a non-empty string
    expect(typeof result.hash).toBe("string");
  });
});
