import type { LoggableGraph } from "@freehold/core";
import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const logRouter = new Hono<AppEnv>();

// GET /log
logRouter.get("/log", (c) => {
  const fh = c.get("freehold");
  const entries = (fh.graph as unknown as LoggableGraph).log();
  return c.json({ entries });
});
