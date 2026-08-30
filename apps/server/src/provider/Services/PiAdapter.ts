/**
 * PiAdapter — provider-native runtime adapter contract for the Pi driver.
 *
 * Like the other drivers, there is no Context tag: the `PiDriver` bundles one
 * adapter closure per instance (`makePiAdapter`). This interface exists purely
 * to name the shape at call sites.
 *
 * @module provider/Services/PiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
