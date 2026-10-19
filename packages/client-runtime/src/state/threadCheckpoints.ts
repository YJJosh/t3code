import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

/** Derives the checkpoint/diff rows needed by review UIs from native V2 entities. */
export function deriveThreadCheckpointSummaries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  const lastReplyByRun = new Map<RunId, MessageId>();
  const lastFinalByRun = new Map<RunId, MessageId>();
  for (const message of projection.messages) {
    if (message.runId === null || message.role !== "assistant") continue;
    if (message.phase !== "commentary") lastReplyByRun.set(message.runId, message.id);
    if (message.phase === "final_answer") lastFinalByRun.set(message.runId, message.id);
  }
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    // REVIEW: the final answer owns the diff, else the last non-commentary
    // reply (upstream rule). An interrupted Dulli reply has no phase.
    const assistantMessageId =
      lastFinalByRun.get(checkpoint.runId) ?? lastReplyByRun.get(checkpoint.runId) ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}
