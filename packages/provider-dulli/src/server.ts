/**
 * Dulli's server entry: the driver the server registers, plus the adapter
 * driver used by replay tests and the fixture recorder.
 *
 * @module provider-dulli/server
 */
export { DulliDriver, type DulliDriverEnv } from "./server/driver.ts";
export {
  DULLI_PROVIDER,
  DulliAdapterV2Driver,
  type DulliAdapterV2DriverEnv,
} from "./server/adapter.ts";

export {
  DulliBridgeRegistry,
  DulliSharedEnvironment,
  type DulliBridge,
  type DulliBridgeContext,
  type DulliBridgeFactory,
} from "./server/bridges.ts";

export * as PiSessionsClient from "./server/PiSessionsClient.ts";
export type { PiSessionInfo } from "./server/PiSessionsClient.ts";

export { resolvePiAgentDir } from "./server/piPaths.ts";
