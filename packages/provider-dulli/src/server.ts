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
  type DulliBridge,
  type DulliBridgeContext,
  type DulliBridgeFactory,
} from "./server/bridges.ts";
