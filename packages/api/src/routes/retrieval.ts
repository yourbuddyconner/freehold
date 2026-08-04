import {
  getEntity,
  memoryGraph,
  memoryIndex,
  recall,
  recentMemories,
  traverse,
} from "@freehold/core";
import { Hono } from "hono";
import { ERROR_CODES, apiError } from "../errors.js";
import type { AppEnv } from "../types.js";

export const retrievalRouter = new Hono<AppEnv>();

retrievalRouter.get("/recall", async (c) => {
  const q = c.req.query("q") ?? "";
  const type = c.req.query("type");
  const author = c.req.query("author");
  const status = c.req.query("status");
  if (!q) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Query parameter 'q' is required");
  }
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  const filters = {
    type: type ?? undefined,
    author: author ?? undefined,
    // `status` query param maps to `approval` field in RecallFilters/RecallResult
    approval: status ?? undefined,
  };
  const results = await recall(fh, q, embedder, filters);
  return c.json({ results });
});

retrievalRouter.get("/memories", async (c) => {
  if (c.req.query("scope") === "all") {
    const fh = c.get("freehold");
    const results = await memoryIndex(fh);
    return c.json({ results });
  }
  const type = c.req.query("type");
  const author = c.req.query("author");
  const status = c.req.query("status");
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Math.min(Number(limitRaw) || 50, 200) : 50;
  const fh = c.get("freehold");
  const results = await recentMemories(
    fh,
    {
      type: type ?? undefined,
      author: author ?? undefined,
      approval: status ?? undefined,
    },
    limit
  );
  return c.json({ results });
});

retrievalRouter.get("/graph", async (c) => {
  const fh = c.get("freehold");
  const view = await memoryGraph(fh);
  return c.json(view);
});

retrievalRouter.get("/entities/:id", async (c) => {
  const id = c.req.param("id");
  const fh = c.get("freehold");
  const entity = await getEntity(fh.graph, id);
  if (!entity) {
    return apiError(c, 404, ERROR_CODES.NOT_FOUND, `Entity '${id}' not found`);
  }
  return c.json(entity);
});

retrievalRouter.get("/entities/:id/traverse", async (c) => {
  const id = c.req.param("id");
  const edgeTypesRaw = c.req.query("edgeTypes");
  const direction = (c.req.query("direction") ?? "out") as "out" | "in" | "both";
  const depthRaw = c.req.query("depth");
  const depth = depthRaw ? Number.parseInt(depthRaw, 10) : 1;
  const edgeTypes = edgeTypesRaw ? edgeTypesRaw.split(",") : undefined;
  const fh = c.get("freehold");
  const results = await traverse(fh.graph, id, edgeTypes, direction, depth);
  return c.json({ results });
});
