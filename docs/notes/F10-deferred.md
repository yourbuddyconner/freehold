# F10 Deferred Items

## Binary: semantic embedder not available in compiled binary

**Decision:** The v0 compiled binary (`packages/api/dist/freehold`) ships with
hash-embedder-only for semantic search.

**Why:** The `transformersEmbedder` uses `createRequire(import.meta.url)` to
resolve ORT-WASM paths from the pnpm store at runtime. Under `bun --compile`,
`import.meta.url` resolves into the virtual `/$bunfs/` filesystem, not a real
node_modules tree. `resolveOrtWasmPaths()` catches this and returns `null`;
`makeEmbedder()` then falls back to `hashEmbedder` with a stderr warning.

**Impact:** Semantic recall (cosine similarity over bge-small embeddings) is
unavailable from the binary. Hybrid BM25+vector search degrades to BM25+hash
vectors (still functionally correct; hash vectors are deterministic and recall
works, but semantic similarity is random). The transformers embedder works
normally when running from source via `tsx src/cli/index.ts serve`.

**Path forward:** Bundle the ONNX WASM binary as a bun asset and pre-initialize
the pipeline path before `bun --compile` eliminates the pnpm store reference.
Blocked on bun's handling of dynamic import() for WASM factory files inside a
compiled bundle — requires a dedicated bun issue or workaround.

## Binary: sidecar deployment required

The compiled binary requires 4 sidecar files in the same directory:

```
dist/freehold                   (standalone binary, ~61MB)
dist/freehold.pglite.wasm       (PGlite WASM engine)
dist/freehold.pglite.data       (PGlite FS bundle, postgres base files)
dist/freehold.initdb.wasm       (PGlite initdb WASM)
dist/freehold.vector.tar.gz     (pgvector extension bundle)
```

`compile-binary.mjs` copies these automatically. `allod_wasm_bg.wasm` is
embedded automatically by bun's bundler (it follows `readFileSync(__dirname +
'/...')` adjacency).

## pi-agent E2E: real-LLM variant gated behind FREEHOLD_E2E_LLM=1

The `e2e-agent.test.ts` uses `registerFauxProvider` for the deterministic
path. The real-LLM path (`FREEHOLD_E2E_LLM=1 + ANTHROPIC_API_KEY`) switches
to `claude-haiku-3-20240307`. This is not wired into CI (no API key available
in CI). Run locally:

```sh
FREEHOLD_E2E_LLM=1 ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @freehold/api test tests/e2e-agent.test.ts
```

## CI: allod verify cross-check graph directory

The `allod verify` cross-check in CI only runs if a graph directory exists after
the test writes. Because the verify test creates nodes via `/api/v1/remember`
and admission depends on governance policy (may be held), the graph directory
may be empty if all writes are held. CI handles this gracefully with a directory
existence check and skips allod verify if no admissions occurred.

**Path forward:** Ensure at least one unconditional admit (e.g., a `direct` admit
path or an auto-approve policy) is exercised in the CI cross-check script.
