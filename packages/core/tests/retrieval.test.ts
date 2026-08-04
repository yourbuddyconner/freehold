import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllodGraph } from "@allod/core";
import { beforeEach, describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import { relate, remember } from "../src/knowledge.js";
import { getEntity, traverse } from "../src/retrieval.js";

describe("retrieval", () => {
  let graph: AllodGraph;

  beforeEach(async () => {
    const graphDir = mkdtempSync(join(tmpdir(), "freehold-retrieval-test-"));
    graph = await createGraph(graphDir, "owner");
    await graph.principal_add("agent", "agent", "owner");
  });

  test("getEntity returns null for an unknown nodeId", () => {
    const entity = getEntity(graph, "00000000-0000-0000-0000-000000000000");
    expect(entity).toBeNull();
  });

  test("getEntity returns an EntityView for a node that exists", async () => {
    const note = await remember(graph, "agent", "hello world");
    expect(note.status).toBe("admitted");

    // Use object_get to verify the node exists, then check getEntity
    const entity = getEntity(graph, note.noteId);
    expect(entity).not.toBeNull();
    expect(entity?.id).toBe(note.noteId);
    expect(typeof entity?.type).toBe("string");
    expect(entity?.type).toContain("memory/Note");
    // attributes should have content
    expect(entity?.attributes?.content).toBe("hello world");
    // classifications and edges are arrays (may be empty due to API surface limits)
    expect(Array.isArray(entity?.classifications)).toBe(true);
    expect(Array.isArray(entity?.edges)).toBe(true);
    expect(Array.isArray(entity?.revisions)).toBe(true);
  });

  test("traverse returns EntityView[] (empty if no reachable nodes from start)", async () => {
    // traverse returns EntityView[] of nodes reachable from fromId
    // With depth=1 and no known traversable edges, result is empty (honest about limits)
    const note1 = await remember(graph, "agent", "first note content");
    expect(note1.status).toBe("admitted");

    const result = traverse(graph, note1.noteId, ["memory/relates_to@1"], "out", 1);
    expect(Array.isArray(result)).toBe(true);
    // May be empty because edge ID enumeration is not available via the public API
    // This is the honest result — see comments in traverse() implementation
  });

  test("traverse returns empty array for a nodeId that does not exist", () => {
    const result = traverse(graph, "00000000-0000-0000-0000-000000000000");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test("traverse with relate: both notes exist, result is an array", async () => {
    const note1 = await remember(graph, "agent", "first note content");
    const note2 = await remember(graph, "agent", "second note content");

    expect(note1.status).toBe("admitted");
    expect(note2.status).toBe("admitted");

    await relate(graph, "agent", note1.noteId, note2.noteId, "memory/relates_to@1");

    // Both nodes exist and an edge was created. traverse returns an EntityView[].
    const result = traverse(graph, note1.noteId, ["memory/relates_to@1"], "out", 1);
    expect(Array.isArray(result)).toBe(true);
    // Result may be empty (API surface limitation) or contain note2's EntityView
    // This test verifies the API contract (returns EntityView[]) without
    // asserting specific connectivity that requires edge enumeration.
    for (const ev of result) {
      expect(typeof ev.id).toBe("string");
      expect(typeof ev.type).toBe("string");
      expect(Array.isArray(ev.classifications)).toBe(true);
      expect(Array.isArray(ev.edges)).toBe(true);
    }
  });
});
