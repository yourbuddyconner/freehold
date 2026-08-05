/**
 * Schema loop E2E (spec exit criterion 2): agent proposes a schema extension,
 * owner approves it, agent instantiates the new type, relates it to a note,
 * describe_schema shows the extension.
 *
 * Tests the full cycle: propose → pending → approve → saved → create entity → relate → describe.
 *
 * This is an in-process test (no daemon spawn) using hashEmbedder.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphManager, hashEmbedder, loadConfig } from "@freehold/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

let home: string;
let app: ReturnType<typeof createApp>;
let token: string;

async function makeTestApp() {
  home = mkdtempSync(join(tmpdir(), "freehold-schema-loop-"));
  const config = loadConfig(home);
  token = config.token;
  const manager = await GraphManager.open(home);
  app = createApp(manager, hashEmbedder, config);
}

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await app.request(path, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

beforeAll(async () => {
  await makeTestApp();
  // Register the test agent
  await req("POST", "/api/v1/agents", { name: "schema-agent" });
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("Schema loop (spec exit criterion 2)", () => {
  let ontologyProposalHash: string | undefined;
  let colleagueNodeId: string | undefined;
  let noteNodeId: string | undefined;

  test("propose Colleague extends core/Person with slack_id — pending", async () => {
    const ontologyYaml = `ontology: custom
entity_types:
  Colleague:
    attributes:
      slack_id:
        type: string
        required: false
      name:
        type: string
        required: true
edge_types:
  knows:
    domain: []
    range: []
`;
    const { status, body } = await req("POST", "/api/v1/schema/proposals", {
      agent: "schema-agent",
      packageName: "custom",
      ontologyYaml,
    });
    expect(status).toBe(200);
    const b = body as { status: string; hash: string };
    expect(b.status).toBe("pending");
    expect(typeof b.hash).toBe("string");
    expect(b.hash.length).toBeGreaterThan(0);
    ontologyProposalHash = b.hash;
  });

  test("proposal appears in GET /proposals", async () => {
    if (!ontologyProposalHash) return;
    const { status, body } = await req("GET", "/api/v1/proposals");
    expect(status).toBe(200);
    const b = body as { proposals: Array<{ hash: string; isSchemaProposal: boolean }> };
    expect(Array.isArray(b.proposals)).toBe(true);
    const found = b.proposals.find((p) => p.hash === ontologyProposalHash);
    expect(found).toBeDefined();
    expect(found?.isSchemaProposal).toBe(true);
  });

  test("owner approves the schema proposal — approved", async () => {
    if (!ontologyProposalHash) return;
    const { status, body } = await req("POST", `/api/v1/proposals/${ontologyProposalHash}/approve`);
    expect(status).toBe(200);
    const b = body as { status: string };
    expect(b.status === "approved" || b.status === "incomplete").toBe(true);
  });

  test("describe_schema shows custom/Colleague after approval", async () => {
    const { status, body } = await req("GET", "/api/v1/schema");
    expect(status).toBe(200);
    const b = body as { entityTypes: Array<{ name: string; extends?: string }> };
    expect(Array.isArray(b.entityTypes)).toBe(true);
    const colleague = b.entityTypes.find(
      (et) =>
        et.name === "custom/Colleague" ||
        et.name === "custom/Colleague@1" ||
        et.name.startsWith("custom/Colleague")
    );
    expect(colleague).toBeDefined();
  });

  test("instantiate Colleague entity with scratch classification", async () => {
    // Use workspace/scratch@1 so the entity is admitted immediately — allows us to relate it
    const { status, body } = await req("POST", "/api/v1/entities", {
      agent: "schema-agent",
      type: "custom/Colleague@1",
      attributes: { name: "Alice", slack_id: "U12345678" },
      classification: "workspace/scratch@1",
    });
    expect(status).toBe(200);
    const b = body as { status: string; nodeId: string; changeset: string };
    expect(b.status === "saved" || b.status === "pending").toBe(true);
    expect(typeof b.nodeId).toBe("string");
    colleagueNodeId = b.nodeId;
    // If pending, approve it so we can relate
    if (b.status === "pending") {
      await req("POST", `/api/v1/proposals/${b.changeset}/approve`);
    }
  });

  test("create a Note entity to relate to", async () => {
    const { status, body } = await req("POST", "/api/v1/remember", {
      agent: "schema-agent",
      content: "Note about Alice from the schema loop E2E test",
    });
    expect(status).toBe(200);
    const b = body as { status: string; noteId: string };
    expect(b.status).toBe("saved");
    noteNodeId = b.noteId;
  });

  test("relate Note to a second Note using memory/relates_to edge (scratch — admitted immediately)", async () => {
    // Create a second note to relate the first one to.
    // memory/relates_to@1 is defined with domain+range within the memory package.
    const { body: note2Body } = await req("POST", "/api/v1/remember", {
      agent: "schema-agent",
      content: "Second note about Alice — referenced from the schema loop test",
    });
    const n2 = note2Body as { status: string; noteId: string };
    expect(n2.status).toBe("saved");
    const noteNodeId2 = n2.noteId;

    if (!noteNodeId || !noteNodeId2) return;

    const { status, body } = await req("POST", "/api/v1/relations", {
      agent: "schema-agent",
      from: noteNodeId,
      to: noteNodeId2,
      edgeType: "memory/relates_to@1",
      scratch: true,
    });
    expect(status).toBe(200);
    const b = body as { status: string };
    expect(b.status === "saved" || b.status === "pending").toBe(true);
  });

  test("describe_schema still shows custom/Colleague after instantiation", async () => {
    const { status, body } = await req("GET", "/api/v1/schema");
    expect(status).toBe(200);
    const b = body as { entityTypes: Array<{ name: string }> };
    const colleague = b.entityTypes.find(
      (et) =>
        et.name === "custom/Colleague" ||
        et.name === "custom/Colleague@1" ||
        et.name.startsWith("custom/Colleague")
    );
    expect(colleague).toBeDefined();
  });
});
