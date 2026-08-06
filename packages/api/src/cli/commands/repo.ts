/**
 * freehold repo <subcommand> — repository management commands.
 *
 * repo add <path> [--name <n>] [--id <id>] [--principal <p>] [--no-index]
 *
 * Steps, each printed as it runs (idempotent where possible):
 *   1. allod init <path> --owner <principal>   (if .allod/graph.yaml absent)
 *   2. Generate principal key (native Ed25519, XDG keys dir)
 *   3. POST /repos/onboard → daemon registers graph + installs review ontology
 *   4. allod git index <path> <default-branch> --as <principal>  (unless --no-index)
 *
 * Prints a summary on success: graph id, principal, key path, next steps.
 */

import type { BaseOpts } from "../run.js";
import { handleError, makeClient, output } from "../run.js";

interface RepoAddOpts extends BaseOpts {
  path: string;
  name?: string;
  id?: string;
  principal?: string;
  noIndex?: boolean;
  defaultBranch?: string;
}

export async function runRepo(opts: BaseOpts, subcommand: string, rest: string[]): Promise<void> {
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printRepoHelp();
    process.exit(0);
  }

  if (subcommand === "add") {
    await runRepoAdd(opts, rest);
    return;
  }

  console.error(`Unknown repo subcommand: ${subcommand}`);
  console.error("Run `freehold repo --help` for usage.");
  process.exit(1);
}

function printRepoHelp(): void {
  console.log(
    `
freehold repo — repository management

Usage:
  freehold repo add <path> [options]

Subcommands:
  add <path>    Register a repository with the local Freehold daemon

Options (add):
  --name <n>        Display name for the graph (default: basename of path)
  --id <id>         Registry slug id (default: basename of path)
  --principal <p>   Signing principal name (default: owner)
  --no-index        Skip the initial git index step
  --branch <b>      Default branch for git index (default: main)
`.trim()
  );
}

async function runRepoAdd(opts: BaseOpts, args: string[]): Promise<void> {
  // Parse positional + flags
  let path: string | undefined;
  let name: string | undefined;
  let id: string | undefined;
  let principal: string | undefined;
  let noIndex = false;
  let defaultBranch = "main";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--name" && args[i + 1]) {
      name = args[i + 1];
      i++;
    } else if (arg === "--id" && args[i + 1]) {
      id = args[i + 1];
      i++;
    } else if (arg === "--principal" && args[i + 1]) {
      principal = args[i + 1];
      i++;
    } else if (arg === "--no-index") {
      noIndex = true;
    } else if (arg === "--branch" && args[i + 1]) {
      defaultBranch = args[i + 1];
      i++;
    } else if (!arg.startsWith("--")) {
      path = arg;
    }
  }

  if (!path) {
    console.error("Error: `repo add` requires a <path> argument");
    process.exit(1);
  }

  const addOpts: RepoAddOpts = {
    ...opts,
    path,
    name,
    id,
    principal,
    noIndex,
    defaultBranch,
  };

  await runRepoAddRequest(addOpts);
}

async function runRepoAddRequest(opts: RepoAddOpts): Promise<void> {
  const client = makeClient(opts);

  // Print progress header (human mode)
  if (!opts.json) {
    console.log(`Onboarding repository: ${opts.path}`);
    console.log();
  }

  try {
    const result = await client.onboardRepo({
      path: opts.path,
      name: opts.name,
      id: opts.id,
      principal: opts.principal,
      noIndex: opts.noIndex,
      defaultBranch: opts.defaultBranch,
    });

    output(result, opts.json, (d) => {
      const r = d as {
        steps: Array<{ step: string; status: string; detail?: string }>;
        entry: { id: string; path: string };
        keyPath: string;
        principal: string;
      };

      // Print each step as it ran
      for (const step of r.steps) {
        const icon = step.status === "ok" ? "✓" : step.status === "skipped" ? "–" : "✗";
        const detail = step.detail ? `  (${step.detail})` : "";
        console.log(`  ${icon} ${step.step}${detail}`);
      }

      console.log();
      console.log("Graph registered:");
      console.log(`  id:        ${r.entry.id}`);
      console.log(`  path:      ${r.entry.path}`);
      console.log(`  principal: ${r.principal}`);
      console.log(`  key:       ${r.keyPath}`);
      console.log();
      console.log("Next: set up a GitHub connector in Settings → Connector.");
    });

    process.exit(0);
  } catch (err) {
    // Check if this is an ApiError with step details
    if (!opts.json) {
      const e = err as Error & {
        body?: { steps?: Array<{ step: string; status: string; detail?: string }> };
      };
      if (e.body?.steps) {
        for (const step of e.body.steps) {
          const icon = step.status === "ok" ? "✓" : step.status === "skipped" ? "–" : "✗";
          const detail = step.detail ? `  (${step.detail})` : "";
          console.log(`  ${icon} ${step.step}${detail}`);
        }
        console.log();
      }
    }
    handleError(err);
  }
}
