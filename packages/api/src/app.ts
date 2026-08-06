import path from "node:path";
import type { FreeholdConfig } from "@freehold/core";
import type { Embedder } from "@freehold/core";
import type { GraphManager } from "@freehold/core";
import { hashEmbedder } from "@freehold/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import { handleMcpRequest } from "./mcp.js";
import { getOpenApiDoc } from "./openapi.js";
import { codeRouter } from "./routes/code.js";
import { connectorCallbackRouter, connectorRouter } from "./routes/connector.js";
import { gitreviewRouter } from "./routes/gitreview.js";
import { governanceRouter } from "./routes/governance.js";
import { graphsRouter } from "./routes/graphs.js";
import { healthRouter } from "./routes/health.js";
import { knowledgeRouter } from "./routes/knowledge.js";
import { logRouter } from "./routes/log.js";
import { policyRouter } from "./routes/policy.js";
import { reposRouter } from "./routes/repos.js";
import { retrievalRouter } from "./routes/retrieval.js";
import { schemaRouter } from "./routes/schema.js";
import { sessionRouter } from "./routes/session.js";
import { githubWebhookRouter } from "./routes/webhook-github.js";
import type { AppEnv } from "./types.js";

/** Build the standard authenticated API sub-app (reused for default + scoped mounts). */
function buildApiRoutes(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.route("/", knowledgeRouter);
  api.route("/", retrievalRouter);
  api.route("/", governanceRouter);
  api.route("/", schemaRouter);
  api.route("/", policyRouter);
  api.route("/", logRouter);
  api.route("/", sessionRouter);
  api.route("/", codeRouter);
  api.route("/", connectorRouter);
  api.route("/", gitreviewRouter);
  return api;
}

export function createApp(
  manager: GraphManager,
  embedder: Embedder,
  config: FreeholdConfig,
  opts?: { fetchFn?: typeof fetch }
): Hono<AppEnv> {
  // Validate token is not empty at boot
  if (!config.token || config.token.trim() === "") {
    throw new Error("Freehold config.token must be a non-empty string at app creation time");
  }

  const app = new Hono<AppEnv>();

  // Global error handler — ensures any unhandled route error returns JSON
  // instead of an empty 500 body (Hono's default for Node adapter).
  app.onError((err, c) => {
    console.error("[freehold] unhandled error:", err);
    return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
  });

  // Inject context variables for all routes.
  // The default graph's Freehold handle is resolved here so every existing
  // route file continues to work via c.get("freehold") unmodified.
  app.use("*", async (c, next) => {
    c.set("manager", manager);
    c.set("embedder", embedder);
    c.set("config", config);
    if (opts?.fetchFn) c.set("fetchFn", opts.fetchFn);
    // Resolve default graph's Freehold handle (always "main")
    const defaultFh = await manager.get(manager.defaultId());
    c.set("freehold", defaultFh);
    await next();
  });

  // Open routes (no auth)
  app.route("/", healthRouter);
  // GitHub webhook — unauthenticated by bearer; HMAC-verified inside the handler.
  app.route("/", githubWebhookRouter);
  // GitHub App callback — unauthenticated by bearer; HMAC-signed state is the authenticator.
  app.route("/", connectorCallbackRouter);
  app.get("/api/v1/openapi.json", (c) => c.json(getOpenApiDoc()));

  // Authenticated API — default graph (unscoped, byte-identical behaviour)
  const api = new Hono<AppEnv>();
  api.use("*", bearerAuth(config.token));
  api.route("/", buildApiRoutes());
  // Graphs registry routes (unscoped — operate on the manager, not a single graph)
  api.route("/", graphsRouter);
  // Repo onboarding (unscoped — operates on the manager, allodBin, and filesystem)
  api.route("/", reposRouter);

  app.route("/api/v1", api);

  // Graph-scoped mount: /api/v1/graphs/:graphId/*
  // The resolver middleware looks up :graphId and sets c.set("freehold", ...)
  // for that specific graph. All API routes are then re-served under this mount.
  //
  // Routing invariant: scopedApi's /:graphId/* wildcard only matches paths with
  // a segment after the graph id (e.g. /main/memories). Bare /:graphId paths
  // (e.g. PATCH /api/v1/graphs/main, DELETE /api/v1/graphs/main) fall through to
  // graphsRouter on the main api sub-app, which handles them correctly.
  //
  // Note: sessionRouter is included in buildApiRoutes() and is therefore
  // reachable at /api/v1/graphs/:id/session. This is harmless — session is
  // read-only and manager-scoped, so graph selection has no effect on its
  // output — but callers should prefer the canonical /api/v1/session.
  const scopedApi = new Hono<AppEnv>();
  scopedApi.use("*", bearerAuth(config.token));
  scopedApi.use("/:graphId/*", async (c, next) => {
    const graphId = c.req.param("graphId");
    try {
      const fh = await manager.get(graphId);
      // Select embedder based on graph kind/embedder setting
      const entry = await manager.getEntry(graphId);
      const graphEmbedder = entry?.embedder === "hash" ? hashEmbedder : embedder;
      c.set("freehold", fh);
      c.set("embedder", graphEmbedder);
    } catch {
      return c.json({ error: "unknown graph" }, 404);
    }
    await next();
  });

  // Mount all standard API routes under the scoped path
  scopedApi.route("/:graphId", buildApiRoutes());

  app.route("/api/v1/graphs", scopedApi);

  // MCP endpoint — bearer auth via shared middleware, then streamable HTTP.
  // Pass manager so tools can resolve the graph param.
  app.use("/mcp", bearerAuth(config.token));
  app.all("/mcp", (c) => handleMcpRequest(manager, embedder, config, c.req.raw));

  // Console static serving — reads dist/index.html and injects the bearer
  // token as a meta tag so the browser console can authenticate without
  // exposing the token in JS source or localStorage.
  //
  // Path is relative to the compiled output in packages/api/dist/:
  //   packages/api/dist/app.js → ../../web/dist → packages/web/dist
  const webDistPath = new URL("../../web/dist", import.meta.url).pathname;

  // Cache the injected index.html after the first successful read so the
  // filesystem is not hit on every request.
  let cachedHtml: string | null = null;

  async function serveIndex(c: Context<AppEnv>): Promise<Response> {
    // Security: only serve the token-bearing HTML to localhost clients.
    // Reject requests with a Host header pointing to a non-local origin.
    const host = c.req.header("host") ?? "localhost";
    const hostName = host.split(":")[0].toLowerCase();
    const isLocal =
      hostName === "localhost" ||
      hostName === "127.0.0.1" ||
      hostName === "::1" ||
      hostName === "0.0.0.0";
    if (!isLocal) {
      return new Response("Forbidden: console only accessible from localhost", { status: 403 });
    }

    try {
      if (cachedHtml === null) {
        const { readFile } = await import("node:fs/promises");
        const html = await readFile(path.join(webDistPath, "index.html"), "utf-8");

        // Replace or inject the freehold-token meta tag using a regex that
        // matches any existing meta tag with that name, regardless of spacing or content.
        const metaTagRegex = /<meta\s+name="freehold-token"[^>]*>/i;
        const newMetaTag = `<meta name="freehold-token" content="${config.token}" />`;

        if (metaTagRegex.test(html)) {
          // Replace the existing meta tag
          cachedHtml = html.replace(metaTagRegex, newMetaTag);
        } else {
          // Meta tag not found — inject it into <head>
          const headEndRegex = /<\/head>/i;
          if (headEndRegex.test(html)) {
            cachedHtml = html.replace(headEndRegex, `  ${newMetaTag}\n  </head>`);
          } else {
            // No </head> found — fallback to appending to start of html
            cachedHtml = `${newMetaTag}\n${html}`;
          }
        }
      }
      return c.html(cachedHtml);
    } catch {
      // dist not built yet — placeholder fallback
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
  }

  app.get("/", (c) => serveIndex(c));

  // Serve static assets from web/dist.
  // Security: resolve the full path and verify it stays within webDistPath
  // before reading — prevents path traversal via `..` segments in the URL.
  // Caching: Vite produces content-hashed filenames, so assets can be cached
  // indefinitely by browsers.
  app.get("/assets/*", async (c) => {
    try {
      const { readFile } = await import("node:fs/promises");
      // Strip the leading `/` so path.resolve treats it as relative to webDistPath
      const filePath = path.resolve(webDistPath, c.req.path.slice(1));
      if (!filePath.startsWith(webDistPath + path.sep)) {
        return c.notFound();
      }
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
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    } catch {
      return c.notFound();
    }
  });

  // SPA catch-all: serve index.html for any non-API, non-MCP path so that
  // hard refreshes and direct deep-links work with TanStack Router's History
  // API routing. Unknown /api/* and /mcp paths return 404 so they don't
  // silently serve HTML when a client misses a route.
  app.get("*", (c) => {
    const p = c.req.path;
    if (p.startsWith("/api/") || p === "/api" || p === "/mcp" || p.startsWith("/mcp/")) {
      return c.notFound();
    }
    return serveIndex(c);
  });

  return app;
}
