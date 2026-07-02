import {
  NonNegativeInt,
  EventId,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectWorkflowTaskIds,
  deriveWorkflowAgentStatus,
  deriveWorkflowRuns,
  groupWorkflowAgentsByPhase,
  isRemoteWorkflowRun,
  type WorkflowRunAgent,
} from "./workflow-logic.ts";

let nextActivityId = 0;

function buildActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "task.started",
    // summary/kind must be trimmed non-empty branded strings.
    summary: overrides.summary ?? "Workflow",
    tone: overrides.tone ?? "info",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined
      ? { sequence: NonNegativeInt.make(overrides.sequence) }
      : {}),
  };
}

describe("deriveWorkflowAgentStatus", () => {
  it("maps terminal states directly", () => {
    expect(deriveWorkflowAgentStatus({ state: "done" })).toBe("done");
    expect(deriveWorkflowAgentStatus({ state: "error" })).toBe("error");
  });

  it("treats start without startedAt as queued and with startedAt as running", () => {
    expect(deriveWorkflowAgentStatus({ state: "start" })).toBe("queued");
    expect(deriveWorkflowAgentStatus({ state: "start", startedAt: 123 })).toBe("running");
  });

  it("renders unknown future states as running once startedAt is present", () => {
    expect(deriveWorkflowAgentStatus({ state: "reticulating", startedAt: 1 })).toBe("running");
    expect(deriveWorkflowAgentStatus({ state: "reticulating" })).toBe("queued");
  });
});

describe("groupWorkflowAgentsByPhase", () => {
  const agent = (over: Partial<WorkflowRunAgent> & { index: number }): WorkflowRunAgent => ({
    state: "start",
    status: "queued",
    ...over,
  });

  it("groups agents under their phase and synthesizes an Agents phase for unphased agents", () => {
    const phases = groupWorkflowAgentsByPhase({
      phases: [{ index: 0, title: "Plan" }],
      agents: [
        agent({ index: 0, phaseIndex: 0 }),
        agent({ index: 1 }), // no phaseIndex -> synthetic "Agents" phase (index -1)
      ],
    });
    expect(phases.map((phase) => phase.title)).toEqual(["Agents", "Plan"]);
    const synthetic = phases.find((phase) => phase.title === "Agents");
    expect(synthetic?.index).toBe(-1);
    expect(synthetic?.agents.map((entry) => entry.index)).toEqual([1]);
  });

  it("falls back to a Phase <n> title when the phase is unknown but an agent references it", () => {
    const phases = groupWorkflowAgentsByPhase({
      phases: [],
      agents: [agent({ index: 0, phaseIndex: 2 })],
    });
    expect(phases).toHaveLength(1);
    expect(phases[0]?.title).toBe("Phase 2");
  });

  it("prefers an agent-supplied phaseTitle for an otherwise-unknown phase", () => {
    const phases = groupWorkflowAgentsByPhase({
      phases: [],
      agents: [agent({ index: 0, phaseIndex: 5, phaseTitle: "Custom" })],
    });
    expect(phases[0]?.title).toBe("Custom");
  });
});

function workflowStartedActivity(taskId: string, extra?: Record<string, unknown>) {
  return buildActivity({
    id: `start-${taskId}`,
    kind: "task.started",
    createdAt: "2026-02-23T00:00:01.000Z",
    turnId: "turn-1",
    payload: { taskId, taskType: "local_workflow", workflowName: "spec", ...extra },
  });
}

function workflowUpdatedActivity(
  taskId: string,
  workflowProgress: unknown[],
  extra?: Record<string, unknown>,
) {
  return buildActivity({
    id: `updated-${taskId}`,
    kind: "task.workflow-updated",
    createdAt: "2026-02-23T00:00:02.000Z",
    payload: { taskId, description: "spec workflow", workflowProgress, ...extra },
  });
}

describe("deriveWorkflowRuns", () => {
  it("derives a single running->completed lifecycle from started + updated + meta + completed", () => {
    const runs = deriveWorkflowRuns([
      workflowStartedActivity("task-1"),
      workflowUpdatedActivity("task-1", [
        { type: "workflow_phase", index: 0, title: "Plan" },
        { type: "workflow_agent", index: 0, state: "done", phaseIndex: 0 },
        { type: "workflow_log", message: "kicked off" },
      ]),
      buildActivity({
        id: "meta-task-1",
        kind: "task.workflow-meta",
        createdAt: "2026-02-23T00:00:03.000Z",
        payload: {
          taskId: "task-1",
          runId: "wf_abc",
          scriptPath: "/x/s.js",
          transcriptDir: "/x/t",
        },
      }),
      buildActivity({
        id: "complete-task-1",
        kind: "task.completed",
        createdAt: "2026-02-23T00:00:04.000Z",
        payload: { taskId: "task-1", status: "completed", detail: "all done" },
      }),
    ]);

    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.taskId).toBe("task-1");
    expect(run.status).toBe("completed");
    expect(run.name).toBe("spec");
    expect(run.completionSummary).toBe("all done");
    expect(run.handles?.runId).toBe("wf_abc");
    expect(run.logs).toEqual(["kicked off"]);
    expect(run.agentCounts).toEqual({ total: 1, queued: 0, running: 0, done: 1, error: 0 });
    expect(run.turnId).toBe(TurnId.make("turn-1"));
  });

  it("maps failed and stopped completion statuses", () => {
    const failed = deriveWorkflowRuns([
      workflowStartedActivity("task-f"),
      buildActivity({
        id: "complete-task-f",
        kind: "task.completed",
        createdAt: "2026-02-23T00:00:04.000Z",
        payload: { taskId: "task-f", status: "failed" },
      }),
    ]);
    expect(failed[0]?.status).toBe("failed");

    const stopped = deriveWorkflowRuns([
      workflowStartedActivity("task-s"),
      buildActivity({
        id: "complete-task-s",
        kind: "task.completed",
        createdAt: "2026-02-23T00:00:04.000Z",
        payload: { taskId: "task-s", status: "stopped" },
      }),
    ]);
    expect(stopped[0]?.status).toBe("stopped");
  });

  it("derives agent status per entry (queued/running/done/error/unknown-with-startedAt)", () => {
    const runs = deriveWorkflowRuns([
      workflowStartedActivity("task-1"),
      workflowUpdatedActivity("task-1", [
        { type: "workflow_agent", index: 0, state: "start" },
        { type: "workflow_agent", index: 1, state: "start", startedAt: 100 },
        { type: "workflow_agent", index: 2, state: "done" },
        { type: "workflow_agent", index: 3, state: "error" },
        { type: "workflow_agent", index: 4, state: "reticulating", startedAt: 5 },
      ]),
    ]);
    expect(runs[0]?.agentCounts).toEqual({
      total: 5,
      queued: 1,
      running: 2,
      done: 1,
      error: 1,
    });
  });

  it("lets a later agent entry with the same index win", () => {
    const runs = deriveWorkflowRuns([
      workflowStartedActivity("task-1"),
      workflowUpdatedActivity("task-1", [
        { type: "workflow_agent", index: 0, state: "start" },
        { type: "workflow_agent", index: 0, state: "done" },
      ]),
    ]);
    expect(runs[0]?.agentCounts.total).toBe(1);
    expect(runs[0]?.agentCounts.done).toBe(1);
    expect(runs[0]?.agentCounts.queued).toBe(0);
  });

  it("drops malformed progress entries without throwing", () => {
    const runs = deriveWorkflowRuns([
      workflowStartedActivity("task-1"),
      workflowUpdatedActivity("task-1", [
        { type: "workflow_agent", state: "start" }, // missing index
        { type: "workflow_agent", index: 1 }, // missing state
        "not an object",
        null,
        { type: "workflow_mystery", index: 9 },
        { type: "workflow_agent", index: 2, state: "done" },
      ]),
    ]);
    expect(runs[0]?.agentCounts.total).toBe(1);
    expect(runs[0]?.agentCounts.done).toBe(1);
  });

  it("parses per-agent tokens, tool calls, and duration from the snapshot", () => {
    const runs = deriveWorkflowRuns([
      workflowStartedActivity("task-1"),
      workflowUpdatedActivity("task-1", [
        {
          type: "workflow_agent",
          index: 0,
          state: "done",
          tokens: 94_200,
          toolCalls: 47,
          durationMs: 423_000,
        },
      ]),
    ]);
    const agent = runs[0]?.phases.flatMap((phase) => phase.agents)[0];
    expect(agent?.tokens).toBe(94_200);
    expect(agent?.toolCalls).toBe(47);
    expect(agent?.durationMs).toBe(423_000);
  });

  it("parses snake_case usage from the updated snapshot", () => {
    const runs = deriveWorkflowRuns([
      workflowStartedActivity("task-1"),
      workflowUpdatedActivity("task-1", [{ type: "workflow_agent", index: 0, state: "done" }], {
        usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4500 },
      }),
    ]);
    expect(runs[0]?.usage).toEqual({ totalTokens: 1200, toolUses: 3, durationMs: 4500 });
  });

  it("ignores plain (non-workflow) tasks entirely", () => {
    const runs = deriveWorkflowRuns([
      buildActivity({
        id: "plain-start",
        kind: "task.started",
        payload: { taskId: "plain-1", taskType: "plan" },
      }),
      buildActivity({
        id: "plain-progress",
        kind: "task.progress",
        payload: { taskId: "plain-1", summary: "thinking" },
      }),
      buildActivity({
        id: "plain-complete",
        kind: "task.completed",
        payload: { taskId: "plain-1", status: "completed" },
      }),
    ]);
    expect(runs).toEqual([]);
  });

  it("terminalizes a still-running run and settles in-flight agents when the session is gone", () => {
    const runs = deriveWorkflowRuns(
      [
        workflowStartedActivity("task-1"),
        workflowUpdatedActivity("task-1", [
          { type: "workflow_agent", index: 0, state: "done" },
          { type: "workflow_agent", index: 1, state: "start", startedAt: 1000 },
          { type: "workflow_agent", index: 2, state: "start" },
        ]),
      ],
      { sessionActive: false },
    );
    const run = runs[0];
    expect(run?.status).toBe("stopped");
    const agents = run?.phases.flatMap((phase) => phase.agents) ?? [];
    expect(agents.map((agent) => agent.status)).toEqual(["done", "error", "error"]);
    expect(agents[1]?.error).toBe("Interrupted before completion");
    expect(run?.agentCounts).toEqual({ total: 3, queued: 0, running: 0, done: 1, error: 2 });
  });

  it("applies a completion even when it sorts before its task.started", () => {
    const completed = buildActivity({
      id: "completed-task-1",
      kind: "task.completed",
      createdAt: "2026-02-23T00:00:00.500Z",
      sequence: 1,
      payload: { taskId: "task-1", status: "completed", detail: "done" },
    });
    // Same-timestamp + inverted sequence (adopted runs can reset provider
    // sequence): the started activity sorts after the completion.
    const started = { ...workflowStartedActivity("task-1"), sequence: NonNegativeInt.make(5) };
    const runs = deriveWorkflowRuns([completed, started]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.name).toBe("spec");
  });

  it("keeps a running run untouched while the session is active", () => {
    const runs = deriveWorkflowRuns(
      [
        workflowStartedActivity("task-1"),
        workflowUpdatedActivity("task-1", [
          { type: "workflow_agent", index: 0, state: "start", startedAt: 1000 },
        ]),
      ],
      { sessionActive: true },
    );
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.phases.flatMap((phase) => phase.agents)[0]?.status).toBe("running");
  });

  it("detects remote runs from session handles", () => {
    const runs = deriveWorkflowRuns([
      workflowStartedActivity("task-remote"),
      buildActivity({
        id: "meta-remote",
        kind: "task.workflow-meta",
        createdAt: "2026-02-23T00:00:03.000Z",
        payload: { taskId: "task-remote", sessionUrl: "https://example.com/run" },
      }),
    ]);
    expect(runs).toHaveLength(1);
    expect(isRemoteWorkflowRun(runs[0]!)).toBe(true);
  });
});

describe("collectWorkflowTaskIds", () => {
  it("collects workflow task ids via workflowName, local_workflow task type, and workflow kinds", () => {
    const ids = collectWorkflowTaskIds([
      buildActivity({
        id: "s1",
        kind: "task.started",
        payload: { taskId: "by-name", workflowName: "spec" },
      }),
      buildActivity({
        id: "s2",
        kind: "task.started",
        payload: { taskId: "by-type", taskType: "local_workflow" },
      }),
      buildActivity({
        id: "u1",
        kind: "task.workflow-updated",
        payload: { taskId: "by-updated", workflowProgress: [] },
      }),
      buildActivity({
        id: "m1",
        kind: "task.workflow-meta",
        payload: { taskId: "by-meta" },
      }),
    ]);
    expect([...ids].sort()).toEqual(["by-meta", "by-name", "by-type", "by-updated"]);
  });

  it("does not collect plain task ids", () => {
    const ids = collectWorkflowTaskIds([
      buildActivity({
        id: "plain",
        kind: "task.started",
        payload: { taskId: "plain-1", taskType: "plan" },
      }),
      buildActivity({
        id: "plain-progress",
        kind: "task.progress",
        payload: { taskId: "plain-1" },
      }),
    ]);
    expect(ids.has("plain-1")).toBe(false);
    expect(ids.size).toBe(0);
  });
});
