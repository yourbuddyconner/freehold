import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { graphDirComponent, resolveKey, signPayload, publicHex, isKeychainNotFound } from "../src/keys.js";

// RFC 8032 test vector secret — same one allod's parity suite uses.
const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

function writeKeyYaml(dir: string, principal: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${principal}.yaml`),
    `name: ${principal}\nkey_id: x\nalgorithm: ed25519\npublic: ${PUBLIC}\nsecret: ${SECRET}\n`);
}

// Save/restore ALLOD_KEYS_DIR to avoid leaking across tests
const origKeysDir = process.env.ALLOD_KEYS_DIR;
afterEach(() => {
  if (origKeysDir === undefined) {
    delete process.env.ALLOD_KEYS_DIR;
  } else {
    process.env.ALLOD_KEYS_DIR = origKeysDir;
  }
});

describe("keys.ts", () => {
  it("isKeychainNotFound classifies exit codes correctly", () => {
    // Exit code 44 (as number)
    expect(isKeychainNotFound({ code: 44 })).toBe(true);
    // Exit code 44 (as string)
    expect(isKeychainNotFound({ code: "44" })).toBe(true);
    // Other exit codes should not be classified as not-found
    expect(isKeychainNotFound({ code: 1 })).toBe(false);
    expect(isKeychainNotFound({ code: "1" })).toBe(false);
    expect(isKeychainNotFound({ code: 127 })).toBe(false); // ENOENT from missing binary
    // Missing code property
    expect(isKeychainNotFound({ stderr: "some error" })).toBe(false);
    expect(isKeychainNotFound({})).toBe(false);
  });

  it("graphDirComponent matches allod", () => {
    expect(graphDirComponent("sha256:ab/cd:ef")).toBe("ab-cd-ef");
    expect(graphDirComponent("plain-id_1.2")).toBe("plain-id_1.2");
  });

  it("resolves XDG path, signs verifiably, falls back to legacy", async () => {
    const keysDir = mkdtempSync(join(tmpdir(), "fh-keys-"));
    process.env.ALLOD_KEYS_DIR = keysDir;
    writeKeyYaml(join(keysDir, "feed"), "alice");
    const k = await resolveKey("sha256:feed", "alice");
    expect(k.backend).toBe("file");
    const sig = await signPayload(k, "sha256:00ff", "sha256:feed");
    expect(sig).toMatch(/^sig:ed25519:[0-9a-f]{128}$/);
    // verify against the known public key with node crypto
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(PUBLIC, "hex"),
    ]);
    const ok = nodeVerify(null, Buffer.from("sha256:00ff", "utf8"),
      createPublicKey({ key: spki, format: "der", type: "spki" }),
      Buffer.from(sig.slice("sig:ed25519:".length), "hex"));
    expect(ok).toBe(true);
    expect(await publicHex(k, "sha256:feed")).toBe(PUBLIC);

    // legacy fallback
    const repo = mkdtempSync(join(tmpdir(), "fh-repo-"));
    writeKeyYaml(join(repo, ".allod", "keys"), "bob");
    const k2 = await resolveKey("sha256:feed", "bob", { repoDir: repo });
    expect(k2.location).toContain(".allod/keys/bob.yaml");

    // miss
    await expect(resolveKey("sha256:feed", "nobody")).rejects.toThrow(/searched/);
  });

  it("keychain roundtrip (env-gated)", async () => {
    if (process.platform !== "darwin" || process.env.ALLOD_KEYCHAIN_TESTS !== "1") return;
    const service = `allod-test-fh-${process.pid}`;
    const account = `${graphDirComponent("sha256:beef")}/kc`;
    const yaml = `name: kc\nkey_id: x\nalgorithm: ed25519\npublic: ${PUBLIC}\nsecret: ${SECRET}\n`;
    const { execFileSync } = await import("node:child_process");
    execFileSync("security", ["add-generic-password", "-s", service, "-a", account, "-w", yaml]);
    try {
      const k = await resolveKey("sha256:beef", "kc", { keychainService: service });
      expect(k.backend).toBe("keychain");
      const sig = await signPayload(k, "sha256:11", "sha256:beef", { keychainService: service });
      expect(sig).toMatch(/^sig:ed25519:[0-9a-f]{128}$/);
    } finally {
      execFileSync("security", ["delete-generic-password", "-s", service, "-a", account]);
    }
  });
});
