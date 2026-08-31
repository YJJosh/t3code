import type {
  AgentPanelModel,
  RuntimeSubagent,
  RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import {
  agentActivityText,
  agentRosterBatches,
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

  it("keeps direct agents and workflows from the same prompt in one ordered batch", () => {
    const direct = makeAgent("direct", "completed", { originTurnId: "turn-1" });
    const coordinator = makeAgent("workflow", "running", {
      kind: "workflow",
      originTurnId: "turn-1",
    });
    const child = makeAgent("child", "running", {
      kind: "workflow_agent",
      parentAgentId: coordinator.id,
      originTurnId: "turn-1",
    });
    const model: AgentPanelModel = {
      workflows: [
        {
          workflow: coordinator,
          phases: [
            {
              index: 0,
              title: "Implementation",
              members: [child],
              state: "running",
              activeCount: 1,
              settledCount: 0,
            },
          ],
          unphasedMembers: [],
        },
      ],
      directAgents: [direct],
      directAgentGroups: [
        {
          id: "direct-turn:turn-1",
          turnId: "turn-1",
          firstSeenAt: direct.firstSeenAt,
          agents: [direct],
        },
      ],
      runningCount: 1,
      waitingCount: 0,
      idleCount: 0,
      settledCount: 1,
      totalTokens: 0,
      hasAgents: true,
      liveCount: 1,
    };

    const batches = agentRosterBatches(model);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.directAgents.map((agent) => agent.id)).toEqual(["direct"]);
    expect(batches[0]?.workflows.map((group) => group.workflow.id)).toEqual(["workflow"]);
  });

  it("formats elapsed time without sub-second churn", () => {
    expect(formatAgentElapsedSeconds(9.9)).toBe("9s");
    expect(formatAgentElapsedSeconds(65)).toBe("1m 05s");
    expect(formatAgentElapsedSeconds(3_661)).toBe("1h 01m");
  });
});
