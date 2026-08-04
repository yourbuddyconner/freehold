import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const logRouter = new Hono<AppEnv>();

// GET /log
logRouter.get("/log", (c) => {
  const fh = c.get("freehold");
  // biome-ignore lint/suspicious/noExplicitAny: log() returns untyped entries
  const entries = ((fh.graph as any).log?.() as unknown[]) ?? [];
  return c.json({ entries });
});
