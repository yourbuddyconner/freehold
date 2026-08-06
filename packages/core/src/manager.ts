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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";
import { createGraph } from "./allod.js";
import { loadConfig } from "./config.js";
import { DEFAULT_GRAPH_ID, openDb } from "./db.js";
import type { DbHandle } from "./db.js";
import { hashEmbedder } from "./embed.js";
import { originRemote } from "./git.js";
import { approve } from "./governance.js";
import type { Freehold } from "./graphs.js";
import { openFreehold } from "./graphs.js";
import { ensureHome } from "./home.js";
import { syncIndex } from "./indexer.js";
import { describeSchema, installOntology } from "./schema.js";

export interface GraphEntry {
  id: string;
  name: string;
  path: string;
  kind: "memory" | "repo";
  autoPushNotes: boolean;
  embedder: "hash" | "semantic";
  allodGraphId: string;
  originRemote: string | null;
  signingPrincipal: string;
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
 * Generate a deterministic registry slug from a repo path.
 * Uses the basename; sanitizes to [a-z0-9_-].
 */
function makeRepoId(path: string): string {
  return basename(path)
    .replace(/[^a-z0-9_-]/gi, "-")
    .toLowerCase();
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
  signing_principal: string | null;
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
    signingPrincipal: row.signing_principal ?? "owner",
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
    const existing = await db.pg.query<{ id: string }>("SELECT id FROM graphs WHERE id = $1", [
      DEFAULT_GRAPH_ID,
    ]);
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
      signing_principal: string | null;
    }>("SELECT * FROM graphs WHERE id = $1", [id]);
    if (result.rows.length === 0) return null;
    return rowToEntry(result.rows[0]);
  }

  /**
   * Return the registry entry for a graph id.
   * Throws if the id is not registered.
   */
  async entry(id: string): Promise<GraphEntry> {
    const e = await this.getEntry(id);
    if (!e) throw new Error(`graph not registered: ${id}`);
    return e;
  }

  /**
   * Returns the default graph id ("main").
   */
  defaultId(): string {
    return DEFAULT_GRAPH_ID;
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
      signing_principal: string | null;
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
      // Re-verify: a concurrent remove() may have evicted this id while _open was awaited.
      // If so, discard the handle and throw rather than caching a resurrected entry.
      if (!this.inFlight.has(id)) {
        throw new Error(`Graph not registered: ${id} (removed during open)`);
      }
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
   * Update mutable settings for a registered graph.
   * Throws if the id is not registered.
   */
  async updateSettings(
    id: string,
    patch: Partial<Pick<GraphEntry, "name" | "autoPushNotes" | "embedder">>
  ): Promise<GraphEntry> {
    const e = await this.entry(id); // throws on unknown id
    const newName = patch.name ?? e.name;
    const newAutoPushNotes = patch.autoPushNotes ?? e.autoPushNotes;
    const newEmbedder = patch.embedder ?? e.embedder;
    await this.db.pg.query(
      "UPDATE graphs SET name = $1, auto_push_notes = $2, embedder = $3 WHERE id = $4",
      [newName, newAutoPushNotes, newEmbedder, id]
    );
    return this.entry(id);
  }

  /**
   * Remove a registered repo graph from the registry.
   * Throws if the id is not registered, or if it is the default graph.
   * Does NOT delete any files on disk.
   */
  async remove(id: string): Promise<void> {
    if (id === DEFAULT_GRAPH_ID) throw new Error(`cannot remove the default graph: ${id}`);
    await this.entry(id); // throws if not registered
    const { pg } = this.db;
    // Delete graph-scoped index rows
    await pg.query("DELETE FROM objects WHERE graph_id = $1", [id]);
    await pg.query("DELETE FROM graph_edges WHERE graph_id = $1", [id]);
    await pg.query("DELETE FROM node_terms WHERE graph_id = $1", [id]);
    await pg.query("DELETE FROM meta WHERE graph_id = $1 AND key = 'indexed_head'", [id]);
    // Delete registry row
    await pg.query("DELETE FROM graphs WHERE id = $1", [id]);
    // Evict cached handle
    this.cache.delete(id);
    this.inFlight.delete(id);
  }

  /**
   * Register an existing repo checkout as a graph.
   * Validates the path has .allod/graph.yaml, opens the graph, installs the
   * review ontology if not present, records the origin remote, persists the
   * entry, and runs the indexer.
   *
   * Throws if the path is not an allod graph or if the id is already registered.
   * Returns the full GraphEntry.
   */
  async registerRepo(
    repoPath: string,
    opts: {
      name?: string;
      id?: string;
      embedder?: "hash" | "semantic";
      signingPrincipal?: string;
    } = {}
  ): Promise<GraphEntry> {
    // Validate .allod/graph.yaml exists BEFORE opening
    if (!existsSync(join(repoPath, ".allod", "graph.yaml"))) {
      throw new Error(`not an allod graph: no .allod/graph.yaml at ${repoPath}`);
    }

    const id = opts.id ?? makeRepoId(repoPath);
    const name = opts.name ?? id;
    const embedder = opts.embedder ?? "hash";
    const signingPrincipal = opts.signingPrincipal ?? "owner";

    // Check registry — reject duplicates BEFORE any side effects
    const existing = await this.db.pg.query<{ id: string }>("SELECT id FROM graphs WHERE id = $1", [
      id,
    ]);
    if (existing.rows.length > 0) {
      throw new Error(`graph id already registered: ${id}`);
    }

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

    // Persist registry entry (no ON CONFLICT needed — we already checked above)
    await this.db.pg.query(
      `INSERT INTO graphs (id, name, path, kind, auto_push_notes, embedder, allod_graph_id, origin_remote, signing_principal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, name, repoPath, "repo", false, embedder, allodGraphId, remote, signingPrincipal]
    );

    // Cache the handle
    this.cache.set(id, fh);

    // Run the indexer after registration
    await syncIndex(fh, hashEmbedder);

    return this.entry(id);
  }
}
