/**
 * POST /api/v1/repos/onboard
 *
 * Server-side repo onboarding: runs allod init, generates a key, registers
 * the graph, and optionally indexes. The daemon has filesystem access; the
 * web UI uses this endpoint instead of running CLIs directly.
 *
 * Returns a step list (each with step/status/detail) plus the registered
 * GraphEntry on success. On failure, returns the step list with the failed
 * step's error and a 400 status.
 */

import { onboardRepo } from "@freehold/core";
import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const reposRouter = new Hono<AppEnv>();

reposRouter.post("/repos/onboard", async (c) => {
  const manager = c.get("manager");
  const config = c.get("config");

  let body: {
    path?: string;
    name?: string;
    id?: string;
    principal?: string;
    noIndex?: boolean;
    defaultBranch?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!body.path || typeof body.path !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  const allodBin = config.allodBin ?? "allod";

  try {
    const result = await onboardRepo(manager, {
      path: body.path,
      name: body.name,
      id: body.id,
      principal: body.principal,
      noIndex: body.noIndex,
      defaultBranch: body.defaultBranch,
      allodBin,
    });

    return c.json(
      {
        steps: result.steps,
        entry: result.entry,
        keyPath: result.keyPath,
        principal: result.principal,
      },
      201
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const steps = (err as { steps?: unknown }).steps;
    return c.json({ error: message, steps: steps ?? [] }, 400);
  }
});
