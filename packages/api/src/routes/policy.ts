import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const policyRouter = new Hono<AppEnv>();

// GET /policy
// TODO(F6): wire real policy ops from @freehold/core when available
policyRouter.get("/policy", (c) => {
  return c.json({ rules: [] });
});

// POST /policy
// TODO(F6): wire real policy mutation; currently returns a stub proposal
policyRouter.post("/policy", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: { code: "validation", message: "Request body must be valid JSON" } },
      400
    );
  }
  return c.json({ status: "held", proposal: body, rule: ["policy-changes-require-owner-review"] });
});
