/**
 * Concurrency regression test — wasm-bindgen aliasing error guard.
 *
 * Without the per-graph async mutex in lock.ts, firing concurrent graph
 * operations throws: "Error: recursive use of an object detected which would
 * lead to unsafe aliasing in rust". These tests assert that all concurrent
 * calls resolve correctly under the lock.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllodGraph } from "@allod/core";
import { beforeEach, describe, expect, test } from "vitest";
import { createGraph } from "../src/allod.js";
import { pending } from "../src/governance.js";
import { createEntity, remember } from "../src/knowledge.js";
import { describeSchema } from "../src/schema.js";

describe("concurrency", () => {
  let graph: AllodGraph;

  beforeEach(async () => {
    const graphDir = mkdtempSync(join(tmpdir(), "freehold-concurrency-test-"));
    graph = await createGraph(graphDir, "owner");
    await graph.principal_add("agent", "agent", "owner");
  });

  test("10 concurrent remember() calls all return status=saved with non-empty hashes", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        remember(graph, "agent", `concurrent note ${i}: unique content ${crypto.randomUUID()}`)
      )
    );

    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r.status).toBe("saved");
      expect(typeof r.noteId).toBe("string");
      expect(r.noteId.length).toBeGreaterThan(0);
      expect(typeof r.changeset).toBe("string");
      expect(r.changeset.length).toBeGreaterThan(0);
    }

    // All 10 note IDs are distinct
    const noteIds = results.map((r) => r.noteId);
    expect(new Set(noteIds).size).toBe(10);

    // All 10 changesets are distinct
    const changesets = results.map((r) => r.changeset);
    expect(new Set(changesets).size).toBe(10);

    // The graph log must contain all 10 entries
    const log = (graph as unknown as { log(): Array<{ hash: string }> }).log();
    expect(log.length).toBeGreaterThanOrEqual(10);
  });

  test("mixed concurrent batch: mutations and reads all resolve with expected shapes", async () => {
    // Two createEntity (memory/Preference — expect status 'pending'),
    // a describeSchema read, and a pending() listing — all concurrent.
    const [pref1, pref2, schema, proposals] = await Promise.all([
      createEntity(graph, "agent", "memory/Preference@1", {
        statement: "concurrent preference A",
        strength: "soft",
      }),
      createEntity(graph, "agent", "memory/Preference@1", {
        statement: "concurrent preference B",
        strength: "hard",
      }),
      describeSchema(graph),
      pending(graph),
    ]);

    // createEntity for memory/Preference without scratch classification → pending
    expect(pref1.status).toBe("pending");
    expect(typeof pref1.nodeId).toBe("string");
    expect(pref1.nodeId.length).toBeGreaterThan(0);
    expect(typeof pref1.changeset).toBe("string");
    expect(pref1.changeset.length).toBeGreaterThan(0);

    expect(pref2.status).toBe("pending");
    expect(typeof pref2.nodeId).toBe("string");
    expect(pref2.nodeId.length).toBeGreaterThan(0);
    expect(typeof pref2.changeset).toBe("string");
    expect(pref2.changeset.length).toBeGreaterThan(0);

    // The two node IDs must be distinct
    expect(pref1.nodeId).not.toBe(pref2.nodeId);

    // describeSchema must return a valid schema shape
    expect(typeof schema).toBe("object");
    expect(Array.isArray(schema.entityTypes)).toBe(true);
    expect(schema.entityTypes.length).toBeGreaterThan(0);
    expect(Array.isArray(schema.edgeTypes)).toBe(true);
    expect(Array.isArray(schema.terms)).toBe(true);

    // pending() must return an array (may be empty or contain the two proposals,
    // depending on serialization order — at least a valid array shape)
    expect(Array.isArray(proposals)).toBe(true);
    for (const p of proposals) {
      expect(typeof p.hash).toBe("string");
      expect(typeof p.agent).toBe("string");
      expect(Array.isArray(p.diff)).toBe(true);
      expect(Array.isArray(p.rules)).toBe(true);
    }
  });
});
