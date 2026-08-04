/**
 * F5 CLI tests:
 *   1. Founding loop — spawn daemon, drive CLI commands, assert flow works
 *   2. Exit-code matrix — held→2, bad token→4, daemon down→5
 *   3. Import-boundary — CLI files must not import @freehold/core directly
 *      (exception: commands/serve.ts is explicitly exempt)
 *   4. Client drift — generate.ts output must match src/types.ts
 *
 * All tests use a temp FREEHOLD_HOME; never touches ~/.freehold.
 * Uses FREEHOLD_EMBEDDER=hash for fast startup.
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const API_PKG = resolve(__dirname, "..");
const CLIENT_PKG = resolve(ROOT, "packages/client");
const CLI_SRC = resolve(API_PKG, "src/cli");
const TSX = resolve(API_PKG, "node_modules/.bin/tsx");
const CLI_ENTRY = resolve(CLI_SRC, "index.ts");

/** Spawn CLI and wait for exit. Returns { code, stdout, stderr }. */
function runCli(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 10_000
): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  let code = 0;

  try {
    const out = execFileSync(TSX, [CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      encoding: "utf-8",
    });
    stdout = out;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    code = e.status ?? 1;
  }

  return { code, stdout, stderr };
}

/** Create a temp home dir with config.json. */
function makeTempHome(overrides: Record<string, unknown> = {}): {
  home: string;
  token: string;
  port: number;
} {
  const home = mkdtempSync(join(tmpdir(), "freehold-cli-test-"));
  // Pick a random-ish port in range 40000-49999 to avoid collisions
  const port = 40000 + Math.floor(Math.random() * 9999);
  const token = `test-token-${Date.now()}`;
  const config = { token, port, graph: "main", embedder: "hash", ...overrides };
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  return { home, token, port };
}

/** Wait until GET /health returns 200 (poll up to maxWait ms). */
async function waitForDaemon(port: number, maxWait = 15_000): Promise<void> {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Daemon on port ${port} did not start within ${maxWait}ms`);
}

// ---------------------------------------------------------------------------
// Test suite 1: Founding loop
// ---------------------------------------------------------------------------

describe("Founding loop (daemon + CLI)", () => {
  let home: string;
  let port: number;
  let token: string;
  let serverProc: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    ({ home, token, port } = makeTempHome());

    // Start server as child process
    serverProc = spawn(TSX, [CLI_ENTRY, "serve"], {
      env: { ...process.env, FREEHOLD_HOME: home, FREEHOLD_EMBEDDER: "hash" },
      stdio: "pipe",
    });

    serverProc.stderr?.on("data", (_d: Buffer) => {
      // Uncomment for debugging: process.stderr.write(_d);
    });

    await waitForDaemon(port);

    // Pre-register the test agent so remember/entity commands work
    await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "cli-test" }),
    });
  });

  afterAll(() => {
    serverProc?.kill("SIGTERM");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("status returns ok", () => {
    const { code, stdout } = runCli(["status"], { FREEHOLD_HOME: home });
    expect(code).toBe(0);
    expect(stdout).toContain("ok");
  });

  test("status --json returns { status: 'ok' }", () => {
    const { code, stdout } = runCli(["status", "--json"], { FREEHOLD_HOME: home });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual({ status: "ok" });
  });

  test("remember stores a note (admitted or held)", () => {
    const { code, stdout } = runCli(
      ["remember", "I prefer morning meetings", "--agent", "cli-test"],
      { FREEHOLD_HOME: home }
    );
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toMatch(/remember/i);
  });

  test("remember --json returns admission shape", () => {
    const { code, stdout } = runCli(
      ["--json", "remember", "test memory for recall", "--agent", "cli-test"],
      { FREEHOLD_HOME: home }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("status");
    expect(parsed.status).toBe("admitted");
  });

  test("recall returns results array", () => {
    const { code, stdout } = runCli(["--json", "recall", "morning meetings"], {
      FREEHOLD_HOME: home,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("results");
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  test("pending returns proposals list", () => {
    const { code, stdout } = runCli(["--json", "pending"], { FREEHOLD_HOME: home });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("proposals");
    expect(Array.isArray(parsed.proposals)).toBe(true);
  });

  test("verify returns ok:true on fresh graph", () => {
    const { code, stdout } = runCli(["--json", "verify"], { FREEHOLD_HOME: home });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
  });

  test("reindex returns ok status", () => {
    const { code, stdout } = runCli(["--json", "reindex"], { FREEHOLD_HOME: home });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("status");
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: Exit-code matrix
// ---------------------------------------------------------------------------

describe("Exit-code matrix", () => {
  let home: string;
  let port: number;
  let serverProc: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    ({ home, port } = makeTempHome());

    serverProc = spawn(TSX, [CLI_ENTRY, "serve"], {
      env: { ...process.env, FREEHOLD_HOME: home },
      stdio: "pipe",
    });

    await waitForDaemon(port);
  });

  afterAll(() => {
    serverProc?.kill("SIGTERM");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("held response → exit code 2", async () => {
    // Register a new agent so entity writes can be tested
    const token = JSON.parse(readFileSync(join(home, "config.json"), "utf-8")).token as string;
    const heldTestAgent = `held-test-agent-${Date.now()}`;

    await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: heldTestAgent }),
    });

    const { code } = runCli(
      ["remember", "prefers tea", "--agent", heldTestAgent, "--type", "memory/Preference@1"],
      { FREEHOLD_HOME: home }
    );

    expect(code).toBe(2);
  });

  test("bad token → exit code 4", () => {
    // Write a bad-token config
    const badHome = mkdtempSync(join(tmpdir(), "freehold-bad-token-"));
    writeFileSync(
      join(badHome, "config.json"),
      JSON.stringify({ token: "wrong-token", port, graph: "main", embedder: "hash" })
    );
    try {
      // /health is public (no auth), so status will succeed.
      // Use recall or pending which requires auth:
      const { code } = runCli(["pending"], { FREEHOLD_HOME: badHome });
      expect(code).toBe(4);
    } finally {
      rmSync(badHome, { recursive: true, force: true });
    }
  });

  test("daemon down → exit code 5", () => {
    // Point to a port where nothing is running
    const downHome = mkdtempSync(join(tmpdir(), "freehold-down-"));
    const deadPort = 39999;
    writeFileSync(
      join(downHome, "config.json"),
      JSON.stringify({ token: "any-token", port: deadPort, graph: "main", embedder: "hash" })
    );
    try {
      const { code } = runCli(["status"], { FREEHOLD_HOME: downHome });
      expect(code).toBe(5);
    } finally {
      rmSync(downHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: Import boundary
// ---------------------------------------------------------------------------

describe("Import boundary: CLI must not import @freehold/core", () => {
  test("no CLI file (except serve.ts) imports @freehold/core", () => {
    const cliDir = CLI_SRC;

    function collectTs(dir: string): string[] {
      const files: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...collectTs(full));
        } else if (entry.name.endsWith(".ts")) {
          files.push(full);
        }
      }
      return files;
    }

    const allFiles = collectTs(cliDir);
    const violations: string[] = [];

    for (const file of allFiles) {
      // serve.ts is explicitly exempt — it must boot the server
      if (file.endsWith("commands/serve.ts")) continue;

      const content = readFileSync(file, "utf-8");
      // Only match actual import statements, not comments
      const importPattern = /^(?:import|export)\s+.*from\s+["']@freehold\/core["']/m;
      if (importPattern.test(content)) {
        violations.push(file.replace(`${ROOT}/`, ""));
      }
    }

    expect(
      violations,
      `These CLI files import @freehold/core directly:\n${violations.join("\n")}`
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test suite 4: Client drift
// ---------------------------------------------------------------------------

describe("Client drift: src/types.ts must match openapi.json", () => {
  test("generate.ts --check passes", () => {
    const generateScript = join(CLIENT_PKG, "generate.ts");
    const tsxBin = join(CLIENT_PKG, "node_modules/.bin/tsx");

    let code = 0;
    let stderr = "";
    try {
      execFileSync(tsxBin, [generateScript, "--check"], {
        cwd: CLIENT_PKG,
        encoding: "utf-8",
        timeout: 30_000,
      });
    } catch (err) {
      const e = err as { stderr?: string; status?: number };
      stderr = e.stderr ?? "";
      code = e.status ?? 1;
    }

    expect(
      code,
      `src/types.ts is out of date with openapi.json.\nRun: cd packages/client && pnpm generate\n${stderr}`
    ).toBe(0);
  });
});
