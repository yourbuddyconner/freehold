import { basename } from "node:path";
import {
  CodeCommentKeyMissingError,
  PathTraversalError,
  codeFile,
  codeItem,
  codeNeighborhood,
  codeRegions,
  codeSource,
  codeTree,
  listCodeComments,
  postCodeComment,
} from "@freehold/core";
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

// GET /code/comments?path=
codeRouter.get("/code/comments", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }
  const path = c.req.query("path");
  if (!path) {
    return c.json({ error: "path query parameter is required" }, 400);
  }
  const comments = await listCodeComments(fh, path);
  return c.json({ comments });
});

// POST /code/comments
codeRouter.post("/code/comments", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const body = rawBody as Record<string, unknown>;
  const { path, span, body: commentBody, by } = body;

  if (typeof path !== "string" || !path) {
    return c.json({ error: "path is required" }, 400);
  }
  if (typeof span !== "string" || !span) {
    return c.json({ error: "span is required" }, 400);
  }
  if (typeof commentBody !== "string" || !commentBody) {
    return c.json({ error: "body is required" }, 400);
  }
  if (typeof by !== "string" || !by) {
    return c.json({ error: "by is required" }, 400);
  }

  try {
    const result = await postCodeComment(fh, {
      path,
      span,
      body: commentBody,
      by,
    });
    return c.json(result);
  } catch (err: unknown) {
    if (err instanceof CodeCommentKeyMissingError) {
      return c.json({ error: `no signing key for ${by}`, code: "key-missing" }, 409);
    }
    throw err;
  }
});

// GET /code/source?path=
codeRouter.get("/code/source", async (c) => {
  const fh = c.get("freehold");
  if (!repoOnly(fh)) {
    return c.json({ error: "code view is only available for repo graphs" }, 400);
  }
  const path = c.req.query("path");
  if (!path) {
    return c.json({ error: "path query parameter is required" }, 400);
  }
  let source: Awaited<ReturnType<typeof codeSource>>;
  try {
    source = await codeSource(fh, path);
  } catch (err: unknown) {
    if (err instanceof PathTraversalError) {
      return c.json({ error: "invalid path" }, 400);
    }
    throw err;
  }
  if (!source) {
    return c.json({ error: "file not found" }, 404);
  }
  return c.json(source);
});
