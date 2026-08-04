import {
  approve,
  pending,
  principals,
  registerAgent,
  reindex,
  reject,
  syncIndex,
  verifyGraph,
} from "@freehold/core";
import { Hono } from "hono";
import { z } from "zod";
import { ERROR_CODES, apiError } from "../errors.js";
import type { AppEnv } from "../types.js";

export const governanceRouter = new Hono<AppEnv>();

governanceRouter.get("/proposals", (c) => {
  const fh = c.get("freehold");
  const proposals = pending(fh.graph);
  return c.json({ proposals });
});

governanceRouter.post("/proposals/:hash/approve", async (c) => {
  const hash = c.req.param("hash");
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  // SAFETY: single-token model — bearer possession implies owner authority until multi-principal auth lands (post-v0).
  const result = await approve(fh.graph, "owner", hash);
  if (result.status === "admitted") {
    await syncIndex(fh, embedder);
  }
  return c.json(result);
});

governanceRouter.post("/proposals/:hash/reject", async (c) => {
  const hash = c.req.param("hash");
  const fh = c.get("freehold");
  // SAFETY: single-token model — bearer possession implies owner authority until multi-principal auth lands (post-v0).
  const result = await reject(fh.graph, "owner", hash);
  return c.json(result);
});

governanceRouter.get("/verify", (c) => {
  const fh = c.get("freehold");
  const report = verifyGraph(fh.graph);
  return c.json(report);
});

governanceRouter.post("/reindex", async (c) => {
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  await reindex(fh, embedder);
  return c.json({ status: "ok" });
});

governanceRouter.get("/principals", (c) => {
  const fh = c.get("freehold");
  const list = principals(fh.graph);
  return c.json({ principals: list });
});

const RegisterAgentBody = z.object({
  name: z.string(),
});

governanceRouter.post("/agents", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = RegisterAgentBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const fh = c.get("freehold");
  // SAFETY: single-token model — bearer possession implies owner authority until multi-principal auth lands (post-v0).
  const result = await registerAgent(fh.graph, parsed.data.name, "owner");
  return c.json(result);
});
