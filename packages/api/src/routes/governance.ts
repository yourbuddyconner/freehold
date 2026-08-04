import {
  approve,
  pending,
  principals,
  registerAgent,
  reindex,
  reject,
  syncIndex,
  verifyGraph,
} from "@freehold/core";
import { Hono } from "hono";
import { z } from "zod";
import { ERROR_CODES, apiError } from "../errors.js";
import type { AppEnv } from "../types.js";

/**
 * Classify an error thrown by allod's WASM decide() into an HTTP status code
 * and API error code.  The error is a plain JS Error whose message is the
 * AllodError Display string produced by Rust (e.g. "proposal not found: …").
 */
function classifyDecideError(err: unknown): {
  status: 400 | 404 | 409 | 500;
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
  message: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("proposal not found:")) {
    return { status: 404, code: ERROR_CODES.NOT_FOUND, message: "Proposal not found" };
  }
  if (msg.startsWith("already decided:")) {
    return {
      status: 409,
      code: ERROR_CODES.ALREADY_DECIDED,
      message: "Proposal has already been decided",
    };
  }
  console.error("[freehold] decide error:", msg);
  return { status: 500, code: ERROR_CODES.INTERNAL, message: "Internal error" };
}

export const governanceRouter = new Hono<AppEnv>();

governanceRouter.get("/proposals", (c) => {
  const fh = c.get("freehold");
  const proposals = pending(fh.graph);
  return c.json({ proposals });
});

governanceRouter.post("/proposals/:hash/approve", async (c) => {
  const hash = c.req.param("hash");
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  // SAFETY: single-token model — bearer possession implies owner authority until multi-principal auth lands (post-v0).
  try {
    const result = await approve(fh.graph, "owner", hash);
    if (result.status === "approved") {
      await syncIndex(fh, embedder);
    }
    return c.json(result);
  } catch (err) {
    const { status, code, message } = classifyDecideError(err);
    return apiError(c, status, code, message);
  }
});

governanceRouter.post("/proposals/:hash/reject", async (c) => {
  const hash = c.req.param("hash");
  const fh = c.get("freehold");
  // SAFETY: single-token model — bearer possession implies owner authority until multi-principal auth lands (post-v0).
  try {
    const result = await reject(fh.graph, "owner", hash);
    return c.json(result);
  } catch (err) {
    const { status, code, message } = classifyDecideError(err);
    return apiError(c, status, code, message);
  }
});

governanceRouter.get("/verify", (c) => {
  const fh = c.get("freehold");
  const report = verifyGraph(fh.graph);
  return c.json(report);
});

governanceRouter.post("/reindex", async (c) => {
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  await reindex(fh, embedder);
  return c.json({ status: "ok" });
});

governanceRouter.get("/principals", (c) => {
  const fh = c.get("freehold");
  const list = principals(fh.graph);
  return c.json({ principals: list });
});

const RegisterAgentBody = z.object({
  name: z.string(),
});

governanceRouter.post("/agents", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = RegisterAgentBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const fh = c.get("freehold");
  // SAFETY: single-token model — bearer possession implies owner authority until multi-principal auth lands (post-v0).
  const result = await registerAgent(fh.graph, parsed.data.name, "owner");
  return c.json(result);
});
