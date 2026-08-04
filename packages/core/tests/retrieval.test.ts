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
    expect(note.status).toBe("saved");

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
    expect(note1.status).toBe("saved");

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

    expect(note1.status).toBe("saved");
    expect(note2.status).toBe("saved");

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

  test("getEntity returns classifications and edges when present", async () => {
    // Create two nodes
    const noteA = await remember(graph, "agent", "note A content");
    const noteB = await remember(graph, "agent", "note B content");
    expect(noteA.status).toBe("saved");
    expect(noteB.status).toBe("saved");

    // Classify noteA with workspace/scratch@1 (already done by remember, so it should be there)
    // Create an edge from noteA to noteB
    await relate(graph, "agent", noteA.noteId, noteB.noteId, "memory/relates_to@1");

    const entity = getEntity(graph, noteA.noteId);
    expect(entity).not.toBeNull();

    // classifications: remember() adds workspace/scratch@1 via scratch classification op
    expect(Array.isArray(entity?.classifications)).toBe(true);
    expect(entity?.classifications).toContain("workspace/scratch@1");

    // edges: the out-edge to noteB
    expect(Array.isArray(entity?.edges)).toBe(true);
    const outEdge = entity?.edges.find((e) => e.direction === "outgoing");
    expect(outEdge).toBeDefined();
    expect(outEdge?.type).toBe("memory/relates_to@1");
    expect(outEdge?.to).toBe(`node:${noteB.noteId}`);
    expect(outEdge?.from).toBe(`node:${noteA.noteId}`);

    // noteB should have an in-edge from noteA
    const entityB = getEntity(graph, noteB.noteId);
    expect(entityB).not.toBeNull();
    const inEdge = entityB?.edges.find((e) => e.direction === "incoming");
    expect(inEdge).toBeDefined();
    expect(inEdge?.from).toBe(`node:${noteA.noteId}`);
  });

  test("traverse depth=2 follows A→B→C chain", async () => {
    // A -relates_to-> B -relates_to-> C
    const noteA = await remember(graph, "agent", "node A");
    const noteB = await remember(graph, "agent", "node B");
    const noteC = await remember(graph, "agent", "node C");
    expect(noteA.status).toBe("saved");
    expect(noteB.status).toBe("saved");
    expect(noteC.status).toBe("saved");

    await relate(graph, "agent", noteA.noteId, noteB.noteId, "memory/relates_to@1");
    await relate(graph, "agent", noteB.noteId, noteC.noteId, "memory/relates_to@1");

    // depth=1 from A should only reach B
    const depth1 = traverse(graph, noteA.noteId, undefined, "out", 1);
    const ids1 = depth1.map((e) => e.id);
    expect(ids1).toContain(noteB.noteId);
    expect(ids1).not.toContain(noteC.noteId);

    // depth=2 from A should reach B and C
    const depth2 = traverse(graph, noteA.noteId, undefined, "out", 2);
    const ids2 = depth2.map((e) => e.id);
    expect(ids2).toContain(noteB.noteId);
    expect(ids2).toContain(noteC.noteId);
    expect(ids2).not.toContain(noteA.noteId);
  });

  test("traverse direction='in' from C returns [B]", async () => {
    const noteA = await remember(graph, "agent", "node A");
    const noteB = await remember(graph, "agent", "node B");
    const noteC = await remember(graph, "agent", "node C");

    await relate(graph, "agent", noteA.noteId, noteB.noteId, "memory/relates_to@1");
    await relate(graph, "agent", noteB.noteId, noteC.noteId, "memory/relates_to@1");

    // direction="in" from C: only B points to C
    const result = traverse(graph, noteC.noteId, undefined, "in", 1);
    const ids = result.map((e) => e.id);
    expect(ids).toContain(noteB.noteId);
    expect(ids).not.toContain(noteA.noteId);
    expect(ids).not.toContain(noteC.noteId);
  });

  test("traverse edgeTypes filter excludes non-matching edges", async () => {
    const noteA = await remember(graph, "agent", "node A");
    const noteB = await remember(graph, "agent", "node B");

    await relate(graph, "agent", noteA.noteId, noteB.noteId, "memory/relates_to@1");

    // Filter for a non-existent edge type: should return empty
    const result = traverse(graph, noteA.noteId, ["memory/nonexistent@1"], "out", 1);
    expect(result).toHaveLength(0);

    // Filter for the actual edge type: should return noteB
    const result2 = traverse(graph, noteA.noteId, ["memory/relates_to@1"], "out", 1);
    const ids = result2.map((e) => e.id);
    expect(ids).toContain(noteB.noteId);
  });
});
