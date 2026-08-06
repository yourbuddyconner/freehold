/**
 * @freehold/core — repo onboarding
 *
 * Implements the steps described in spec §1:
 *   1. If <path>/.allod/graph.yaml is absent, run `allodBin init <path> --owner <principal>`
 *   2. Generate the principal's key if absent (native Ed25519, written to XDG keys dir)
 *   3. POST /graphs via manager.registerRepo (installs review ontology, originRemote, syncIndex)
 *   4. Unless noIndex: `allodBin git index <path> <defaultBranch> --as <principal>`
 *
 * All allodBin invocations validate the binary exists first and surface a plain
 * error naming the config key when it does not.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { generateKeyPair } from "./keys.js";
import type { GraphEntry, GraphManager } from "./manager.js";
import { readAllodGraphIdFromPath } from "./onboarding-util.js";

const execFileAsync = promisify(execFile);

// ─── Step result types ────────────────────────────────────────────────────────

export interface OnboardStep {
  step: string;
  status: "ok" | "skipped" | "failed";
  detail?: string;
}

export interface OnboardResult {
  steps: OnboardStep[];
  entry: GraphEntry;
  keyPath: string;
  /** The principal whose key was generated/verified. */
  principal: string;
}

// ─── allodBin resolution ──────────────────────────────────────────────────────

/**
 * Resolve the allod binary from the config value.
 * Throws a plain error naming the `allodBin` config key if the binary cannot be found.
 */
function resolveAllodBin(allodBin: string): string {
  if (allodBin.startsWith("/")) {
    if (!existsSync(allodBin)) {
      throw new Error(
        `allod binary not found at "${allodBin}". Set the correct path in ~/.freehold/config.json via the "allodBin" key.`
      );
    }
    return allodBin;
  }
  // Bare name (e.g. "allod") — rely on PATH; execFile will throw ENOENT if absent.
  return allodBin;
}

/**
 * Execute allodBin, translating ENOENT into a user-facing error naming the config key.
 */
async function runAllodBin(
  allodBin: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const bin = resolveAllodBin(allodBin);
  try {
    return await execFileAsync(bin, args, { timeout: 120_000 });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(
        `allod binary "${allodBin}" not found on PATH. Set the correct path in ~/.freehold/config.json via the "allodBin" key.`
      );
    }
    throw err;
  }
}

// ─── onboardRepo ─────────────────────────────────────────────────────────────

export interface OnboardOptions {
  /** Absolute path to the repository checkout. */
  path: string;
  /** Display name for the graph registry. Defaults to basename(path). */
  name?: string;
  /** Registry slug id. Defaults to basename(path) (sanitized). */
  id?: string;
  /** Signing principal name. Defaults to "owner". */
  principal?: string;
  /** Skip the allodBin git index step after registration. */
  noIndex?: boolean;
  /** Default branch name for git index (spec §1 step 4). */
  defaultBranch?: string;
  /**
   * Resolved allod binary path or name.
   * Source: config.allodBin ?? "allod".
   */
  allodBin: string;
}

/**
 * Onboard a repository: run allod init if needed, generate key, register graph,
 * and optionally run the initial git index.
 *
 * Each step is idempotent where possible (allod init only if no graph.yaml;
 * key generation only if file absent; registerRepo throws on duplicate id).
 *
 * Returns a result with per-step status and the registered GraphEntry.
 */
export async function onboardRepo(
  manager: GraphManager,
  opts: OnboardOptions
): Promise<OnboardResult> {
  const principal = opts.principal ?? "owner";
  const defaultBranch = opts.defaultBranch ?? "main";
  const steps: OnboardStep[] = [];

  // ── Step 1: allod init if .allod/graph.yaml is absent ────────────────────────
  const graphYaml = `${opts.path}/.allod/graph.yaml`;
  if (!existsSync(graphYaml)) {
    try {
      await runAllodBin(opts.allodBin, ["init", opts.path, "--owner", principal]);
      steps.push({ step: "allod init", status: "ok" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ step: "allod init", status: "failed", detail: msg });
      throw Object.assign(new Error(`allod init failed: ${msg}`), { steps });
    }
  } else {
    steps.push({
      step: "allod init",
      status: "skipped",
      detail: ".allod/graph.yaml already exists",
    });
  }

  // ── Step 2: Generate principal key if absent ──────────────────────────────────
  // We need the allodGraphId to compute the XDG key path.
  // Read it from graph.yaml after init.
  let keyPath: string;
  try {
    const allodGraphId = readAllodGraphIdFromPath(opts.path);
    keyPath = generateKeyPair(allodGraphId, principal);
    steps.push({ step: "generate key", status: "ok", detail: keyPath });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({ step: "generate key", status: "failed", detail: msg });
    throw Object.assign(new Error(`key generation failed: ${msg}`), { steps });
  }

  // ── Step 3: Register graph (POST /graphs equivalent) ─────────────────────────
  let entry: GraphEntry;
  try {
    entry = await manager.registerRepo(opts.path, {
      id: opts.id,
      name: opts.name,
      signingPrincipal: principal,
    });
    steps.push({ step: "register graph", status: "ok", detail: `id=${entry.id}` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Idempotent: if already registered, surface a clear message
    steps.push({ step: "register graph", status: "failed", detail: msg });
    throw Object.assign(new Error(`graph registration failed: ${msg}`), { steps });
  }

  // ── Step 4: allodBin git index (unless --no-index) ───────────────────────────
  if (!opts.noIndex) {
    try {
      await runAllodBin(opts.allodBin, [
        "git",
        "index",
        opts.path,
        defaultBranch,
        "--as",
        principal,
      ]);
      steps.push({ step: "git index", status: "ok" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Non-fatal: registration succeeded; report as a warning step
      steps.push({ step: "git index", status: "failed", detail: msg });
      console.error(`[freehold] onboard: git index failed: ${msg}`);
    }
  } else {
    steps.push({ step: "git index", status: "skipped", detail: "--no-index" });
  }

  return { steps, entry, keyPath, principal };
}
