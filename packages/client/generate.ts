#!/usr/bin/env tsx
/**
 * generate.ts — regenerates src/types.ts from packages/api/openapi.json.
 *
 * Usage:
 *   tsx generate.ts           # write src/types.ts in-place
 *   tsx generate.ts --check   # diff against src/types.ts; exit 1 on drift
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..", "..");
const openapiPath = join(rootDir, "packages", "api", "openapi.json");
const outPath = join(__dirname, "src", "types.ts");

const checkMode = process.argv.includes("--check");

function generate(): string {
  // Run openapi-typescript via the local bin
  const bin = join(__dirname, "node_modules", ".bin", "openapi-typescript");
  const result = execSync(`${bin} "${openapiPath}" --output -`, {
    encoding: "utf-8",
  });
  return result;
}

const generated = generate();

if (checkMode) {
  if (!existsSync(outPath)) {
    console.error("ERROR: src/types.ts does not exist. Run `pnpm generate` first.");
    process.exit(1);
  }
  const existing = readFileSync(outPath, "utf-8");
  if (existing !== generated) {
    console.error(
      "ERROR: src/types.ts is out of date with openapi.json. Run `pnpm generate` to update."
    );
    // Show a brief diff using temp files
    const tmpDir = mkdtempSync(join(tmpdir(), "freehold-gen-"));
    try {
      const existingPath = join(tmpDir, "existing.ts");
      const generatedPath = join(tmpDir, "generated.ts");
      writeFileSync(existingPath, existing, "utf-8");
      writeFileSync(generatedPath, generated, "utf-8");
      execSync(`diff "${existingPath}" "${generatedPath}"`, {
        stdio: "inherit",
      });
    } catch {
      // diff exits non-zero when files differ; we already printed the error message above
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    process.exit(1);
  }
  console.log("src/types.ts is up to date.");
} else {
  writeFileSync(outPath, generated, "utf-8");
  console.log(`Generated src/types.ts from ${openapiPath}`);
}
