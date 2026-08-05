import { basename } from "node:path";
import { codeFile, codeItem, codeNeighborhood, codeRegions, codeTree } from "@freehold/core";
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

// GET /code/neighborhood?path=
codeRouter.get("/code/neighborhood", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }
  const path = c.req.query("path");
  if (!path) {
    return c.json({ error: "path query parameter is required" }, 400);
  }
  const neighborhood = await codeNeighborhood(fh, path);
  return c.json(neighborhood);
});

// GET /code/regions
codeRouter.get("/code/regions", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }
  // Resolve repoName from the graph directory basename, which is the repository name
  // that policy rules use in their repo: selector. graphName is the registry id and
  // does not correspond to the filesystem name the policy was written against.
  const repoName = basename(fh.graphDir);
  const rules = await codeRegions(fh, repoName);
  return c.json({ rules });
});
