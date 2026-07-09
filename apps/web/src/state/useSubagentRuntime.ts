import {
  EMPTY_SUBAGENT_RUNTIME_STATE,
  type SubagentRuntimeState,
} from "@t3tools/client-runtime/state/subagents";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "./query";
import { subagentEnvironment } from "./subagents";

export interface UseSubagentRuntimeInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /**
   * Only subscribe when the active provider/session can support Pi subagents.
   * When disabled the hook mounts nothing and returns the empty state so no
   * rows or controls render.
   */
  readonly enabled: boolean;
}

export interface UseSubagentRuntimeResult {
  readonly state: SubagentRuntimeState;
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * Live subagent runtime state for a thread. The underlying subscription atom
 * establishes the event stream and requests `replay` on mount and on every
 * reconnect, so the returned state is reconnect-safe and rebuilt from snapshots
 * without any imperative wiring here.
 */
export function useSubagentRuntime(input: UseSubagentRuntimeInput): UseSubagentRuntimeResult {
  const atom =
    input.enabled && input.environmentId !== null && input.threadId !== null
      ? subagentEnvironment.runtimeState({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        })
      : null;
  const query = useEnvironmentQuery(atom);
  return {
    state: query.data ?? EMPTY_SUBAGENT_RUNTIME_STATE,
    error: query.error,
    isPending: query.isPending,
  };
}
