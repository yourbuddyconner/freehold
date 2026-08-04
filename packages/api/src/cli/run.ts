/**
 * Shared CLI runner utilities.
 * Handles ApiError → exit code mapping and output formatting.
 */

import { ApiError, FreeholdClient } from "@freehold/client";

export interface BaseOpts {
  baseUrl: string;
  token: string;
  json: boolean;
}

/**
 * Map an ApiError or network error to an exit code and print the message.
 */
export function handleError(err: unknown): never {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      console.error(
        `Auth error (${err.status}): ${err.message}. Check token in ~/.freehold/config.json`
      );
      process.exit(4);
    }
    if (err.code === "policy_rejected") {
      console.error(`Policy rejected: ${err.message}`);
      process.exit(3);
    }
    console.error(`API error [${err.code}]: ${err.message}`);
    process.exit(1);
  }

  const e = err as Error & { code?: string };
  if (
    e.code === "ECONNREFUSED" ||
    e.message?.includes("ECONNREFUSED") ||
    e.message?.includes("Network error")
  ) {
    console.error(`Freehold is not running — start it with \`freehold serve\` (${e.message})`);
    console.error("Is `freehold serve` running?");
    process.exit(5);
  }

  console.error(`Error: ${e.message ?? String(err)}`);
  process.exit(1);
}

/**
 * Print output. In json mode, print raw JSON; otherwise call the formatter.
 */
export function output(data: unknown, json: boolean, format: (d: unknown) => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    format(data);
  }
}

/**
 * Create a FreeholdClient from base options.
 */
export function makeClient(opts: BaseOpts): FreeholdClient {
  return new FreeholdClient({ baseUrl: opts.baseUrl, token: opts.token });
}

/**
 * Check if an admission response is "pending" (pending approval) and exit 2 if so.
 * Exit code 2 means the write was accepted but is waiting for owner approval.
 */
export function checkHeld(result: { status?: string }): void {
  if (result.status === "pending") {
    process.exit(2);
  }
}
