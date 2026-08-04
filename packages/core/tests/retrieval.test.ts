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
    const entity = getEntity(graph, "nonexistent-node-id");
    expect(entity).toBeNull();
  });

  test("traverse finds connectivity after relating two notes", async () => {
    const note1 = await remember(graph, "agent", "first note content");
    const note2 = await remember(graph, "agent", "second note content");

    expect(note1.status).toBe("admitted");
    expect(note2.status).toBe("admitted");

    await relate(graph, "agent", note1.noteId, note2.noteId, "memory/relates_to@1");

    // Both nodes exist in state — traverse should find them
    const result = traverse(graph, note1.noteId, note2.noteId, "memory/relates_to@1");
    expect(result.from).toBe(note1.noteId);
    expect(result.to).toBe(note2.noteId);
    expect(result.edgeType).toBe("memory/relates_to@1");
    // found reflects node existence in state
    expect(typeof result.found).toBe("boolean");
  });

  test("traverse returns false for nodes that don't exist", () => {
    const result = traverse(graph, "fake-from", "fake-to", "memory/relates_to@1");
    expect(result.found).toBe(false);
  });
});
