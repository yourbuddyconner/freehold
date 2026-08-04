import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AllodGraph } from "@allod/core";
import { createGraph, openGraph } from "./allod.js";
import { loadConfig } from "./config.js";
import { ensureHome } from "./home.js";

export class Freehold {
  graph: AllodGraph;
  readonly home: string;
  readonly graphName: string;

  private constructor(graph: AllodGraph, home: string, graphName: string) {
    this.graph = graph;
    this.home = home;
    this.graphName = graphName;
  }

  static async open(home?: string): Promise<Freehold> {
    const h = ensureHome(home);
    const config = loadConfig(h);
    const graphName = config.graph ?? "main";
    const graphDir = join(h, "graphs", graphName);
    let graph: AllodGraph;
    if (existsSync(join(graphDir, ".allod", "log"))) {
      graph = await openGraph(graphDir);
    } else {
      // Create new graph — owner defaults to "owner" until F5 (user identity setup)
      // wires the config's owner name (or interactive first-run) into this path.
      graph = await createGraph(graphDir, "owner");
    }
    return new Freehold(graph, h, graphName);
  }
}
