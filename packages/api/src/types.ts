import type { FreeholdConfig } from "@freehold/core";
import type { Embedder } from "@freehold/core";
import type { Freehold } from "@freehold/core";
import type { GraphManager } from "@freehold/core";

export interface AppVariables {
  freehold: Freehold;
  embedder: Embedder;
  config: FreeholdConfig;
  manager: GraphManager;
  /** Injectable fetch for the manifest-conversion HTTP call. Defaults to global fetch when unset. */
  fetchFn?: typeof fetch;
}

export type AppEnv = { Variables: AppVariables };
