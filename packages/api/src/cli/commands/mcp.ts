/**
 * `freehold mcp setup [claude-code] [--print]`
 *
 * Writes (or prints) the Claude Code MCP server entry for this Freehold
 * instance.  The entry uses the streamable-HTTP transport with the daemon's
 * bearer token from config.
 *
 * --print  — emit JSON only to stdout (no file written).
 *
 * Without --print the entry is merged into .mcp.json in the current working
 * directory (same convention as valet), creating the file if absent.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface McpOpts {
  subcommand: string;
  target: string;
  printOnly: boolean;
  json: boolean;
}

/** The Claude Code MCP server config shape for a single server entry. */
interface McpServerEntry {
  type: "http";
  url: string;
  headers: { Authorization: string };
}

interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

function buildEntry(baseUrl: string, token: string): McpServerEntry {
  return {
    type: "http",
    url: `${baseUrl}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeIntoMcpJson(path: string, serverName: string, entry: McpServerEntry): void {
  let doc: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) doc = parsed;
    } catch {
      // If file is corrupt or unreadable, start fresh
    }
  }
  const servers: Record<string, unknown> = isRecord(doc.mcpServers) ? doc.mcpServers : {};
  servers[serverName] = entry;
  doc.mcpServers = servers;
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

export async function runMcp(opts: McpOpts & { baseUrl?: string; token?: string }): Promise<void> {
  if (opts.subcommand !== "setup") {
    console.error(`freehold mcp: unknown subcommand '${opts.subcommand}' (supported: setup)`);
    process.exit(1);
  }

  if (opts.target !== "claude-code") {
    console.error(`freehold mcp setup: unknown target '${opts.target}' (supported: claude-code)`);
    process.exit(1);
  }

  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:8710";
  const token = opts.token ?? "";
  const entry = buildEntry(baseUrl, token);
  const config: McpConfig = { mcpServers: { freehold: entry } };

  if (opts.printOnly || opts.json) {
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  }

  const targetPath = resolve(process.cwd(), ".mcp.json");
  mergeIntoMcpJson(targetPath, "freehold", entry);
  console.log(`Wrote MCP server "freehold" → ${targetPath}`);
  console.log(`Endpoint: ${entry.url}`);
  process.exit(0);
}
