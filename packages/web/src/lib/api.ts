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
 *
 * Graph selection: the active graph id is persisted in localStorage under the
 * key "freehold-graph". The default graph ("main") uses id undefined so that
 * existing paths stay unchanged when no graph is selected.
 */
import { FreeholdClient } from "@freehold/client";

export { ApiError } from "@freehold/client";

export const GRAPH_STORAGE_KEY = "freehold-graph";

function readToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="freehold-token"]');
  return meta?.content ?? "";
}

function readStoredGraphId(): string | undefined {
  try {
    const stored = localStorage.getItem(GRAPH_STORAGE_KEY);
    // "main" is the default — treat it as no graph prefix (same as undefined)
    return stored && stored !== "main" ? stored : undefined;
  } catch {
    return undefined;
  }
}

export const apiClient = new FreeholdClient({
  baseUrl: "",
  token: readToken(),
  graphId: readStoredGraphId(),
});

/**
 * Persist the selected graph and update the shared client.
 * Callers should invalidate all TanStack Query caches after calling this.
 *
 * @param id Graph id, or "main" / undefined for the default graph.
 */
export function setActiveGraph(id: string | undefined): void {
  try {
    if (id && id !== "main") {
      localStorage.setItem(GRAPH_STORAGE_KEY, id);
    } else {
      localStorage.removeItem(GRAPH_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable (e.g. private browsing storage limit)
  }
  apiClient.setGraphId(id === "main" ? undefined : id);
}
