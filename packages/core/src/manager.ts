/**
 * @freehold/core — GraphManager
 *
 * Registry of allod graphs: the default "main" memory graph and any
 * repo graphs registered via registerRepo().
 *
 * Each graph gets a unique slug id. The registry is persisted in the
 * PGlite "graphs" table. Graph handles are cached in memory to avoid
 * opening the same graph twice (wasm-bindgen aliasing is unsafe).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { createGraph } from "./allod.js";
import { loadConfig } from "./config.js";
import { DEFAULT_GRAPH_ID, openDb } from "./db.js";
import type { DbHandle } from "./db.js";
import { ensureHome } from "./home.js";
import type { Freehold } from "./graphs.js";
import { openFreehold } from "./graphs.js";
import { approve } from "./governance.js";
import { describeSchema, installOntology } from "./schema.js";
import { originRemote } from "./git.js";

export interface GraphEntry {
  id: string;
  name: string;
  path: string;
  kind: "memory" | "repo";
  autoPushNotes: boolean;
  embedder: "hash" | "semantic";
  allodGraphId: string;
  originRemote: string | null;
}

/** Read the review ontology YAML bundled as an asset next to this file. */
function reviewOntologyYaml(): string {
  const assetUrl = new URL("../assets/review-ontology.yaml", import.meta.url);
  return readFileSync(fileURLToPath(assetUrl), "utf-8");
}

/**
 * Parse the allod_graph_id from a graph's .allod/graph.yaml file.
 * Returns "" if the file doesn't exist or lacks the field.
 */
function readAllodGraphId(graphDir: string): string {
  const yamlPath = join(graphDir, ".allod", "graph.yaml");
  if (!existsSync(yamlPath)) return "";
  try {
    const doc = yamlLoad(readFileSync(yamlPath, "utf-8")) as Record<string, unknown> | null;
    if (!doc) return "";
    // Try both field names that allod may use
    return ((doc.graph_id ?? doc.id) as string) ?? "";
  } catch {
    return "";
  }
}

/**
 * Generate a unique registry slug from a repo path.
 * Uses the basename; appends a short hex suffix to handle collisions.
 */
function makeRepoId(path: string): string {
  const base = path
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^a-z0-9_-]/gi, "-")
    .toLowerCase() ?? "repo";
  // Short random suffix to avoid collisions
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

/** Map a DB row (snake_case) to a GraphEntry (camelCase). */
function rowToEntry(row: {
  id: string;
  name: string;
  path: string;
  kind: string;
  auto_push_notes: boolean;
  embedder: string;
  allod_graph_id: string;
  origin_remote: string | null;
}): GraphEntry {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    kind: row.kind as "memory" | "repo",
    autoPushNotes: row.auto_push_notes,
    embedder: row.embedder as "hash" | "semantic",
    allodGraphId: row.allod_graph_id,
    originRemote: row.origin_remote,
  };
}

export class GraphManager {
  readonly db: DbHandle;
  private readonly home: string;
  /** Cache of opened Freehold handles keyed by graph id. */
  private cache = new Map<string, Freehold>();
  /** In-flight open promises to prevent concurrent duplicate opens. */
  private inFlight = new Map<string, Promise<Freehold>>();

  private constructor(db: DbHandle, home: string) {
    this.db = db;
    this.home = home;
  }

  /**
   * Open (or create) the GraphManager for the given home directory.
   * Seeds the default "main" graph entry if not already registered.
   */
  static async open(home?: string): Promise<GraphManager> {
    const h = ensureHome(home);
    const config = loadConfig(h);
    const pgDir = join(h, "pg");
    const db = await openDb(pgDir);
    const manager = new GraphManager(db, h);

    // Seed the default "main" graph if absent
    const existing = await db.pg.query<{ id: string }>(
      "SELECT id FROM graphs WHERE id = $1",
      [DEFAULT_GRAPH_ID]
    );
    if (existing.rows.length === 0) {
      const mainGraphDir = join(h, "graphs", "main");
      // Ensure the graph directory exists on disk
      if (!existsSync(join(mainGraphDir, ".allod", "graph.yaml"))) {
        await createGraph(mainGraphDir, "owner");
      }
      const allodGraphId = readAllodGraphId(mainGraphDir);
      const embedder = config.embedder === "hash" ? "hash" : "semantic";
      await db.pg.query(
        `INSERT INTO graphs (id, name, path, kind, auto_push_notes, embedder, allod_graph_id, origin_remote)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [DEFAULT_GRAPH_ID, "Main", mainGraphDir, "memory", false, embedder, allodGraphId, null]
      );
      // Warm the cache: openFreehold opens the graph from disk
      const mainFh = await openFreehold({
        graphDir: mainGraphDir,
        db,
        home: h,
        graphName: "main",
        graphId: DEFAULT_GRAPH_ID,
        kind: "memory",
      });
      manager.cache.set(DEFAULT_GRAPH_ID, mainFh);
    }

    return manager;
  }

  /**
   * Return the registry entry for a graph id, or null if not found.
   */
  async getEntry(id: string): Promise<GraphEntry | null> {
    const result = await this.db.pg.query<{
      id: string;
      name: string;
      path: string;
      kind: string;
      auto_push_notes: boolean;
      embedder: string;
      allod_graph_id: string;
      origin_remote: string | null;
    }>("SELECT * FROM graphs WHERE id = $1", [id]);
    if (result.rows.length === 0) return null;
    return rowToEntry(result.rows[0]);
  }

  /**
   * List all registered graph entries.
   */
  async list(): Promise<GraphEntry[]> {
    const result = await this.db.pg.query<{
      id: string;
      name: string;
      path: string;
      kind: string;
      auto_push_notes: boolean;
      embedder: string;
      allod_graph_id: string;
      origin_remote: string | null;
    }>("SELECT * FROM graphs ORDER BY id");
    return result.rows.map(rowToEntry);
  }

  /**
   * Get an open Freehold handle for the given graph id.
   * Caches handles; prevents concurrent duplicate opens via in-flight map.
   * Throws if the graph id is not registered.
   */
  async get(id: string): Promise<Freehold> {
    // Cache hit
    const cached = this.cache.get(id);
    if (cached) return cached;

    // In-flight dedup
    const flying = this.inFlight.get(id);
    if (flying) return flying;

    const promise = this._open(id);
    this.inFlight.set(id, promise);
    try {
      const fh = await promise;
      this.cache.set(id, fh);
      return fh;
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async _open(id: string): Promise<Freehold> {
    const entry = await this.getEntry(id);
    if (!entry) {
      throw new Error(`Graph not registered: ${id}`);
    }
    return openFreehold({
      graphDir: entry.path,
      db: this.db,
      home: this.home,
      graphName: id,
      graphId: id,
      kind: entry.kind,
    });
  }

  /**
   * Register an existing repo checkout as a graph.
   * Opens the graph, installs the review ontology if not present,
   * records the origin remote, and persists the entry.
   *
   * Returns the assigned registry id.
   */
  async registerRepo(
    repoPath: string,
    opts: { name?: string; id?: string; embedder?: "hash" | "semantic" } = {}
  ): Promise<string> {
    const id = opts.id ?? makeRepoId(repoPath);
    const name = opts.name ?? id;
    const embedder = opts.embedder ?? "hash";

    // Open the graph
    const fh = await openFreehold({
      graphDir: repoPath,
      db: this.db,
      home: this.home,
      graphName: id,
      graphId: id,
      kind: "repo",
    });

    // Install and approve review ontology if not already present
    const schema = await describeSchema(fh.graph);
    const hasReview = schema.entityTypes.some((et) => et.name.startsWith("review/"));
    if (!hasReview) {
      const result = await installOntology(fh.graph, reviewOntologyYaml());
      // The ontology goes through the policy gate; approve it as the graph owner.
      if (result.status === "pending" && result.hash) {
        await approve(fh.graph, "owner", result.hash);
      }
    }

    // Read metadata
    const allodGraphId = readAllodGraphId(repoPath);
    let remote: string | null = null;
    try {
      remote = await originRemote(repoPath);
    } catch {
      // Not a git repo or no origin — that's fine
    }

    // Persist registry entry
    await this.db.pg.query(
      `INSERT INTO graphs (id, name, path, kind, auto_push_notes, embedder, allod_graph_id, origin_remote)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         path = EXCLUDED.path,
         embedder = EXCLUDED.embedder,
         allod_graph_id = EXCLUDED.allod_graph_id,
         origin_remote = EXCLUDED.origin_remote`,
      [id, name, repoPath, "repo", false, embedder, allodGraphId, remote]
    );

    // Cache the handle
    this.cache.set(id, fh);

    return id;
  }
}
