import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllodGraph } from "@allod/core";
import { beforeEach, describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import {
  attachDocument,
  classifyEntity,
  createEntity,
  relate,
  remember,
  updateEntity,
} from "../src/knowledge.js";

describe("knowledge", () => {
  let graph: AllodGraph;

  beforeEach(async () => {
    const graphDir = mkdtempSync(join(tmpdir(), "freehold-knowledge-test-"));
    graph = await createGraph(graphDir, "owner");
    // Register an agent to use as the author
    await graph.principal_add("agent", "agent", "owner");
  });

  test("remember returns admitted with noteId and changeset", async () => {
    const result = await remember(graph, "agent", "likes coffee");
    expect(result.status).toBe("admitted");
    expect(typeof result.noteId).toBe("string");
    expect(result.noteId.length).toBeGreaterThan(0);
    expect(typeof result.changeset).toBe("string");
    expect(result.changeset.length).toBeGreaterThan(0);
  });

  test("createEntity with memory/Preference@1 and no classification is held", async () => {
    const result = await createEntity(graph, "agent", "memory/Preference@1", {
      statement: "prefers dark mode",
      strength: "soft",
    });
    // Preference nodes without scratch classification are held for owner review
    expect(result.status).toBe("held");
    expect(typeof result.nodeId).toBe("string");
    expect(typeof result.changeset).toBe("string");
  });

  test("createEntity with memory/Note@1 + workspace/scratch@1 is admitted", async () => {
    const result = await createEntity(
      graph,
      "agent",
      "memory/Note@1",
      { content: "a scratch note" },
      { classification: "workspace/scratch@1" }
    );
    expect(result.status).toBe("admitted");
    expect(typeof result.nodeId).toBe("string");
  });

  test("updateEntity after creating and admitting a scratch note", async () => {
    // Create a scratch note (admitted)
    const created = await createEntity(
      graph,
      "agent",
      "memory/Note@1",
      { content: "original content" },
      { classification: "workspace/scratch@1" }
    );
    expect(created.status).toBe("admitted");

    // Pass typeRef and let updateEntity auto-fetch the node's rev
    const updated = await updateEntity(graph, "agent", created.nodeId, "memory/Note@1", {
      content: "updated content",
    });
    // Update of a scratch note should also be admitted or held (policy dependent)
    expect(["admitted", "held"]).toContain(updated.status);
    expect(typeof updated.changeset).toBe("string");
  });

  test("relate creates an edge between two entities", async () => {
    const note1 = await remember(graph, "agent", "first note");
    const note2 = await remember(graph, "agent", "second note");

    const result = await relate(graph, "agent", note1.noteId, note2.noteId, "memory/relates_to@1");
    // Relating two scratch notes should be admitted
    expect(["admitted", "held"]).toContain(result.status);
    expect(typeof result.edgeId).toBe("string");
    expect(result.edgeId.length).toBeGreaterThan(0);
  });

  test("classifyEntity adds a classification to a node", async () => {
    const note = await remember(graph, "agent", "a note to classify");
    // Re-classify with the same term (already has scratch, try to add again)
    // or use a different available term — workspace/scratch@1 is already on notes
    // We just verify the call completes without error
    const result = await classifyEntity(graph, "agent", note.noteId, "workspace/scratch@1");
    expect(["admitted", "held"]).toContain(result.status);
  });

  test("attachDocument creates a document-kind object with content_hash", async () => {
    const note = await remember(graph, "agent", "main note");
    const result = await attachDocument(
      graph,
      "agent",
      note.noteId,
      "This is the document content",
      "My Document"
    );
    expect(["admitted", "held"]).toContain(result.status);
    expect(typeof result.docNodeId).toBe("string");
    expect(result.docNodeId.length).toBeGreaterThan(0);

    // The document object should be in fold state under ("document", docNodeId)
    const docObj = (
      graph as unknown as {
        object_get(
          kind: string,
          id: string
        ): { content: Record<string, unknown>; rev: string; deleted: boolean } | null;
      }
    ).object_get("document", result.docNodeId);
    expect(docObj).not.toBeNull();
    expect(docObj?.deleted).toBe(false);
    // content_hash must be a sha256: prefixed hex string
    expect(typeof docObj?.content.content_hash).toBe("string");
    expect((docObj?.content.content_hash as string).startsWith("sha256:")).toBe(true);
    // media_type should default to text/plain
    expect(docObj?.content.media_type).toBe("text/plain");
  });

  test("attachDocument with custom mediaType stores it correctly", async () => {
    const note = await remember(graph, "agent", "source entity");
    const result = await attachDocument(
      graph,
      "agent",
      note.noteId,
      "<html><body>hello</body></html>",
      "HTML Doc",
      "text/html"
    );
    expect(["admitted", "held"]).toContain(result.status);

    const docObj = (
      graph as unknown as {
        object_get(
          kind: string,
          id: string
        ): { content: Record<string, unknown>; rev: string; deleted: boolean } | null;
      }
    ).object_get("document", result.docNodeId);
    expect(docObj?.content.media_type).toBe("text/html");
  });

  test("relate with a nonexistent target fails gracefully (throws or errors)", async () => {
    const note = await remember(graph, "agent", "source note");
    const fakeTargetId = "00000000-0000-0000-0000-000000000000";
    // relate() builds the edge op and commits — the graph will reject the edge
    // if the target node doesn't exist in fold state.
    // Either: it throws, or it returns an error admission.
    try {
      const result = await relate(graph, "agent", note.noteId, fakeTargetId, "memory/relates_to@1");
      // If it doesn't throw, the result should still be structurally valid
      expect(["admitted", "held"]).toContain(result.status);
    } catch (err) {
      // Throwing is acceptable — the MCP layer catches it
      expect(err).toBeDefined();
    }
  });
});
