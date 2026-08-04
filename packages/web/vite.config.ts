import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
  },
  server: {
    // Proxy API and MCP requests to the running daemon so `pnpm dev` works
    // alongside `freehold serve` without CORS issues or token wiring changes.
    proxy: {
      "/api": "http://127.0.0.1:8710",
      "/mcp": "http://127.0.0.1:8710",
    },
  },
});
