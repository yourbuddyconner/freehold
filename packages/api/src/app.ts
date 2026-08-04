import type { FreeholdConfig } from "@freehold/core";
import type { Embedder } from "@freehold/core";
import type { Freehold } from "@freehold/core";
import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
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

  // MCP mount — F6 will replace this stub
  app.all("/mcp/*", (c) => {
    return c.json(
      { error: { code: "not_implemented", message: "MCP endpoint arrives in F6" } },
      501
    );
  });

  // Console static serving — F7 will replace this stub
  app.get("/", (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Freehold</title></head>
<body>
  <h1>Freehold</h1>
  <p>The owner console arrives in F7. Use the API at <code>/api/v1</code>.</p>
</body>
</html>`);
  });

  return app;
}
