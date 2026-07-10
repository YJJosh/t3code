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
  readonly enabled: boolean;
}

export interface UseSubagentRuntimeResult {
  readonly state: SubagentRuntimeState;
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * Reconnect-safe Pi child-run state backed by the shared environment atom and
 * reducer. Unsupported providers mount no subscription and stay empty.
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
