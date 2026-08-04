import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const healthRouter = new Hono<AppEnv>();

healthRouter.get("/health", (c) => {
  return c.json({ status: "ok" });
});
