/**
 * Re-export of the GitHub App mode utilities from @freehold/core.
 *
 * Tests import from this path so they can call mintAppJwt and makeAppClient
 * without depending on the internal package path.
 */
export { mintAppJwt, makeAppClient, clearAppClientCache, buildConnectorManifest } from "@freehold/core";
export type { AppManifest } from "@freehold/core";
