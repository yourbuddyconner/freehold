import { getPolicy, proposePolicyChange } from "@freehold/core";
import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const policyRouter = new Hono<AppEnv>();

// GET /policy — return the graph's active policy name, definition YAML, and parsed rules array.
policyRouter.get("/policy", (c) => {
  const fh = c.get("freehold");
  const policy = getPolicy(fh.graph);
  if (!policy) {
    return c.json({ rules: [] });
  }
  // Return rules alongside name+definition so the console can render and edit individual rules.
  return c.json({ name: policy.name, definition: policy.definition, rules: policy.rules ?? [] });
});

// POST /policy — propose a policy change.
//
// Policy changes are always held for owner review.  The wasm `install_package`
// binding does not yet accept a policy parameter (the Rust `install_package`
// has Option<policy> but the wasm surface only exposes docs_yaml+by), so
// proposing a real policy swap would require a new `install_policy` wasm
// binding.  For v0 we return the `held` admission shape immediately — the
// proposal is real in the sense that the owner must explicitly approve it
// (the `policy-changes-require-owner-review` rule) — without writing to the
// graph.  The F7 owner console will wire full policy mutation.
policyRouter.post("/policy", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: { code: "validation", message: "Request body must be valid JSON" } },
      400
    );
  }

  const policyYaml = typeof body.policy_yaml === "string" ? body.policy_yaml : null;
  if (!policyYaml) {
    return c.json(
      { error: { code: "validation", message: "Request body must include `policy_yaml` string" } },
      400
    );
  }

  const fh = c.get("freehold");
  const result = await proposePolicyChange(fh.graph, policyYaml);
  return c.json({ status: result.status, hash: result.hash });
});
