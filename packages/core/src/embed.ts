/**
 * @freehold/core — Embedding layer
 *
 * Provides two embedders:
 *   - hashEmbedder: deterministic 384-dim vectors derived from sha256 (no deps, great for tests)
 *   - transformersEmbedder: real semantic embedder using @huggingface/transformers
 *     (Xenova/bge-small-en-v1.5, 384-dim, mean-pooled + L2-normalized)
 *
 * The onnxruntime-node native binary is suppressed via the root pnpm override:
 *   "onnxruntime-node": "npm:onnxruntime-web@^1.24.3"
 * This ensures only the WASM backend lands in the install tree.
 *
 * Node ESM compatibility:
 *   @huggingface/transformers bundles onnxruntime-web internally and — unless wasmPaths
 *   is pre-set — falls back to CDN URLs, then creates blob: URLs so the WASM factory can
 *   be imported.  Node's ESM loader rejects blob: URL imports.  The workaround (Attempt 1):
 *   set env.useWasmCache=false and env.backends.onnx.wasm.wasmPaths to file:// URLs
 *   pointing at the ort-web dist that ships alongside the transformers package in pnpm,
 *   so ORT loads the factory directly via a file: import (Node accepts those) and the
 *   blob creation path is never reached.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type { FreeholdConfig } from "./types.js";

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

// ---- Hash embedder ----

function sha256Bytes(text: string): Uint8Array {
  const hash = createHash("sha256").update(text).digest();
  return new Uint8Array(hash);
}

/**
 * Deterministic 384-dim embedder derived from sha256.
 *
 * Algorithm:
 *   1. Compute sha256(text) → 32 bytes
 *   2. Fill 384 dims: raw[i] = bytes[i % 32] / 128.0  (values in ~[-1, 1])
 *   3. Normalize to unit length
 */
function embedOne(text: string): number[] {
  const bytes = sha256Bytes(text);
  const dims = 384;
  const raw = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    raw[i] = bytes[i % 32] / 128.0;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm);
  const result: number[] = new Array(dims);
  for (let i = 0; i < dims; i++) result[i] = norm === 0 ? 0 : raw[i] / norm;
  return result;
}

export const hashEmbedder: Embedder = {
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(embedOne));
  },
};

// ---- Transformers embedder (lazy, WASM backend) ----

// Narrow type for the feature-extraction pipeline output we use.
type FeaturePipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let _pipeline: FeaturePipeline | null = null;

/**
 * Attempt 1: resolve the ort-web dist directory co-located with @huggingface/transformers
 * in the pnpm store, then return file:// URLs for the .mjs and .wasm factory files.
 *
 * @huggingface/transformers bundles onnxruntime-web internally but the bundled JS code
 * still needs the external .mjs WASM factory and .wasm binary from the matching ort-web
 * package.  In the pnpm store, that package lives as a peer of transformers and is
 * accessible via a createRequire rooted at the transformers dist directory.
 *
 * Uses CJS require resolution (createRequire) rather than import.meta.resolve because
 * vitest's transform pipeline may not forward import.meta.resolve to Node's native
 * resolver.  createRequire anchored to this file's own URL is always reliable.
 */
function resolveOrtWasmPaths(): { mjs: string; wasm: string } | null {
  try {
    // createRequire(import.meta.url) gives us a require() that resolves packages
    // visible from this source file — the same set that contains @huggingface/transformers.
    const selfReq = createRequire(import.meta.url);

    // Step 1: find the transformers package directory.
    // We use the main CJS entry which is always resolvable via require().
    // pnpm symlinks the package into packages/core/node_modules, so resolution
    // follows the symlink into the pnpm store.
    const tfEntry = selfReq.resolve("@huggingface/transformers");
    // tfEntry is …/transformers/dist/transformers.cjs (or similar); go up to dist/
    const tfDistDir = path.dirname(path.resolve(tfEntry));
    const tfDistReq = createRequire(`${tfDistDir}/`);

    // Step 2: from the transformers dist directory, resolve onnxruntime-web.
    // In pnpm, the ort-web version that transformers was built against lives as a
    // direct dep in the store and is visible from the transformers package directory.
    const ortWebEntry = tfDistReq.resolve("onnxruntime-web");
    const distDir = path.dirname(path.resolve(ortWebEntry));
    const mjs = `file://${distDir}/ort-wasm-simd-threaded.mjs`;
    const wasm = `file://${distDir}/ort-wasm-simd-threaded.wasm`;
    return { mjs, wasm };
  } catch {
    return null;
  }
}

/**
 * Real semantic embedder using @huggingface/transformers.
 *
 * Model: Xenova/bge-small-en-v1.5 (384-dim, mean-pooled, L2-normalized).
 * Backend: WASM only — onnxruntime-node is redirected to onnxruntime-web via
 * the root pnpm override so no native .node binding is ever loaded.
 *
 * Lazy: the pipeline is created on first use and cached for subsequent calls.
 */
// Set to true if @huggingface/transformers import failed at runtime; subsequent
// calls will skip the import attempt and fall back to hashEmbedder directly.
let _transformersFailed = false;

export const transformersEmbedder: Embedder = {
  async embed(texts: string[]): Promise<number[][]> {
    // If a previous call failed to import transformers, fall back immediately.
    if (_transformersFailed) {
      return hashEmbedder.embed(texts);
    }

    if (!_pipeline) {
      try {
        // Static-analysis-friendly dynamic import — TypeScript and bundlers can
        // resolve this to the installed @huggingface/transformers package without
        // attempting to load onnxruntime-node (blocked by the pnpm override).
        const { pipeline, env } = await import("@huggingface/transformers");

        // --- Attempt 1: file:// wasmPaths to bypass blob: URL creation -----------
        //
        // @huggingface/transformers bundles ort-web but falls back to CDN URLs when
        // wasmPaths is unset, then converts the downloaded factory to a blob: URL so
        // it can be dynamically import()-ed.  Node's ESM loader rejects blob: imports.
        //
        // Fix: pre-set wasmPaths to file:// URLs pointing at the ort-web dist that
        // pnpm installed alongside transformers.  This satisfies the "wasmPaths is set"
        // check so transformers skips the CDN path, and useWasmCache=false skips the
        // blob creation step.  ORT then does import("file:///…") which Node accepts.
        const ortPaths = resolveOrtWasmPaths();
        if (ortPaths && env.backends.onnx.wasm) {
          env.backends.onnx.wasm.wasmPaths = ortPaths;
          env.backends.onnx.wasm.numThreads = 1;
        } else if (env.backends.onnx.wasm) {
          env.backends.onnx.wasm.numThreads = 1;
        }
        // Disable WASM cache: this prevents loadWasmFactory() from creating a blob: URL
        // from the factory file content.  ORT will load the factory via direct import().
        env.useWasmCache = false;
        // -------------------------------------------------------------------------

        _pipeline = (await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
          dtype: "fp32",
        })) as unknown as FeaturePipeline;
      } catch (err) {
        process.stderr.write(
          `[freehold] warn: @huggingface/transformers unavailable (${String(err)}); falling back to hashEmbedder\n`
        );
        _transformersFailed = true;
        return hashEmbedder.embed(texts);
      }
    }

    const results: number[][] = [];
    for (const text of texts) {
      const output = await (_pipeline as FeaturePipeline)(text, {
        pooling: "mean",
        normalize: true,
      });
      // output.data is a Float32Array of length 384
      results.push(Array.from(output.data));
    }
    return results;
  },
};

// ---- Factory ----

/**
 * Pick the right embedder based on FreeholdConfig.
 *
 * Under a compiled bun binary, resolveOrtWasmPaths() returns null because the
 * pnpm store is not present at runtime.  In that case we fall back to
 * hashEmbedder and emit a warning so the operator knows semantic search is
 * degraded.  The transformersEmbedder also has its own import-time try/catch
 * for the same scenario.
 */
export function makeEmbedder(config: FreeholdConfig): Embedder {
  if (config.embedder === "hash") return hashEmbedder;
  const ortPaths = resolveOrtWasmPaths();
  if (ortPaths === null) {
    process.stderr.write(
      "[freehold] warn: ort-wasm paths not resolvable (compiled binary?); falling back to hashEmbedder\n"
    );
    return hashEmbedder;
  }
  return transformersEmbedder;
}
