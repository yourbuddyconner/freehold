import type { FreeholdConfig } from "@freehold/core";
import type { Embedder } from "@freehold/core";
import type { Freehold } from "@freehold/core";

export interface AppVariables {
  freehold: Freehold;
  embedder: Embedder;
  config: FreeholdConfig;
}

export type AppEnv = { Variables: AppVariables };
