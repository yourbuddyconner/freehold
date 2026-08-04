/**
 * CLI config loader — reads FREEHOLD_HOME/config.json.
 * Does NOT import @freehold/core — uses plain fs reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ClientConfig {
  baseUrl: string;
  token: string;
}

interface StoredConfig {
  token?: string;
  port?: number;
}

const DEFAULT_PORT = 8710;

export function loadClientConfig(home: string): ClientConfig {
  const configPath = join(home, "config.json");
  let stored: StoredConfig = {};

  if (existsSync(configPath)) {
    try {
      stored = JSON.parse(readFileSync(configPath, "utf-8")) as StoredConfig;
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  const port = stored.port ?? DEFAULT_PORT;
  const token = stored.token ?? "";
  const baseUrl = `http://127.0.0.1:${port}`;

  return { baseUrl, token };
}
