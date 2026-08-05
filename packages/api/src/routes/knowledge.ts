import {
  attachDocument,
  classifyEntity,
  createEntity,
  relate,
  remember,
  syncIndex,
  updateEntity,
} from "@freehold/core";
import { Hono } from "hono";
import { z } from "zod";
import { ERROR_CODES, apiError } from "../errors.js";
import type { AppEnv } from "../types.js";

export const knowledgeRouter = new Hono<AppEnv>();

const RememberBody = z.object({
  agent: z.string(),
  content: z.string(),
});

knowledgeRouter.post("/remember", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = RememberBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const { agent, content } = parsed.data;
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  const result = await remember(fh.graph, agent, content);
  if (result.status === "saved") {
    await syncIndex(fh, embedder);
  }
  return c.json(result);
});

const CreateEntityBody = z.object({
  agent: z.string(),
  type: z.string(),
  attributes: z.record(z.unknown()),
  classification: z.string().optional(),
});

knowledgeRouter.post("/entities", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateEntityBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const { agent, type, attributes, classification } = parsed.data;
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  const result = await createEntity(fh.graph, agent, type, attributes, { classification });
  if (result.status === "saved") {
    await syncIndex(fh, embedder);
  }
  return c.json(result);
});

const UpdateEntityBody = z.object({
  agent: z.string(),
  type: z.string(),
  attributes: z.record(z.unknown()),
  prior: z.string().optional(),
});

knowledgeRouter.patch("/entities/:id", async (c) => {
  const nodeId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateEntityBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const { agent, type, attributes, prior } = parsed.data;
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  try {
    const result = await updateEntity(fh.graph, agent, nodeId, type, attributes, prior ?? null);
    if (result.status === "saved") {
      await syncIndex(fh, embedder);
    }
    return c.json(result);
  } catch (err) {
    // allod-wasm rejections are plain strings, not Error instances
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    if (message.includes("not found")) {
      return apiError(c, 404, ERROR_CODES.NOT_FOUND, message);
    }
    if (message.includes("prior-revision mismatch")) {
      return apiError(c, 409, ERROR_CODES.CONFLICT, message);
    }
    return apiError(c, 400, ERROR_CODES.VALIDATION, message);
  }
});

const RelateBody = z.object({
  agent: z.string(),
  from: z.string(),
  to: z.string(),
  edgeType: z.string(),
  attributes: z.record(z.unknown()).optional(),
  scratch: z.boolean().optional(),
});

knowledgeRouter.post("/relations", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = RelateBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const { agent, from, to, edgeType, attributes, scratch } = parsed.data;
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  const result = await relate(fh.graph, agent, from, to, edgeType, attributes, {
    scratch: scratch ?? true,
  });
  if (result.status === "saved") {
    await syncIndex(fh, embedder);
  }
  return c.json(result);
});

const ClassifyBody = z.object({
  agent: z.string(),
  nodeId: z.string(),
  term: z.string(),
  basis: z.enum(["model-assisted", "manual"]).optional(),
});

knowledgeRouter.post("/classifications", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ClassifyBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const { agent, nodeId, term, basis } = parsed.data;
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  const result = await classifyEntity(fh.graph, agent, nodeId, term, basis);
  if (result.status === "saved") {
    await syncIndex(fh, embedder);
  }
  return c.json(result);
});

const AttachDocumentBody = z.object({
  agent: z.string(),
  entityId: z.string(),
  content: z.string(),
  title: z.string().optional(),
  media_type: z.string().optional(),
});

knowledgeRouter.post("/documents", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = AttachDocumentBody.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, ERROR_CODES.VALIDATION, "Invalid request body");
  }
  const { agent, entityId, content, title, media_type } = parsed.data;
  const fh = c.get("freehold");
  const embedder = c.get("embedder");
  const result = await attachDocument(fh.graph, agent, entityId, content, title, media_type);
  if (result.status === "saved") {
    await syncIndex(fh, embedder);
  }
  return c.json(result);
});
