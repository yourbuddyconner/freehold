import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureHome, resolveHome } from "../src/home.js";

describe("home", () => {
  const origEnv = process.env.FREEHOLD_HOME;

  afterEach(() => {
    if (origEnv === undefined) {
      Reflect.deleteProperty(process.env, "FREEHOLD_HOME");
    } else {
      process.env.FREEHOLD_HOME = origEnv;
    }
  });

  test("resolveHome returns FREEHOLD_HOME env var when set", () => {
    process.env.FREEHOLD_HOME = "/tmp/my-freehold";
    expect(resolveHome()).toBe("/tmp/my-freehold");
  });

  test("resolveHome returns ~/.freehold when env not set", () => {
    Reflect.deleteProperty(process.env, "FREEHOLD_HOME");
    expect(resolveHome()).toBe(join(homedir(), ".freehold"));
  });

  test("ensureHome creates the directory if it does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "freehold-home-test-"));
    const target = join(base, "subdir", "freehold");
    expect(existsSync(target)).toBe(false);
    const result = ensureHome(target);
    expect(result).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  test("ensureHome returns the directory if it already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "freehold-home-test-"));
    expect(existsSync(dir)).toBe(true);
    const result = ensureHome(dir);
    expect(result).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });
});
