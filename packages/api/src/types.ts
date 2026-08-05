import type { FreeholdConfig } from "@freehold/core";
import type { Embedder } from "@freehold/core";
import type { Freehold } from "@freehold/core";
import type { GraphManager } from "@freehold/core";

export interface AppVariables {
  freehold: Freehold;
  embedder: Embedder;
  config: FreeholdConfig;
  manager: GraphManager;
}

export type AppEnv = { Variables: AppVariables };
