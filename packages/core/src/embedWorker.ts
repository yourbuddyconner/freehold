/**
 * Worker-thread entry for the transformers embedder.
 *
 * The ONNX model load and every embedding run inside this worker, so the
 * daemon's event loop never blocks on embedding work. Messages:
 *   in:  { id, texts: string[] }
 *   out: { id, vectors: number[][] } | { id, error: string }
 *
 * Runs as compiled JS (dist) or directly as TS under Node's type stripping,
 * so this file sticks to erasable TypeScript syntax.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { parentPort } from "node:worker_threads";

type FeaturePipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let pipelinePromise: Promise<FeaturePipeline> | null = null;

function resolveOrtWasmPaths(): { mjs: string; wasm: string } | null {
  try {
    const selfReq = createRequire(import.meta.url);
    const tfEntry = selfReq.resolve("@huggingface/transformers");
    const tfDistDir = path.dirname(path.resolve(tfEntry));
    const tfDistReq = createRequire(`${tfDistDir}/`);
    const ortWebEntry = tfDistReq.resolve("onnxruntime-web");
    const distDir = path.dirname(path.resolve(ortWebEntry));
    return {
      mjs: `file://${distDir}/ort-wasm-simd-threaded.mjs`,
      wasm: `file://${distDir}/ort-wasm-simd-threaded.wasm`,
    };
  } catch {
    return null;
  }
}

async function loadPipeline(): Promise<FeaturePipeline> {
  const { pipeline, env } = await import("@huggingface/transformers");
  const ortPaths = resolveOrtWasmPaths();
  if (env.backends.onnx.wasm) {
    if (ortPaths) {
      env.backends.onnx.wasm.wasmPaths = ortPaths;
    }
    env.backends.onnx.wasm.numThreads = 1;
  }
  env.useWasmCache = false;
  return (await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
    dtype: "fp32",
  })) as unknown as FeaturePipeline;
}

interface EmbedRequest {
  id: number;
  texts: string[];
}

parentPort?.on("message", async (msg: EmbedRequest) => {
  try {
    if (!pipelinePromise) pipelinePromise = loadPipeline();
    const pipe = await pipelinePromise;
    const vectors: number[][] = [];
    for (const text of msg.texts) {
      const output = await pipe(text, { pooling: "mean", normalize: true });
      vectors.push(Array.from(output.data));
    }
    parentPort?.postMessage({ id: msg.id, vectors });
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: String(err) });
  }
});
