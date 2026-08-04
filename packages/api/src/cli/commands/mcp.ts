/**
 * `freehold mcp setup [claude-code] [--print]`
 *
 * Stub — MCP endpoint arrives in F6.
 */

export interface McpOpts {
  subcommand: string;
  target: string;
  printOnly: boolean;
  json: boolean;
}

export async function runMcp(opts: McpOpts): Promise<void> {
  const message = "MCP endpoint arrives in F6";

  if (opts.json) {
    console.log(JSON.stringify({ status: "stub", message }));
  } else {
    console.log(message);
  }

  process.exit(0);
}
