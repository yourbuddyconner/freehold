/**
 * API client singleton for the console.
 *
 * The daemon injects a `<meta name="freehold-token" content="…">` tag into
 * index.html at serve time (see packages/api/src/app.ts). This file reads
 * that tag and constructs the FreeholdClient, so the console never stores the
 * bearer token in localStorage or code.
 *
 * In development (Vite dev server), proxy /api to the running daemon at
 * http://127.0.0.1:8710. The meta tag approach still works because the daemon
 * also serves the dev proxy.
 */
import { FreeholdClient } from "@freehold/client";

export { ApiError } from "@freehold/client";

function readToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="freehold-token"]');
  return meta?.content ?? "";
}

export const apiClient = new FreeholdClient({
  baseUrl: "",
  token: readToken(),
});
