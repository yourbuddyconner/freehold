import { AllodGraph } from "@allod/core";
import { describe, expect, it } from "vitest";

describe("@allod/core two-phase + git bindings", () => {
  it("exposes the new exports on a live graph", async () => {
    const g = new AllodGraph([], async () => {});
    await g.init("owner", "memory");
    for (const name of [
      "commit_payload",
      "commit_signed",
      "decide_payload",
      "decide_with_record",
      "envelope_payload",
      "git_checklist",
      "git_satisfaction",
      "git_decision_payload",
      "git_decision_attach",
    ]) {
      expect(typeof (g as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("two-phase commit round-trips with an externally supplied signature", async () => {
    // The owner key is in the doc store; extract the secret, sign the
    // payload with node crypto, and admit via commit_signed.
    const docs: Array<[string, string]> = [];
    const g = new AllodGraph([], async (pairs: Array<[string, string]>) => {
      docs.length = 0;
      docs.push(...pairs);
    });
    await g.init("owner", "memory");
    const { changeset, hash } = (await g.commit_payload("owner", "smoke", [
      {
        create: {
          kind: "node",
          id: "n-smoke",
          type: "memory/Note@1",
          attributes: { content: "hi" },
        },
      },
    ])) as { changeset: unknown; hash: string };
    const keyDoc = docs.find(([p]) => p === "keys/owner.yaml");
    expect(keyDoc).toBeDefined();
    const secretHex = /secret:\s*([0-9a-f]{64})/.exec(keyDoc?.[1])?.[1];
    const { createPrivateKey, sign } = await import("node:crypto");
    const der = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(secretHex, "hex"),
    ]);
    const sig = sign(
      null,
      Buffer.from(hash, "utf8"),
      createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    );
    const outcome = (await g.commit_signed(
      changeset,
      `sig:ed25519:${sig.toString("hex")}`,
      []
    )) as { Admitted?: unknown; Held?: unknown };
    expect(outcome.Admitted ?? outcome.Held).toBeDefined();
  });
});
