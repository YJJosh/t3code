import { describe, expect, it } from "vite-plus/test";

import {
  PI_SUBAGENT_EVENT_CONTRACT_VERSION,
  type PiSubagentEvent,
  type PiSubagentReplayEvent,
  type PiSubagentRunStatus,
  type PiSubagentRunView,
} from "@t3tools/contracts";

import {
  applySubagentEvent,
  EMPTY_SUBAGENT_RUNTIME_STATE,
  hasSubagentRuns,
  isSubagentRunActive,
  isSubagentRunTerminal,
  selectActiveSubagentRuns,
  selectSubagentControlResult,
  selectSubagentRun,
  selectSubagentRuns,
  subagentRunNeedsInput,
  type SubagentRuntimeState,
} from "./subagentRuntime.ts";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  turns: 0,
  cost_estimate_usd: 0,
} as const;

function runView(overrides: Partial<PiSubagentRunView> & { runId: string }): PiSubagentRunView {
  return {
    task: `Task ${overrides.runId}`,
    model: "claude-opus-4-8",
    state: "running",
    directory: "/workspace",
    skills: [],
    turns: 0,
    activeMs: 0,
    usageSoFar: EMPTY_USAGE,
    openQuestions: [],
    checkAfterTokens: 0,
    nextCheckTokens: 0,
    managerCheckPending: false,
    ...overrides,
  };
}

function event(overrides: Partial<PiSubagentEvent> & { sequence: number }): PiSubagentEvent {
  return {
    contractVersion: PI_SUBAGENT_EVENT_CONTRACT_VERSION,
    managerId: "manager-1",
    timestamp: `2026-04-01T00:00:${String(overrides.sequence).padStart(2, "0")}.000Z`,
    kind: "run_running",
    ...overrides,
  };
}

function replayEvent(
  overrides: Partial<PiSubagentReplayEvent> & { sequence: number },
): PiSubagentReplayEvent {
  return {
    contractVersion: PI_SUBAGENT_EVENT_CONTRACT_VERSION,
    managerId: "manager-1",
    timestamp: `2026-04-01T00:00:${String(overrides.sequence).padStart(2, "0")}.000Z`,
    kind: "run_running",
    replay: true,
    ...overrides,
  };
}

describe("applySubagentEvent", () => {
  it("creates a run from a run_created event carrying a view", () => {
    const next = applySubagentEvent(
      EMPTY_SUBAGENT_RUNTIME_STATE,
      event({
        sequence: 1,
        kind: "run_created",
        runId: "run-a",
        view: runView({ runId: "run-a", state: "spawning" }),
      }),
    );

    expect(hasSubagentRuns(next)).toBe(true);
    expect(next.managerId).toBe("manager-1");
    const run = selectSubagentRun(next, "run-a");
    expect(run?.view.state).toBe("spawning");
    expect(next.version).toBe(1);
  });

  it("ignores duplicate and stale sequences for a manager", () => {
    const created = applySubagentEvent(
      EMPTY_SUBAGENT_RUNTIME_STATE,
      event({
        sequence: 5,
        kind: "run_created",
        runId: "run-a",
        view: runView({ runId: "run-a" }),
      }),
    );

    const duplicate = applySubagentEvent(
      created,
      event({
        sequence: 5,
        kind: "run_running",
        runId: "run-a",
        view: runView({ runId: "run-a", state: "needs_input" }),
      }),
    );
    expect(duplicate).toBe(created);

    const stale = applySubagentEvent(
      created,
      event({
        sequence: 3,
        kind: "run_running",
        runId: "run-a",
        view: runView({ runId: "run-a", state: "needs_input" }),
      }),
    );
    expect(stale).toBe(created);
    expect(selectSubagentRun(created, "run-a")?.view.state).toBe("running");
  });

  it("dedupes per manager, not globally", () => {
    const first = applySubagentEvent(
      EMPTY_SUBAGENT_RUNTIME_STATE,
      event({
        sequence: 10,
        managerId: "manager-1",
        kind: "run_created",
        runId: "run-a",
        view: runView({ runId: "run-a" }),
      }),
    );
    // A lower sequence from a *different* manager must still apply.
    const second = applySubagentEvent(
      first,
      event({
        sequence: 2,
        managerId: "manager-2",
        kind: "run_created",
        runId: "run-b",
        view: runView({ runId: "run-b" }),
      }),
    );
    expect(selectSubagentRuns(second)).toHaveLength(2);
    expect(second.managerSequences.get("manager-1")).toBe(10);
    expect(second.managerSequences.get("manager-2")).toBe(2);
  });

  it("appends bounded child activity for a known run", () => {
    let state = applySubagentEvent(
      EMPTY_SUBAGENT_RUNTIME_STATE,
      event({
        sequence: 1,
        kind: "run_created",
        runId: "run-a",
        view: runView({ runId: "run-a" }),
      }),
    );
    for (let index = 0; index < 5; index += 1) {
      state = applySubagentEvent(
        state,
        event({
          sequence: index + 2,
          kind: "child_tool",
          runId: "run-a",
          activity: { type: "tool_use", data: { name: `tool-${index}` } },
        }),
        { maxActivity: 3 },
      );
    }
    const run = selectSubagentRun(state, "run-a");
    expect(run?.activity).toHaveLength(3);
    expect(run?.activity.at(-1)?.data["name"]).toBe("tool-4");
    expect(run?.activity[0]?.data["name"]).toBe("tool-2");
  });

  it("drops child activity for a run whose view has not been seen", () => {
    const next = applySubagentEvent(
      EMPTY_SUBAGENT_RUNTIME_STATE,
      event({
        sequence: 1,
        kind: "child_tool",
        runId: "unknown",
        activity: { type: "tool_use", data: {} },
      }),
    );
    expect(hasSubagentRuns(next)).toBe(false);
  });

  it("records control results keyed by requestId", () => {
    const next = applySubagentEvent(
      EMPTY_SUBAGENT_RUNTIME_STATE,
      event({
        sequence: 1,
        kind: "control_result",
        control: { requestId: "req-1", action: "steer", success: true },
      }),
    );
    expect(selectSubagentControlResult(next, "req-1")?.success).toBe(true);
    expect(selectSubagentControlResult(next, "missing")).toBeNull();
  });

  it("rebuilds run set and replays nested events from a snapshot", () => {
    // Prime with a live run that the snapshot will not contain.
    const primed = applySubagentEvent(
      EMPTY_SUBAGENT_RUNTIME_STATE,
      event({
        sequence: 1,
        kind: "run_created",
        runId: "stale",
        view: runView({ runId: "stale" }),
      }),
    );

    const snapshotEvent = event({
      sequence: 20,
      kind: "snapshot",
      snapshot: {
        runs: [runView({ runId: "run-a", state: "running" })],
        events: [
          replayEvent({
            sequence: 12,
            kind: "child_message",
            runId: "run-a",
            activity: { type: "message", data: { text: "second" } },
          }),
          replayEvent({
            sequence: 10,
            kind: "run_created",
            runId: "run-a",
            view: runView({ runId: "run-a", state: "spawning" }),
          }),
          replayEvent({
            sequence: 11,
            kind: "child_message",
            runId: "run-a",
            activity: { type: "message", data: { text: "first" } },
          }),
        ],
      },
    });

    const rebuilt = applySubagentEvent(primed, snapshotEvent);
    expect(selectSubagentRun(rebuilt, "stale")).toBeNull();
    const run = selectSubagentRun(rebuilt, "run-a");
    expect(run).not.toBeNull();
    // Nested events apply in sequence order, but their historical views cannot
    // overwrite the authoritative current view supplied by the snapshot.
    expect(run?.activity.map((entry) => entry.data["text"])).toEqual(["first", "second"]);
    expect(run?.view.state).toBe("running");
    expect(run?.updatedAt).toBe(snapshotEvent.timestamp);
    expect(rebuilt.managerSequences.get("manager-1")).toBe(20);
  });

  it("ignores a stale snapshot that arrives after newer live state", () => {
    const current = applySubagentEvent(
      EMPTY_SUBAGENT_RUNTIME_STATE,
      event({
        sequence: 21,
        kind: "run_running",
        runId: "run-a",
        view: runView({ runId: "run-a", state: "needs_input" }),
      }),
    );

    const staleSnapshot = event({
      sequence: 20,
      kind: "snapshot",
      snapshot: {
        runs: [runView({ runId: "run-a", state: "running" })],
        events: [],
      },
    });
    const afterStaleSnapshot = applySubagentEvent(current, staleSnapshot);

    expect(afterStaleSnapshot).toBe(current);
    expect(selectSubagentRun(afterStaleSnapshot, "run-a")?.view.state).toBe("needs_input");
  });

  it("dedupes live events already covered by a snapshot replay", () => {
    const snapshotEvent = event({
      sequence: 15,
      kind: "snapshot",
      snapshot: {
        runs: [runView({ runId: "run-a" })],
        events: [
          replayEvent({
            sequence: 14,
            kind: "child_tool",
            runId: "run-a",
            activity: { type: "tool_use", data: { name: "kept" } },
          }),
        ],
      },
    });
    const afterSnapshot = applySubagentEvent(EMPTY_SUBAGENT_RUNTIME_STATE, snapshotEvent);

    // A re-delivered live event at sequence 14 must be ignored.
    const afterDuplicate = applySubagentEvent(
      afterSnapshot,
      event({
        sequence: 14,
        kind: "child_tool",
        runId: "run-a",
        activity: { type: "tool_use", data: { name: "duplicate" } },
      }),
    );
    expect(afterDuplicate).toBe(afterSnapshot);
    expect(selectSubagentRun(afterDuplicate, "run-a")?.activity).toHaveLength(1);

    // A newer live event (sequence 16) resumes correctly.
    const afterResume = applySubagentEvent(
      afterSnapshot,
      event({
        sequence: 16,
        kind: "child_tool",
        runId: "run-a",
        activity: { type: "tool_use", data: { name: "resumed" } },
      }),
    );
    expect(selectSubagentRun(afterResume, "run-a")?.activity.at(-1)?.data["name"]).toBe("resumed");
  });

  it("separates active from terminal runs", () => {
    let state: SubagentRuntimeState = EMPTY_SUBAGENT_RUNTIME_STATE;
    state = applySubagentEvent(
      state,
      event({
        sequence: 1,
        kind: "run_created",
        runId: "run-a",
        view: runView({ runId: "run-a", state: "running" }),
      }),
    );
    state = applySubagentEvent(
      state,
      event({
        sequence: 2,
        kind: "run_created",
        runId: "run-b",
        view: runView({ runId: "run-b", state: "done" }),
      }),
    );
    const active = selectActiveSubagentRuns(state);
    expect(active.map((entry) => entry.view.runId)).toEqual(["run-a"]);
  });
});

describe("subagent run status predicates", () => {
  const cases: ReadonlyArray<[PiSubagentRunStatus, boolean, boolean, boolean]> = [
    ["spawning", true, false, false],
    ["running", true, false, false],
    ["needs_input", false, false, true],
    ["done", false, true, false],
    ["failed", false, true, false],
    ["killed", false, true, false],
    ["interrupted", false, true, false],
  ];
  for (const [status, active, terminal, needsInput] of cases) {
    it(`classifies ${status}`, () => {
      expect(isSubagentRunActive(status)).toBe(active);
      expect(isSubagentRunTerminal(status)).toBe(terminal);
      expect(subagentRunNeedsInput(status)).toBe(needsInput);
    });
  }
});
