#!/usr/bin/env tsx
/**
 * freehold CLI — entry point.
 *
 * Reads ~/.freehold/config.json (or $FREEHOLD_HOME/config.json) for {port, token}.
 * All commands except `serve` call the local daemon over HTTP via FreeholdClient.
 *
 * Exit codes:
 *   0 = ok
 *   1 = other error
 *   2 = pending (write is pending owner approval, not yet committed)
 *   3 = policy-rejected
 *   4 = auth failure (401/403)
 *   5 = unreachable (network error / ECONNREFUSED)
 */

import "./bootstrap.js"; // bootstrap must be first — sets ALLOD_WASM_PATH before any module pulls in @allod/core.
import * as os from "node:os";
import * as path from "node:path";
import { runApprove } from "./commands/approve.js";
import { runMcp } from "./commands/mcp.js";
import { runPending } from "./commands/pending.js";
import { runRecall } from "./commands/recall.js";
import { runReindex } from "./commands/reindex.js";
import { runReject } from "./commands/reject.js";
import { runRemember } from "./commands/remember.js";
import { runServe } from "./commands/serve.js";
import { runStatus } from "./commands/status.js";
import { runVerify } from "./commands/verify.js";
import { loadClientConfig } from "./config.js";

import pkg from "../../package.json" with { type: "json" };

const HELP = `
freehold — governed memory backend for AI agents

Usage:
  freehold <command> [options]

Commands:
  serve                       Start Freehold
  status                      Check that Freehold is running
  remember <content>          Store a memory note
    --agent <name>            Agent name (default: "cli")
    --type <type>             Entity type, e.g. memory/Preference@1 (default: memory/Note@1)
    --classify <term>         Classification term, e.g. workspace/personal@1
  recall <query>              Recall memories by semantic search
  pending                     List pending proposals
  approve <hash>              Approve a pending proposal
  reject <hash>               Reject a pending proposal
  verify                      Verify graph integrity
  reindex                     Rebuild the search index
  mcp setup [claude-code]     Configure MCP integration
    --print                   Print config instead of writing

Global flags:
  --json                      Output raw JSON
  --help                      Show help
  --version                   Print the version

Config: \${FREEHOLD_HOME:-~/.freehold}/config.json
`.trim();

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(`freehold ${pkg.version}`);
    process.exit(0);
  }

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const jsonMode = argv.includes("--json");
  const filteredArgv = argv.filter((a) => a !== "--json");

  const [command, ...rest] = filteredArgv;

  if (command === "serve") {
    await runServe();
    return;
  }

  // All other commands need a client config
  const home = process.env.FREEHOLD_HOME ?? path.join(os.homedir(), ".freehold");
  const { baseUrl, token } = loadClientConfig(home);

  switch (command) {
    case "status":
      await runStatus({ baseUrl, token, json: jsonMode });
      break;

    case "remember": {
      const contentParts: string[] = [];
      let agent = "cli";
      let type: string | undefined;
      let classify: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--agent" && rest[i + 1]) {
          agent = rest[i + 1];
          i++;
        } else if (rest[i] === "--type" && rest[i + 1]) {
          type = rest[i + 1];
          i++;
        } else if (rest[i] === "--classify" && rest[i + 1]) {
          classify = rest[i + 1];
          i++;
        } else {
          contentParts.push(rest[i]);
        }
      }
      const content = contentParts.join(" ");
      if (!content) {
        console.error("Error: `remember` requires a <content> argument");
        process.exit(1);
      }
      await runRemember({ baseUrl, token, json: jsonMode, content, agent, type, classify });
      break;
    }

    case "recall": {
      const query = rest.filter((a) => !a.startsWith("--")).join(" ");
      if (!query) {
        console.error("Error: `recall` requires a <query> argument");
        process.exit(1);
      }
      await runRecall({ baseUrl, token, json: jsonMode, query });
      break;
    }

    case "pending":
      await runPending({ baseUrl, token, json: jsonMode });
      break;

    case "approve": {
      const hash = rest[0];
      if (!hash) {
        console.error("Error: `approve` requires a <hash> argument");
        process.exit(1);
      }
      await runApprove({ baseUrl, token, json: jsonMode, hash });
      break;
    }

    case "reject": {
      const hash = rest[0];
      if (!hash) {
        console.error("Error: `reject` requires a <hash> argument");
        process.exit(1);
      }
      await runReject({ baseUrl, token, json: jsonMode, hash });
      break;
    }

    case "verify":
      await runVerify({ baseUrl, token, json: jsonMode });
      break;

    case "reindex":
      await runReindex({ baseUrl, token, json: jsonMode });
      break;

    case "mcp": {
      const subcommand = rest[0] ?? "setup";
      const target = rest[1] ?? "claude-code";
      const printOnly = rest.includes("--print");
      await runMcp({ subcommand, target, printOnly, json: jsonMode, baseUrl, token });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run `freehold --help` for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[freehold] fatal: ${(err as Error).message}`);
  process.exit(1);
});
