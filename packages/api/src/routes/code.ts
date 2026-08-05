import { codeFile, codeItem, codeRegions, codeTree } from "@freehold/core";
import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const codeRouter = new Hono<AppEnv>();

/** Guard: code view is only available for repo graphs. */
function repoOnly(fh: { kind: string }): boolean {
  return fh.kind === "repo";
}

// GET /code/tree
codeRouter.get("/code/tree", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }
  const tree = await codeTree(fh);
  return c.json({ tree });
});

// GET /code/file?path=
codeRouter.get("/code/file", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }
  const path = c.req.query("path");
  if (!path) {
    return c.json({ error: "path query parameter is required" }, 400);
  }
  const file = await codeFile(fh, path);
  if (!file) {
    return c.json({ error: "not indexed", hint: "run: allod git index" }, 404);
  }
  return c.json(file);
});

// GET /code/item/:nodeId
codeRouter.get("/code/item/:nodeId", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }
  const nodeId = c.req.param("nodeId");
  const item = await codeItem(fh, nodeId);
  if (!item) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(item);
});

// GET /code/regions
codeRouter.get("/code/regions", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }
  // Resolve repoName from the graph entry basename (path basename is the repo name)
  // codeRegions defaults to "repo" if no repoName is provided; for a registered graph
  // we use the graphName which is set to the basename of the path.
  const repoName = fh.graphName ?? "repo";
  const rules = await codeRegions(fh, repoName);
  return c.json({ rules });
});
