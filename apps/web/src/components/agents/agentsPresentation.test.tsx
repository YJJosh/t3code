import type {
  RuntimeSubagent,
  RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import {
  agentActivityText,
  formatAgentElapsedSeconds,
  preferredInspectorAgent,
} from "./agentsPresentation";

function makeAgent(
  id: string,
  status: RuntimeSubagentStatus,
  overrides: Partial<RuntimeSubagent> = {},
): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    title: id,
    role: null,
    model: null,
    effort: null,
    status,
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("agent inspector presentation", () => {
  it("prioritizes waiting agents, then active agents, then failures", () => {
    const settled = makeAgent("settled", "completed");
    const failed = makeAgent("failed", "failed");
    const active = makeAgent("active", "running");
    const waiting = makeAgent("waiting", "waiting");

    expect(preferredInspectorAgent([settled, failed, active, waiting])?.id).toBe("waiting");
    expect(preferredInspectorAgent([settled, failed, active])?.id).toBe("active");
    expect(preferredInspectorAgent([settled, failed])?.id).toBe("failed");
  });

  it("does not select a workflow coordinator ahead of its agent", () => {
    const workflow = makeAgent("workflow", "running", { kind: "workflow" });
    const agent = makeAgent("agent", "completed");

    expect(preferredInspectorAgent([workflow, agent])?.id).toBe("agent");
  });

  it("keeps live progress ahead of older result text", () => {
    expect(
      agentActivityText(
        makeAgent("active", "running", {
          progress: "Reading tests",
          result: "Old activation result",
        }),
      ),
    ).toBe("Reading tests");
  });

  it("formats elapsed time without sub-second churn", () => {
    expect(formatAgentElapsedSeconds(9.9)).toBe("9s");
    expect(formatAgentElapsedSeconds(65)).toBe("1m 05s");
    expect(formatAgentElapsedSeconds(3_661)).toBe("1h 01m");
  });
});
