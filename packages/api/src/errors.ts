import type { Context } from "hono";

export const ERROR_CODES = {
  AUTH: "auth",
  NOT_FOUND: "not_found",
  POLICY_REJECTED: "policy_rejected",
  VALIDATION: "validation",
  ALREADY_DECIDED: "already_decided",
  CONFLICT: "conflict",
  INTERNAL: "internal",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function apiError(
  // biome-ignore lint/suspicious/noExplicitAny: Hono context is generic
  c: Context<any>,
  status: 400 | 401 | 404 | 409 | 500,
  code: ErrorCode,
  message: string
) {
  return c.json({ error: { code, message } }, status);
}
