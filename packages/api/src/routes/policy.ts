import { getPolicy, proposePolicyChange } from "@freehold/core";
import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const policyRouter = new Hono<AppEnv>();

// GET /policy — return the graph's active policy name, definition YAML, and parsed rules array.
policyRouter.get("/policy", async (c) => {
  const fh = c.get("freehold");
  const policy = await getPolicy(fh.graph);
  if (!policy) {
    return c.json({ rules: [] });
  }
  // Return rules alongside name+definition so the console can render and edit individual rules.
  return c.json({ name: policy.name, definition: policy.definition, rules: policy.rules ?? [] });
});

// POST /policy — propose a policy change.
//
// Writes a real set-policy changeset via the wasm `install_policy` binding.
// The operation is governed, so the proposal stays pending until the owner
// approves it in the Inbox. The optional `agent` field sets the authoring
// principal; without it the owner proposes (the console's edit flow).
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

  // Optional authoring agent — omitted means the owner proposes.
  const agent = typeof body.agent === "string" ? body.agent : undefined;

  const fh = c.get("freehold");
  const result = await proposePolicyChange(fh.graph, policyYaml, agent);
  return c.json({ status: result.status, hash: result.hash });
});
