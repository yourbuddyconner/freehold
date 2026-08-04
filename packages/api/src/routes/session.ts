import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const sessionRouter = new Hono<AppEnv>();

/**
 * GET /api/v1/session
 *
 * Returns non-secret daemon config visible to an authenticated console user.
 * The bearer token is NOT echoed here — it is already available client-side
 * via the `<meta name="freehold-token">` tag injected at serve time.
 */
sessionRouter.get("/session", (c) => {
  const config = c.get("config");
  return c.json({
    defaultAgent: config.defaultAgent ?? null,
    embedder: config.embedder,
    port: config.port,
    // The graph's owner principal — the console signs owner edits as this name.
    // Graph creation currently hardcodes "owner" (see core/src/graphs.ts).
    owner: "owner",
  });
});
