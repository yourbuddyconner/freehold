/**
 * Workspace view tests: memoryIndex and memoryGraph.
 *
 * Uses hashEmbedder so no model download is needed.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import { openDb } from "../src/db.js";
import { hashEmbedder } from "../src/embed.js";
import type { Freehold } from "../src/graphs.js";
import { deriveTitle, memoryGraph, memoryIndex } from "../src/graphview.js";
import { syncIndex } from "../src/indexer.js";
import { createEntity, relate, remember } from "../src/knowledge.js";

async function makeFreehold(): Promise<Freehold> {
  const home = mkdtempSync(join(tmpdir(), "freehold-graphview-test-"));
  const graphDir = join(home, "graphs", "main");
  const graph = await createGraph(graphDir, "owner");
  await graph.principal_add("agent", "agent", "owner");
  const db = await openDb(join(home, "pg"));
  return { graph, db, home, graphName: "main" } as unknown as Freehold;
}

describe("deriveTitle", () => {
  test("prefers title, then name, then statement, then first content line", () => {
    expect(deriveTitle({ attributes: { title: "T", name: "N" } }, "x")).toBe("T");
    expect(deriveTitle({ attributes: { name: "N", statement: "S" } }, "x")).toBe("N");
    expect(deriveTitle({ attributes: { statement: "S" } }, "x")).toBe("S");
    expect(deriveTitle({ attributes: { content: "# Heading\nbody" } }, "x")).toBe("Heading");
    expect(deriveTitle({ attributes: {} }, "fallback")).toBe("fallback");
  });

  test("truncates long first lines", () => {
    const long = "a".repeat(120);
    const title = deriveTitle({ attributes: { content: long } }, "x");
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("memoryIndex", () => {
  test("lists saved nodes with derived titles and terms", async () => {
    const fh = await makeFreehold();
    await remember(fh.graph, "agent", "standup moved to 2pm");
    const ent = await createEntity(
      fh.graph,
      "owner",
      "memory/Note@1",
      { title: "Named note", content: "body" },
      { classification: "workspace/scratch@1" }
    );
    expect(ent.status).toBe("saved");
    await syncIndex(fh, hashEmbedder);

    const entries = await memoryIndex(fh);
    const titled = entries.find((e) => e.id === ent.nodeId);
    expect(titled?.title).toBe("Named note");
    expect(titled?.terms).toContain("workspace/scratch@1");
    const note = entries.find((e) => e.title === "standup moved to 2pm");
    expect(note).toBeDefined();
    expect(note?.approval).toBe("saved");
    expect(note?.author).toBe("agent");
    // No meta nodes in the listing
    expect(entries.some((e) => e.type.startsWith("meta/"))).toBe(false);
  });

  test("includes pending proposal nodes with approval pending and no terms", async () => {
    const fh = await makeFreehold();
    // Agent write without scratch classification routes to review under the memory policy
    const held = await createEntity(fh.graph, "agent", "memory/Note@1", {
      title: "Proposed note",
      content: "needs review",
    });
    expect(held.status).toBe("pending");
    await syncIndex(fh, hashEmbedder);

    const entries = await memoryIndex(fh);
    const pending = entries.find((e) => e.id === held.nodeId);
    expect(pending).toBeDefined();
    expect(pending?.approval).toBe("pending");
    expect(pending?.terms).toEqual([]);
    expect(pending?.title).toBe("Proposed note");
  });
});

describe("memoryGraph", () => {
  test("returns nodes and each edge exactly once", async () => {
    const fh = await makeFreehold();
    const a = await remember(fh.graph, "agent", "note a");
    const b = await remember(fh.graph, "agent", "note b");
    const rel = await relate(fh.graph, "agent", a.noteId, b.noteId, "memory/relates_to@1");
    expect(rel.status).toBe("saved");
    await syncIndex(fh, hashEmbedder);

    const view = await memoryGraph(fh);
    expect(view.truncated).toBe(false);
    const ids = view.nodes.map((n) => n.id);
    expect(ids).toContain(a.noteId);
    expect(ids).toContain(b.noteId);
    const matching = view.edges.filter((e) => e.from === a.noteId && e.to === b.noteId);
    expect(matching.length).toBe(1);
    expect(matching[0].type).toBe("memory/relates_to@1");
  });

  test("drops edges whose target is outside the node set", async () => {
    const fh = await makeFreehold();
    const a = await remember(fh.graph, "agent", "solo node");
    await syncIndex(fh, hashEmbedder);
    const view = await memoryGraph(fh);
    // No edges reference nodes missing from the listing
    const ids = new Set(view.nodes.map((n) => n.id));
    for (const e of view.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
    expect(ids.has(a.noteId)).toBe(true);
  });
});
