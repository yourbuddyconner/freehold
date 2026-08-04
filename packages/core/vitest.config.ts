import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    include: ["tests/**/*.test.ts"],
    // PGlite + WASM cold starts are slow on CI runners
    testTimeout: 30_000,
  },
});
