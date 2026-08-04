#!/usr/bin/env bash
# build-allod.sh — Rebuild @allod/core from the sibling repo.
#
# Prerequisites:
#   - Rust toolchain (rustup): https://rustup.rs/
#       rustup target add wasm32-unknown-unknown
#   - wasm-pack: https://rustwasm.github.io/wasm-pack/installer/
#       cargo install wasm-pack
#   - pnpm >= 9: https://pnpm.io/installation
#
# Usage:
#   bash scripts/build-allod.sh
#
# This script runs `pnpm build` inside ../allod/crates/allod-wasm, which
# executes both the wasm-pack step (produces pkg/) and the TypeScript
# step (produces dist/).  The resulting package is consumed by
# packages/core via the `file:` dependency in its package.json.
#
# Note: this script is for manual rebuild only.  The Freehold CI tests
# consume the *existing* build and will fail loudly if the pkg/ or dist/
# directories are absent — run this script first if you're starting from
# a clean checkout of the allod repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOD_WASM_DIR="$(cd "${SCRIPT_DIR}/../../allod/crates/allod-wasm" && pwd)"

echo "Building @allod/core at: ${ALLOD_WASM_DIR}"

if [[ ! -d "${ALLOD_WASM_DIR}" ]]; then
  echo "ERROR: allod-wasm directory not found at ${ALLOD_WASM_DIR}" >&2
  echo "       Clone the allod repo as a sibling of freehold:" >&2
  echo "       git clone <allod-url> $(dirname "${ALLOD_WASM_DIR}")/allod" >&2
  exit 1
fi

pnpm --dir "${ALLOD_WASM_DIR}" build

echo "Done. pkg/ and dist/ are up to date."
