# F10 Deferred Items

## Dogfood: run from source for semantic recall

The compiled binary (`packages/api/dist/freehold`) ships a hash-embedder — semantic recall
(bge-small cosine similarity) is unavailable. For dogfood and development, run from source:

```sh
pnpm --filter @freehold/api exec tsx src/cli/index.ts serve
```

The compiled binary ships the hash-embedder only. Recall still works (BM25 full-text
+ hash vectors), but semantic similarity is random. The binary is suitable for
packaging and distribution; the source path is appropriate for dogfood.

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

**RESOLVED:** The earlier note claimed admission may be held by governance, requiring a
graceful skip of `allod verify` if the graph directory did not exist. This was incorrect.

The daemon uses `createGraph` which calls `graph.init(owner, "memory")`, installing the
embedded memory profile including the `scratch-is-free` rule. Nodes written via
`/api/v1/remember` are classified as scratch, so writes are admitted immediately. The
graph directory is guaranteed to exist after the two test writes.

The vacuous conditional skip has been removed. The CI now unconditionally asserts that the
graph directory exists (failing fast if admission is broken) and then runs `allod verify`.

## pi-ai package: @mariozechner/pi-ai deprecation

The e2e-agent test uses `@mariozechner/pi-ai@0.73.0` and `@mariozechner/pi-agent-core@0.73.0`.
The `@mariozechner/` namespace is deprecated; the successor package is `@earendil-works/pi-ai`.

**Path forward:** Migrate the e2e-agent test and the API package dependencies from
`@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` to `@earendil-works/pi-ai` once
that package stabilizes and publishes compatible versions. For v0, the existing
`@mariozechner/` packages continue to work.
