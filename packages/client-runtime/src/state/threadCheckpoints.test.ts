import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  RunId,
  type OrchestrationV2AssistantMessagePhase,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import { deriveThreadCheckpointSummaries } from "./threadCheckpoints.ts";

const runId = RunId.make("phase-run");
const message = (
  id: string,
  phase?: OrchestrationV2AssistantMessagePhase,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId: v2Projection.thread.id,
  runId,
  nodeId: null,
  role: "assistant",
  text: id,
  attachments: [],
  streaming: false,
  createdBy: "agent",
  creationSource: "provider",
  createdAt: v2Now,
  updatedAt: v2Now,
  ...(phase ? { phase } : {}),
});
const projectionFor = (
  messages: OrchestrationV2ConversationMessage[],
): OrchestrationV2ThreadProjection => ({
  ...v2Projection,
  messages,
  checkpoints: [
    {
      id: CheckpointId.make("checkpoint"),
      scopeId: CheckpointScopeId.make("scope"),
      threadId: v2Projection.thread.id,
      runId,
      appRunOrdinal: 1,
      nodeId: NodeId.make("node"),
      parentCheckpointId: null,
      ordinalWithinScope: 1,
      ref: CheckpointRef.make("refs/t3/checkpoints/phase"),
      status: "ready",
      files: [],
      capturedAt: v2Now,
    },
  ],
});

describe("phase-aware checkpoint answer binding", () => {
  it("anchors diffs to the true final rather than a late async acknowledgement", () => {
    const summaries = deriveThreadCheckpointSummaries(
      projectionFor([
        message("comment", "commentary"),
        message("answer", "final_answer"),
        message("late", "commentary"),
      ]),
    );
    expect(summaries[0]?.assistantMessageId).toBe("answer");
  });
  it("chooses the last explicit final and does not promote an unknown trailing reply", () => {
    const summaries = deriveThreadCheckpointSummaries(
      projectionFor([
        message("answer", "final_answer"),
        message("terminal-answer", "final_answer"),
        message("partial"),
      ]),
    );
    expect(summaries[0]?.assistantMessageId).toBe("terminal-answer");
  });
  it("does not attach a checkpoint to commentary-only output", () => {
    expect(
      deriveThreadCheckpointSummaries(projectionFor([message("comment", "commentary")]))[0]
        ?.assistantMessageId,
    ).toBeNull();
  });
  it("preserves upstream binding without phases", () => {
    expect(
      deriveThreadCheckpointSummaries(projectionFor([message("first"), message("last")]))[0]
        ?.assistantMessageId,
    ).toBe("last");
  });
});
