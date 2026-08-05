/**
 * Graph-scoped PGlite index tables — isolation tests.
 *
 * Verifies that rows written under one graph_id are invisible to queries
 * for a different graph_id, and that the meta indexed_head cursor is
 * per-graph.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_ID,
  type DbHandle,
  getIndexedHead,
  listObjects,
  openDb,
  setIndexedHead,
  upsertObject,
} from "../src/db.js";

describe("index tables are graph-scoped", () => {
  let db: DbHandle;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "freehold-dbscope-test-"));
    db = await openDb(join(dir, "pg"));
  });

  it("DEFAULT_GRAPH_ID is 'main'", () => {
    expect(DEFAULT_GRAPH_ID).toBe("main");
  });

  it("rows written under graph A are invisible to graph B queries", async () => {
    // Insert an object row under graph "a" via the real helper
    await upsertObject("a", db.pg, {
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      kind: "node",
      type: "memory/Note@1",
      content: {},
      author: "agent",
      method: null,
      approval: "saved",
      changeset: "sha256:abc",
      searchText: "hello from graph a",
    });

    // Query under graph "b" → empty
    const rowsB = await listObjects("b", db.pg);
    expect(rowsB).toHaveLength(0);

    // Query under graph "a" → the row
    const rowsA = await listObjects("a", db.pg);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].id).toBe("aaaaaaaa-0000-0000-0000-000000000001");
  });

  it("meta indexed_head is per graph", async () => {
    // Set indexed_head for "a" and "b" to different values
    await setIndexedHead("a", db.pg, 5);
    await setIndexedHead("b", db.pg, 99);

    // Read both back — must be independent
    const headA = await getIndexedHead("a", db.pg);
    const headB = await getIndexedHead("b", db.pg);

    expect(headA).toBe(5);
    expect(headB).toBe(99);
  });

  it("DEFAULT_GRAPH_ID rows are visible under 'main'", async () => {
    await upsertObject(DEFAULT_GRAPH_ID, db.pg, {
      id: "bbbbbbbb-0000-0000-0000-000000000002",
      kind: "node",
      type: "memory/Note@1",
      content: {},
      author: "agent",
      method: null,
      approval: "saved",
      changeset: "sha256:def",
      searchText: "hello from main",
    });

    const rows = await listObjects("main", db.pg);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("bbbbbbbb-0000-0000-0000-000000000002");

    // Not visible under a different graph
    const rowsOther = await listObjects("other-graph", db.pg);
    expect(rowsOther).toHaveLength(0);
  });

  it("getIndexedHead returns 0 when no head is set for a graph", async () => {
    const head = await getIndexedHead("never-set", db.pg);
    expect(head).toBe(0);
  });
});
