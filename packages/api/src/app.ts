import path from "node:path";
import type { FreeholdConfig } from "@freehold/core";
import type { Embedder } from "@freehold/core";
import type { Freehold } from "@freehold/core";
import type { Context } from "hono";
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
import { sessionRouter } from "./routes/session.js";
import type { AppEnv } from "./types.js";

export function createApp(
  freehold: Freehold,
  embedder: Embedder,
  config: FreeholdConfig
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
  api.route("/", sessionRouter);

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
