/**
 * @freehold/core — Embedding layer
 *
 * Provides two embedders:
 *   - hashEmbedder: deterministic 384-dim vectors derived from sha256 (no deps, great for tests)
 *   - transformersEmbedder: lazy-loaded via @huggingface/transformers (Xenova/bge-small-en-v1.5)
 *
 * NOTE: @huggingface/transformers is NOT installed as a dependency because it
 * transitively pulls in onnxruntime-node (a native binary). If you need the
 * transformers embedder, install @huggingface/transformers manually and make
 * sure it resolves to the WASM backend (onnxruntime-web), not the native one.
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

// ---- Transformers embedder (lazy, optional dep) ----

type PipelineFn = (text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>;

let _pipeline: PipelineFn | null = null;

/**
 * Lazy-loaded embedder using @huggingface/transformers.
 *
 * Requires `@huggingface/transformers` to be installed (it is NOT a declared
 * dependency of this package because it pulls in native binaries). Install it
 * manually if you need this embedder:
 *
 *   pnpm add @huggingface/transformers
 *
 * Uses model: Xenova/bge-small-en-v1.5, task: feature-extraction.
 */
export const transformersEmbedder: Embedder = {
  async embed(texts: string[]): Promise<number[][]> {
    if (!_pipeline) {
      // Dynamic import so the module only loads when actually used.
      // @huggingface/transformers is an optional runtime dependency — not declared
      // in package.json because it transitively pulls in onnxruntime-node.
      // Install it manually if you need this embedder.
      // Indirect import via Function() prevents static analysis from resolving the optional dep.
      const mod = (await Function("m", "return import(m)")("@huggingface/transformers")) as {
        pipeline: (
          task: string,
          model: string,
          opts?: Record<string, unknown>
        ) => Promise<PipelineFn>;
      };
      _pipeline = await mod.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
        dtype: "fp32",
      });
    }

    const results: number[][] = [];
    for (const text of texts) {
      const output = await (_pipeline as PipelineFn)(text, { pooling: "mean", normalize: true });
      // output.data is a Float32Array
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
