import { describeSchema, installOntology, proposeOntologyChange } from "@freehold/core";
import { Hono } from "hono";
import { z } from "zod";
import { ERROR_CODES, apiError } from "../errors.js";
import type { AppEnv } from "../types.js";

export const schemaRouter = new Hono<AppEnv>();

schemaRouter.get("/schema", (c) => {
  const fh = c.get("freehold");
  const schema = describeSchema(fh.graph);
  return c.json(schema);
});

const ProposeOntologyBody = z.object({
  agent: z.string(),
  packageName: z.string(),
  ontologyYaml: z.string(),
});

schemaRouter.post("/schema/proposals", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ProposeOntologyBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const { agent, packageName, ontologyYaml } = parsed.data;
  const fh = c.get("freehold");
  const result = await proposeOntologyChange(fh.graph, agent, packageName, ontologyYaml);
  return c.json(result);
});

const InstallOntologyBody = z.object({
  docsYaml: z.string(),
});

schemaRouter.post("/schema/install", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = InstallOntologyBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const fh = c.get("freehold");
  const result = await installOntology(fh.graph, parsed.data.docsYaml);
  return c.json(result);
});
