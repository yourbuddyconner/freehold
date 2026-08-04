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
 */

import { createHash } from "node:crypto";
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
 * Real semantic embedder using @huggingface/transformers.
 *
 * Model: Xenova/bge-small-en-v1.5 (384-dim, mean-pooled, L2-normalized).
 * Backend: WASM only — onnxruntime-node is redirected to onnxruntime-web via
 * the root pnpm override so no native .node binding is ever loaded.
 *
 * Lazy: the pipeline is created on first use and cached for subsequent calls.
 */
export const transformersEmbedder: Embedder = {
  async embed(texts: string[]): Promise<number[][]> {
    if (!_pipeline) {
      // Static-analysis-friendly dynamic import — TypeScript and bundlers can
      // resolve this to the installed @huggingface/transformers package without
      // attempting to load onnxruntime-node (blocked by the pnpm override).
      const { pipeline, env } = await import("@huggingface/transformers");

      // Force WASM backend — prevents any fallback to the native ORT binding.
      // env.backends.onnx.wasm is the canonical API for backend selection.
      if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }

      _pipeline = (await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
        dtype: "fp32",
      })) as unknown as FeaturePipeline;
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
 */
export function makeEmbedder(config: FreeholdConfig): Embedder {
  if (config.embedder === "hash") return hashEmbedder;
  return transformersEmbedder;
}
