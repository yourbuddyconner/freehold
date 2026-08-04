import type { LoggableGraph } from "@freehold/core";
import { withGraph } from "@freehold/core";
import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const logRouter = new Hono<AppEnv>();

// GET /log
logRouter.get("/log", async (c) => {
  const fh = c.get("freehold");
  const entries = await withGraph(fh.graph, () => (fh.graph as unknown as LoggableGraph).log());
  return c.json({ entries });
});
