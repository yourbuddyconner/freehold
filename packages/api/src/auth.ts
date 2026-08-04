import type { MiddlewareHandler } from "hono";
import { ERROR_CODES, apiError } from "./errors.js";
import type { AppEnv } from "./types.js";

export function bearerAuth(token: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (bearer !== token) {
      return apiError(c, 401, ERROR_CODES.AUTH, "Missing or invalid bearer token");
    }
    await next();
  };
}
