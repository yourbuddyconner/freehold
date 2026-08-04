import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome } from "./home.js";
import type { FreeholdConfig } from "./types.js";

const CONFIG_FILE = "config.json";
const DEFAULT_PORT = 8710;

export function loadConfig(home?: string): FreeholdConfig {
  const dir = ensureHome(home);
  const path = join(dir, CONFIG_FILE);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8")) as FreeholdConfig;
  }
  const config: FreeholdConfig = {
    token: crypto.randomUUID(),
    graph: "main",
    embedder: "transformers",
    port: DEFAULT_PORT,
  };
  saveConfig(config, dir);
  return config;
}

export function saveConfig(config: FreeholdConfig, home?: string): void {
  const dir = ensureHome(home);
  const path = join(dir, CONFIG_FILE);
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}
