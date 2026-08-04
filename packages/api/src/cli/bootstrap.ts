/**
 * Runs before any @allod/core import (this module is the first import of
 * the CLI entrypoint, and ESM evaluates imports in order).
 *
 * When freehold runs as a compiled binary, @allod/core's wasm loader
 * cannot use its bundled __dirname (Bun bakes the build machine's path).
 * The loader honors ALLOD_WASM_PATH, and compile-binary.mjs ships the
 * wasm as a sidecar next to the binary — point the loader at it.
 * In a source checkout the sidecar doesn't exist and the loader's own
 * __dirname path works, so this is a no-op.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

if (!process.env.ALLOD_WASM_PATH) {
  const sidecar = join(dirname(process.execPath), "freehold.allod.wasm");
  if (existsSync(sidecar)) {
    process.env.ALLOD_WASM_PATH = sidecar;
  }
}
