import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("config", () => {
  function tempHome() {
    return mkdtempSync(join(tmpdir(), "freehold-config-test-"));
  }

  test("loadConfig creates a config with valid UUID token on first load", () => {
    const home = tempHome();
    const config = loadConfig(home);
    expect(UUID_RE.test(config.token)).toBe(true);
    expect(config.port).toBe(8710);
    expect(config.graph).toBe("main");
    expect(config.embedder).toBe("transformers");
  });

  test("loadConfig returns the same config on subsequent loads", () => {
    const home = tempHome();
    const first = loadConfig(home);
    const second = loadConfig(home);
    expect(second.token).toBe(first.token);
    expect(second.port).toBe(first.port);
  });

  test("saveConfig + loadConfig round-trips the config", () => {
    const home = tempHome();
    const original = loadConfig(home);
    const modified = { ...original, port: 9000, graph: "test-graph" };
    saveConfig(modified, home);
    const loaded = loadConfig(home);
    expect(loaded.port).toBe(9000);
    expect(loaded.graph).toBe("test-graph");
    expect(loaded.token).toBe(original.token);
  });

  test("each new home gets a different token", () => {
    const home1 = tempHome();
    const home2 = tempHome();
    const config1 = loadConfig(home1);
    const config2 = loadConfig(home2);
    // Two different UUIDs (probabilistically guaranteed)
    expect(config1.token).not.toBe(config2.token);
  });
});
