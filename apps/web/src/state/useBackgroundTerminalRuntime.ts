import {
  EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
  type BackgroundTerminalRuntimeState,
} from "@t3tools/client-runtime/state/background-terminals";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "./query";
import { backgroundTerminalEnvironment } from "./backgroundTerminals";

export interface UseBackgroundTerminalRuntimeInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /**
   * Only subscribe when the active provider/session can support Pi
   * background terminals. When disabled the hook mounts nothing and returns
   * the empty state so no rows or controls render.
   */
  readonly enabled: boolean;
}

export interface UseBackgroundTerminalRuntimeResult {
  readonly state: BackgroundTerminalRuntimeState;
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * Live background-terminal runtime state for a thread. The underlying
 * subscription atom establishes the event stream and requests `replay` on
 * mount and on every reconnect, so the returned state is reconnect-safe and
 * rebuilt from snapshots without any imperative wiring here.
 */
export function useBackgroundTerminalRuntime(
  input: UseBackgroundTerminalRuntimeInput,
): UseBackgroundTerminalRuntimeResult {
  const atom =
    input.enabled && input.environmentId !== null && input.threadId !== null
      ? backgroundTerminalEnvironment.runtimeState({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        })
      : null;
  const query = useEnvironmentQuery(atom);
  return {
    state: query.data ?? EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
    error: query.error,
    isPending: query.isPending,
  };
}
