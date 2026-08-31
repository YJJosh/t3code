import * as PubSub from "effect/PubSub";

import type { ProviderBackgroundTerminalEvent } from "./Services/ProviderAdapter.ts";

/**
 * Bound each subscriber queue so a suspended WebSocket cannot retain an
 * unbounded stream of background-process output. The client detects sequence
 * gaps and waits for the bridge's next authoritative replace/upsert/snapshot.
 */
export const BACKGROUND_TERMINAL_EVENT_BUFFER_CAPACITY = 256;

export const makeBackgroundTerminalEventPubSub = () =>
  PubSub.sliding<ProviderBackgroundTerminalEvent>(BACKGROUND_TERMINAL_EVENT_BUFFER_CAPACITY);
