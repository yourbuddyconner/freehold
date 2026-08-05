/**
 * @freehold/core/connector — GitHub REST client.
 *
 * Thin wrapper with injectable fetch and token injection.
 * Base URL defaults to https://api.github.com, overridable via GITHUB_API_BASE env.
 * Never logs tokens or secrets.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── GithubClient ──────────────────────────────────────────────────────────────

export interface GithubClient {
  /** Make an authenticated REST call to GitHub. Path is relative to the base URL. */
  rest<T>(path: string, init?: RequestInit): Promise<T>;
}

// ── makeTokenClient ───────────────────────────────────────────────────────────

/**
 * Build a GithubClient that injects `Bearer <token>` on every request.
 * `fetchImpl` defaults to the global fetch; tests inject a fake.
 * The base URL is https://api.github.com unless GITHUB_API_BASE is set.
 */
export function makeTokenClient(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch
): GithubClient {
  return {
    async rest<T>(path: string, init?: RequestInit): Promise<T> {
      const base = (process.env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/$/, "");
      const url = `${base}${path}`;

      const headers = new Headers(init?.headers as HeadersInit | undefined);
      headers.set("Authorization", `Bearer ${token}`);
      headers.set("Accept", "application/vnd.github+json");
      headers.set("X-GitHub-Api-Version", "2022-11-28");

      const res = await fetchImpl(url, { ...init, headers });
      if (!res.ok) {
        throw new Error(`GitHub API ${res.status} for ${path}`);
      }
      return res.json() as Promise<T>;
    },
  };
}

// ── discoverCredential ────────────────────────────────────────────────────────

/**
 * Discover a GitHub credential without user interaction.
 *
 * Resolution order:
 *   1. `gh auth token` — GitHub CLI
 *   2. `git credential fill` (protocol=https, host=github.com)
 *   3. null — no credential found (typed absence, not a crash)
 *
 * Both helpers use execFile (no shell). Tokens are never logged.
 */
export async function discoverCredential(): Promise<string | null> {
  // 1. gh auth token
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated — fall through
  }

  // 2. git credential fill
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["credential", "fill"], { stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`git credential fill exited with ${code}`));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
      child.stdin.write("protocol=https\nhost=github.com\n\n");
      child.stdin.end();
    });
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (line.startsWith("password=")) {
        const password = line.slice("password=".length).trim();
        if (password) return password;
      }
    }
  } catch {
    // git credential fill failed — fall through
  }

  return null;
}

// ── parseOriginRemote ─────────────────────────────────────────────────────────

/**
 * Parse a GitHub remote URL (https or git@ forms) into { owner, repo }.
 * Returns null if the URL is not a recognizable GitHub remote.
 *
 * Supported forms:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   git@github.com:owner/repo
 */
export function parseOriginRemote(remote: string): { owner: string; repo: string } | null {
  if (!remote) return null;

  // https form
  const httpsMatch = remote.match(
    /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/
  );
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch;
    if (owner && repo) return { owner, repo };
  }

  // SSH / git@ form
  const sshMatch = remote.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\s*$/);
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    if (owner && repo) return { owner, repo };
  }

  return null;
}
