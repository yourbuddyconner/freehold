import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const graphsRouter = new Hono<AppEnv>();

/**
 * GET /api/v1/graphs
 *
 * List all registered graph entries.
 */
graphsRouter.get("/graphs", async (c) => {
  const manager = c.get("manager");
  const graphs = await manager.list();
  return c.json({ graphs });
});

/**
 * POST /api/v1/graphs
 *
 * Register a repo graph. Body: { path, id?, name? }
 * Returns 201 with the new GraphEntry, or 400 with error message.
 */
graphsRouter.post("/graphs", async (c) => {
  const manager = c.get("manager");
  let body: { path?: string; id?: string; name?: string; signingPrincipal?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!body.path || typeof body.path !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  try {
    const entry = await manager.registerRepo(body.path, {
      id: body.id,
      name: body.name,
      signingPrincipal: body.signingPrincipal,
    });
    return c.json(entry, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

/**
 * PATCH /api/v1/graphs/:id
 *
 * Update mutable settings: name, autoPushNotes, embedder.
 * Returns 200 with updated GraphEntry, or 404 if unknown.
 */
graphsRouter.patch("/graphs/:id", async (c) => {
  const manager = c.get("manager");
  const id = c.req.param("id");

  let body: { name?: string; autoPushNotes?: boolean; embedder?: "hash" | "semantic" };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  try {
    const entry = await manager.updateSettings(id, {
      name: body.name,
      autoPushNotes: body.autoPushNotes,
      embedder: body.embedder,
    });
    return c.json(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // entry() throws "graph not registered" for unknown ids
    if (message.includes("not registered")) {
      return c.json({ error: "unknown graph" }, 404);
    }
    return c.json({ error: message }, 400);
  }
});

/**
 * DELETE /api/v1/graphs/:id
 *
 * Remove a registry entry. Returns 204 on success, 409 if default graph.
 */
graphsRouter.delete("/graphs/:id", async (c) => {
  const manager = c.get("manager");
  const id = c.req.param("id");

  try {
    await manager.remove(id);
    return new Response(null, { status: 204 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("cannot remove the default graph")) {
      return c.json({ error: message }, 409);
    }
    if (message.includes("not registered")) {
      return c.json({ error: "unknown graph" }, 404);
    }
    return c.json({ error: message }, 400);
  }
});
