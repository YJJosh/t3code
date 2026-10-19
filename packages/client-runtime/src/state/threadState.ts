import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * Progressive history cursor for bounded hydration. Absent/cleared on full
   * snapshot paths. Errors here are thread/history-local and must not be
   * promoted into the environment disconnect path.
   */
  readonly history: ThreadHistoryMeta;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
};

export type ThreadSyncPhase = "loading" | "syncing" | "disconnected" | "failed";

/** Cached data is not evidence that a subscription is actively catching up. */
export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
  readonly error?: string | null;
}): ThreadSyncPhase | null {
  if (!input.shellExists || input.status === "deleted") return null;
  if (input.error) return "failed";
  switch (input.status) {
    case "empty":
    case "cached":
      return "disconnected";
    case "synchronizing":
      return input.detailExists ? "syncing" : "loading";
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  switch (phase) {
    case "loading":
      return "Loading messages...";
    case "syncing":
      return "Syncing messages...";
    case "disconnected":
      return "Messages disconnected";
    case "failed":
      return "Message sync failed";
  }
}
