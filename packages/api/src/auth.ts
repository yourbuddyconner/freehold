import type { MiddlewareHandler } from "hono";
import { ERROR_CODES, apiError } from "./errors.js";
import type { AppEnv } from "./types.js";

/**
 * Constant-time byte-by-byte comparison to prevent timing side-channels on token validation.
 * Returns true only if the two strings are equal in both length and content.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) {
    // Still do a full pass over `a` to prevent length-based timing leaks
    let diff = 0;
    for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ (bBytes[i % bBytes.length] ?? 0);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export function bearerAuth(token: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!timingSafeEqual(bearer, token)) {
      return apiError(c, 401, ERROR_CODES.AUTH, "Missing or invalid bearer token");
    }
    await next();
  };
}
