import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AllodGraph } from "@allod/core";
import { createGraph, openGraph } from "./allod.js";
import { loadConfig } from "./config.js";
import { DEFAULT_GRAPH_ID, openDb } from "./db.js";
import type { DbHandle } from "./db.js";
import { ensureHome } from "./home.js";

// Internal construction key — prevents external code from calling _create
// without going through the module-internal factory.
const INTERNAL = Symbol("freehold.internal");

export class Freehold {
  graph: AllodGraph;
  db: DbHandle;
  readonly home: string;
  readonly graphName: string;
  readonly graphId: string;
  readonly kind: "memory" | "repo";
  /** Absolute path to the allod graph directory (contains .allod/). */
  readonly graphDir: string;

  /** @internal — use Freehold.open() or openFreehold() */
  constructor(
    key: typeof INTERNAL,
    graph: AllodGraph,
    db: DbHandle,
    home: string,
    graphName: string,
    graphId: string,
    kind: "memory" | "repo",
    graphDir: string
  ) {
    if (key !== INTERNAL) {
      throw new TypeError("Use Freehold.open() or openFreehold() to create instances.");
    }
    this.graph = graph;
    this.db = db;
    this.home = home;
    this.graphName = graphName;
    this.graphId = graphId;
    this.kind = kind;
    this.graphDir = graphDir;
  }

  static async open(home?: string): Promise<Freehold> {
    const h = ensureHome(home);
    const config = loadConfig(h);
    const graphName = config.graph ?? "main";
    const graphDir = join(h, "graphs", graphName);
    let graph: AllodGraph;
    if (existsSync(join(graphDir, ".allod", "graph.yaml"))) {
      graph = await openGraph(graphDir);
    } else {
      // Create new graph — owner defaults to "owner" until F5 (user identity setup)
      // wires the config's owner name (or interactive first-run) into this path.
      graph = await createGraph(graphDir, "owner");
    }
    const pgDir = join(h, "pg");
    const db = await openDb(pgDir);
    return new Freehold(INTERNAL, graph, db, h, graphName, DEFAULT_GRAPH_ID, "memory", graphDir);
  }
}

/**
 * Package-internal factory: open an existing allod graph at `graphDir` and
 * wrap it in a Freehold handle with the given metadata.
 *
 * Used by GraphManager to open registered graphs without going through
 * Freehold.open() (which always opens the home "main" graph).
 *
 * Not exported from index.ts — internal to the @freehold/core package.
 */
export async function openFreehold(opts: {
  graphDir: string;
  db: DbHandle;
  home: string;
  graphName: string;
  graphId: string;
  kind: "memory" | "repo";
}): Promise<Freehold> {
  const graph = await openGraph(opts.graphDir);
  return new Freehold(
    INTERNAL,
    graph,
    opts.db,
    opts.home,
    opts.graphName,
    opts.graphId,
    opts.kind,
    opts.graphDir
  );
}
