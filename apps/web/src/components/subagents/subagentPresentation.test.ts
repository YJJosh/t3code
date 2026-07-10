import { describe, expect, it } from "vite-plus/test";

import type {
  SubagentActivityEntry,
  SubagentRunEntry,
} from "@t3tools/client-runtime/state/subagents";
import type { PiSubagentRunStatus, PiSubagentRunView, PiSubagentUsage } from "@t3tools/contracts";

import {
  formatSubagentActiveMs,
  formatSubagentCost,
  formatSubagentTokens,
  groupSubagentRunsForRoster,
  isSubagentRunQuiet,
  subagentRosterSummaryLabel,
  subagentRunAccessibleStatus,
  subagentRunTitle,
  subagentStatusLabel,
  subagentStatusTone,
  summarizeSubagentActivity,
} from "./subagentPresentation.ts";

function activity(overrides: Partial<SubagentActivityEntry>): SubagentActivityEntry {
  return {
    sequence: 1,
    timestamp: "2026-04-01T00:00:00.000Z",
    kind: "child_tool",
    type: "tool_use",
    data: {},
    liveOnly: false,
    ...overrides,
  };
}

const usage: PiSubagentUsage = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  total: 12_345,
  turns: 3,
  cost_estimate_usd: 1.2345,
};

function runEntry(runId: string, state: PiSubagentRunStatus): SubagentRunEntry {
  const view: PiSubagentRunView = {
    runId,
    task: `Task ${runId}`,
    model: "claude-sonnet-5",
    state,
    directory: "/tmp/work",
    skills: [],
    turns: 1,
    activeMs: 1_000,
    usageSoFar: usage,
    openQuestions: [],
    checkAfterTokens: 0,
    nextCheckTokens: 0,
    managerCheckPending: false,
  };
  return {
    view,
    activity: [],
    lastSequence: 1,
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

describe("subagentPresentation", () => {
  it("labels and tones every run status", () => {
    expect(subagentStatusLabel("needs_input")).toBe("Needs input");
    expect(subagentStatusTone("running")).toBe("info");
    expect(subagentStatusTone("needs_input")).toBe("warning");
    expect(subagentStatusTone("done")).toBe("success");
    expect(subagentStatusTone("failed")).toBe("error");
    expect(subagentStatusTone("killed")).toBe("error");
  });

  it("prefers task text over run id for titles", () => {
    expect(subagentRunTitle("  Investigate flake  ", "run-1")).toBe("Investigate flake");
    expect(subagentRunTitle("   ", "run-1")).toBe("run-1");
  });

  it("summarizes activity from name and text fields", () => {
    expect(summarizeSubagentActivity(activity({ data: { name: "Bash", text: "ls -la" } }))).toBe(
      "Bash: ls -la",
    );
    expect(summarizeSubagentActivity(activity({ data: { message: "hello" } }))).toBe("hello");
    expect(summarizeSubagentActivity(activity({ type: "turn", data: {} }))).toBe("turn");
  });

  it("extracts text from realistic nested Pi message events", () => {
    expect(
      summarizeSubagentActivity(
        activity({
          type: "message_end",
          kind: "child_message",
          data: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "private reasoning" },
                { type: "text", text: "Implemented the reducer and tests." },
              ],
            },
          },
        }),
      ),
    ).toBe("Implemented the reducer and tests.");
  });

  it("renders tool names with nested output or compact arguments", () => {
    expect(
      summarizeSubagentActivity(
        activity({
          type: "tool_execution_end",
          data: {
            toolName: "read",
            result: { content: [{ type: "text", text: "file contents" }] },
          },
        }),
      ),
    ).toBe("read: file contents");
    expect(
      summarizeSubagentActivity(
        activity({
          type: "tool_execution_start",
          data: { toolName: "bash", args: { command: "ls" } },
        }),
      ),
    ).toBe('bash: {"command":"ls"}');
  });

  it("formats usage and duration", () => {
    expect(formatSubagentTokens(usage)).toBe("12,345 tokens");
    expect(formatSubagentCost(usage)).toBe("$1.23");
    expect(formatSubagentActiveMs(500)).toBe("500ms");
    expect(formatSubagentActiveMs(4200)).toBe("4.2s");
    expect(formatSubagentActiveMs(95_000)).toBe("1m 35s");
  });

  it("calls out needs_input in the accessible status but not other statuses", () => {
    expect(subagentRunAccessibleStatus("needs_input")).toBe("Needs input — needs your input");
    expect(subagentRunAccessibleStatus("running")).toBe("Running");
    expect(subagentRunAccessibleStatus("failed")).toBe("Failed");
  });

  it("treats only done/killed/interrupted as quiet, keeping failed always visible", () => {
    expect(isSubagentRunQuiet("done")).toBe(true);
    expect(isSubagentRunQuiet("killed")).toBe(true);
    expect(isSubagentRunQuiet("interrupted")).toBe(true);
    expect(isSubagentRunQuiet("failed")).toBe(false);
    expect(isSubagentRunQuiet("running")).toBe(false);
    expect(isSubagentRunQuiet("spawning")).toBe(false);
    expect(isSubagentRunQuiet("needs_input")).toBe(false);
  });

  it("groups runs into attention vs quiet while preserving spawn order", () => {
    const runs = [
      runEntry("a", "running"),
      runEntry("b", "done"),
      runEntry("c", "needs_input"),
      runEntry("d", "failed"),
      runEntry("e", "killed"),
    ];

    const { attention, quiet } = groupSubagentRunsForRoster(runs);

    expect(attention.map((run) => run.view.runId)).toEqual(["a", "c", "d"]);
    expect(quiet.map((run) => run.view.runId)).toEqual(["b", "e"]);
  });

  it("returns empty groups for an empty run list", () => {
    const { attention, quiet } = groupSubagentRunsForRoster([]);
    expect(attention).toEqual([]);
    expect(quiet).toEqual([]);
  });

  it("pluralizes the collapsed summary label", () => {
    expect(subagentRosterSummaryLabel(1)).toBe("1 finished run");
    expect(subagentRosterSummaryLabel(3)).toBe("3 finished runs");
  });
});
