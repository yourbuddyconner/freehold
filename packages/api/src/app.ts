import path from "node:path";
import type { FreeholdConfig } from "@freehold/core";
import type { Embedder } from "@freehold/core";
import type { Freehold } from "@freehold/core";
import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import { handleMcpRequest } from "./mcp.js";
import { getOpenApiDoc } from "./openapi.js";
import { governanceRouter } from "./routes/governance.js";
import { healthRouter } from "./routes/health.js";
import { knowledgeRouter } from "./routes/knowledge.js";
import { logRouter } from "./routes/log.js";
import { policyRouter } from "./routes/policy.js";
import { retrievalRouter } from "./routes/retrieval.js";
import { schemaRouter } from "./routes/schema.js";
import type { AppEnv } from "./types.js";

export function createApp(
  freehold: Freehold,
  embedder: Embedder,
  config: FreeholdConfig
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Inject context variables for all routes
  app.use("*", async (c, next) => {
    c.set("freehold", freehold);
    c.set("embedder", embedder);
    c.set("config", config);
    await next();
  });

  // Open routes (no auth)
  app.route("/", healthRouter);
  app.get("/api/v1/openapi.json", (c) => c.json(getOpenApiDoc()));

  // Authenticated API routes
  const api = new Hono<AppEnv>();
  api.use("*", bearerAuth(config.token));
  api.route("/", knowledgeRouter);
  api.route("/", retrievalRouter);
  api.route("/", governanceRouter);
  api.route("/", schemaRouter);
  api.route("/", policyRouter);
  api.route("/", logRouter);

  app.route("/api/v1", api);

  // MCP endpoint — bearer auth via shared middleware, then streamable HTTP
  app.use("/mcp", bearerAuth(config.token));
  app.all("/mcp", (c) => handleMcpRequest(freehold, embedder, config, c.req.raw));

  // Console static serving — reads dist/index.html and injects the bearer
  // token as a meta tag so the browser console can authenticate without
  // exposing the token in JS source or localStorage.
  //
  // Path is relative to the compiled output in packages/api/dist/:
  //   packages/api/dist/app.js → ../../web/dist → packages/web/dist
  const webDistPath = new URL("../../web/dist", import.meta.url).pathname;

  app.get("/", async (c) => {
    try {
      const { readFile } = await import("node:fs/promises");
      const html = await readFile(path.join(webDistPath, "index.html"), "utf-8");
      const injected = html.replace(
        '<meta name="freehold-token" content="">',
        `<meta name="freehold-token" content="${config.token}">`
      );
      return c.html(injected);
    } catch {
      // dist not built yet — F7 placeholder
      return c.html(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Freehold</title></head>
<body>
  <h1>Freehold</h1>
  <p>Console not built. Run <code>pnpm --filter @freehold/web build</code> first.</p>
  <p>Use the API at <code>/api/v1</code>.</p>
</body>
</html>`);
    }
  });

  // Serve static assets from web/dist
  app.get("/assets/*", async (c) => {
    try {
      const { readFile } = await import("node:fs/promises");
      const filePath = path.join(webDistPath, c.req.path);
      const data = await readFile(filePath);
      const ext = filePath.split(".").pop() ?? "";
      const contentTypes: Record<string, string> = {
        js: "application/javascript",
        css: "text/css",
        html: "text/html",
        svg: "image/svg+xml",
        png: "image/png",
        ico: "image/x-icon",
        woff2: "font/woff2",
        woff: "font/woff",
      };
      return c.body(data, 200, {
        "Content-Type": contentTypes[ext] ?? "application/octet-stream",
      });
    } catch {
      return c.notFound();
    }
  });

  return app;
}
