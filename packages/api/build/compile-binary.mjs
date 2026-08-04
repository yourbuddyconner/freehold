#!/usr/bin/env node
/**
 * F10 — Freehold v0 single-binary build.
 *
 * Compiles packages/api/src/cli/index.ts → packages/api/dist/freehold
 * using `bun build --compile`, then copies the PGlite wasm sidecar files
 * next to the binary.
 *
 * Usage:
 *   node packages/api/build/compile-binary.mjs
 *   # or: bun packages/api/build/compile-binary.mjs
 *
 * Artifacts produced in packages/api/dist/:
 *   freehold                  — standalone binary (bun runtime + JS bundle)
 *   freehold.pglite.wasm      — PGlite WASM engine
 *   freehold.pglite.data      — PGlite FS bundle (postgres base files)
 *   freehold.initdb.wasm      — PGlite initdb WASM
 *   freehold.vector.tar.gz    — pgvector extension bundle
 *
 * Note on allod_wasm_bg.wasm:
 *   @allod/core's loader reads its wasm from __dirname, which Bun bakes
 *   into the BUILD machine's absolute path — the compiled binary only
 *   works where that path exists.  The loader honors ALLOD_WASM_PATH
 *   (patched in @allod/core >= 0.1.2), so the wasm ships as the
 *   freehold.allod.wasm sidecar and cli/bootstrap.ts points the env var
 *   at it before any @allod/core import.
 *
 * Note on transformers / ONNX wasm:
 *   resolveOrtWasmPaths() in embed.ts returns null when the pnpm store is
 *   absent at runtime (compiled binary), so makeEmbedder() falls back to
 *   hashEmbedder with a stderr warning.  Semantic search is degraded in the
 *   compiled binary for v0.
 */

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path layout:
//   this script:  packages/api/build/compile-binary.mjs
//   API_PKG:      packages/api/
//   MONO_ROOT:    <repo root>   (3 levels up from this file)
const API_PKG = resolve(__dirname, ".."); // packages/api
const MONO_ROOT = resolve(__dirname, "../../.."); // monorepo root

// CLI flags:
//   --target=<bun-target>  cross-compile target (e.g. bun-darwin-arm64);
//                          defaults to the host ("bun")
//   --outdir=<dir>         artifact directory; defaults to packages/api/dist
const argTarget = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
const argOutdir = process.argv.find((a) => a.startsWith("--outdir="))?.slice("--outdir=".length);

const TARGET = argTarget ?? "bun";
const DIST = argOutdir ? resolve(process.cwd(), argOutdir) : resolve(API_PKG, "dist");
const ENTRYPOINT = resolve(API_PKG, "src/cli/index.ts");
const BINARY = resolve(DIST, "freehold");

// ─── Helper: find a package's root directory ──────────────────────────────────

/**
 * Walk up from `require.resolve(packageName)` until we find a directory
 * whose package.json has the matching `name` field.  Falls back to the
 * directory of the resolved entry if no match is found.
 *
 * We anchor resolution to packages/core/package.json because pglite is a
 * dependency of @freehold/core, not @freehold/api, so pnpm symlinks it under
 * packages/core/node_modules/.
 */
const CORE_PKG = resolve(MONO_ROOT, "packages/core");

function findPkgDir(packageName) {
  // Anchor resolution to packages/core/package.json (where pglite lives)
  const req = createRequire(resolve(CORE_PKG, "package.json"));
  let entry;
  try {
    entry = req.resolve(packageName);
  } catch {
    throw new Error(`Cannot resolve package "${packageName}". Run pnpm install first.`);
  }

  let dir = dirname(resolve(entry));
  while (true) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === packageName) return dir;
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // Fallback: directory of the resolved entry
  return dirname(resolve(entry));
}

// ─── Locate sidecar source files ─────────────────────────────────────────────

const pgliteDir = resolve(findPkgDir("@electric-sql/pglite"), "dist");
const pgvectorDir = resolve(findPkgDir("@electric-sql/pglite-pgvector"), "dist");

const allodDir = resolve(findPkgDir("@allod/core"), "pkg");

const SIDECARS = [
  { src: resolve(pgliteDir, "pglite.wasm"), dest: "freehold.pglite.wasm" },
  { src: resolve(pgliteDir, "pglite.data"), dest: "freehold.pglite.data" },
  { src: resolve(pgliteDir, "initdb.wasm"), dest: "freehold.initdb.wasm" },
  { src: resolve(pgvectorDir, "vector.tar.gz"), dest: "freehold.vector.tar.gz" },
  // @allod/core's loader reads ALLOD_WASM_PATH (set by cli/bootstrap.ts);
  // bundlers bake the loader's __dirname, so the wasm must ship as a sidecar.
  { src: resolve(allodDir, "allod_wasm_bg.wasm"), dest: "freehold.allod.wasm" },
];

// ─── 1. Validate inputs ───────────────────────────────────────────────────────

console.log("[freehold build] checking inputs...");
console.log(`  mono root:   ${MONO_ROOT}`);
console.log(`  entrypoint:  ${ENTRYPOINT}`);
console.log(`  output:      ${BINARY}`);

if (!existsSync(ENTRYPOINT)) {
  console.error(`\nERROR: entrypoint not found: ${ENTRYPOINT}`);
  process.exit(1);
}

let inputsOk = true;
for (const { src, dest } of SIDECARS) {
  if (!existsSync(src)) {
    console.error(`  ERROR: sidecar source not found: ${src}`);
    inputsOk = false;
  } else {
    const kb = (statSync(src).size / 1024).toFixed(0);
    console.log(`  found: ${basename(src).padEnd(20)} (${kb.padStart(6)} KB)  →  ${dest}`);
  }
}
if (!inputsOk) process.exit(1);

// ─── 2. Compile binary ────────────────────────────────────────────────────────

mkdirSync(DIST, { recursive: true });

const BUN =
  process.env.BUN ??
  (() => {
    try {
      return execSync("which bun", { stdio: "pipe" }).toString().trim();
    } catch {
      /* not on PATH */
    }
    return "/opt/homebrew/bin/bun";
  })();
const buildArgs = ["build", "--compile", ENTRYPOINT, `--outfile=${BINARY}`, `--target=${TARGET}`];

console.log(`\n[freehold build] running: ${BUN} ${buildArgs.join(" ")}\n`);

try {
  execSync([BUN, ...buildArgs].join(" "), {
    stdio: "inherit",
    cwd: MONO_ROOT,
    env: { ...process.env },
  });
} catch {
  console.error("\n[freehold build] ERROR: bun build --compile failed (see output above)");
  process.exit(1);
}

// ─── 3. Copy sidecars ─────────────────────────────────────────────────────────

console.log("\n[freehold build] copying sidecar files to dist/...");
for (const { src, dest } of SIDECARS) {
  const destPath = resolve(DIST, dest);
  copyFileSync(src, destPath);
  const kb = (statSync(destPath).size / 1024).toFixed(0);
  console.log(`  ${dest.padEnd(28)} (${kb.padStart(6)} KB)`);
}

// ─── 4. Report ────────────────────────────────────────────────────────────────

console.log("\n[freehold build] complete!\n");
console.log("Artifacts in packages/api/dist/:");

const allArtifacts = ["freehold", ...SIDECARS.map((s) => s.dest)];
for (const name of allArtifacts) {
  const p = resolve(DIST, name);
  if (existsSync(p)) {
    const mb = (statSync(p).size / 1024 / 1024).toFixed(1);
    console.log(`  ${name.padEnd(28)} ${mb} MB`);
  }
}

console.log(`
Deploy the entire dist/ directory together.  The binary reads its sidecar
files from the same directory as itself at startup.

Quick test:
  FREEHOLD_HOME=/tmp/fh-test ${BINARY} serve &
  sleep 2 && curl http://127.0.0.1:8710/health && kill %1
`);
