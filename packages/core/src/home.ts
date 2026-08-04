import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveHome(): string {
  return process.env.FREEHOLD_HOME ?? join(homedir(), ".freehold");
}

export function ensureHome(home?: string): string {
  const dir = home ?? resolveHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
