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
  formatSubagentUsageBreakdown,
  isSubagentMaxTurnReason,
  subagentRosterOverviewLabel,
  subagentActivityLabel,
  subagentMaxTurnExplanation,
  subagentRunAccessibleStatus,
  subagentRunDisplayTitle,
  subagentRunStatusLabel,
  subagentRunTitle,
  subagentStatusLabel,
  subagentStatusTone,
  summarizeSubagentActivity,
  summarizeSubagentRoster,
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

  it("prefers task text over run id for titles and workflow labels over prompts", () => {
    expect(subagentRunTitle("  Investigate flake  ", "run-1")).toBe("Investigate flake");
    expect(subagentRunTitle("   ", "run-1")).toBe("run-1");
    const baseRun = runEntry("run-1", "running");
    const workflowRun: SubagentRunEntry = {
      ...baseRun,
      view: {
        ...baseRun.view,
        workflow: {
          runId: "wf-1",
          name: "Review workflow",
          label: "Security audit",
          phase: "Review",
        },
      },
    };
    expect(subagentRunDisplayTitle(workflowRun)).toBe("Security audit");
  });

  it("summarizes activity without repeating its separate label", () => {
    expect(summarizeSubagentActivity(activity({ data: { name: "Bash", text: "ls -la" } }))).toBe(
      "ls -la",
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

  it("uses the latest thinking block when an assistant turn has no text", () => {
    expect(
      summarizeSubagentActivity(
        activity({
          type: "message_end",
          kind: "child_message",
          data: {
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "First thought" },
                { type: "thinking", thinking: "Useful progress update\n\n<!-- -->" },
                { type: "toolCall", name: "read" },
              ],
            },
          },
        }),
      ),
    ).toBe("Useful progress update");
  });

  it("uses concise semantic activity labels", () => {
    expect(
      subagentActivityLabel(
        activity({
          kind: "child_tool",
          type: "tool_execution_end",
          data: { toolName: "bash" },
        }),
      ),
    ).toBe("Bash");
    expect(
      subagentActivityLabel(
        activity({
          kind: "child_message",
          type: "message_end",
          data: {
            message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan" }] },
          },
        }),
      ),
    ).toBe("Thinking");
    expect(
      subagentActivityLabel(
        activity({
          kind: "child_message",
          type: "message_end",
          data: { message: { role: "user", content: [{ type: "text", text: "Continue" }] } },
        }),
      ),
    ).toBe("Manager");
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
    ).toBe("file contents");
    expect(
      summarizeSubagentActivity(
        activity({
          type: "tool_execution_start",
          data: { toolName: "bash", args: { command: "ls" } },
        }),
      ),
    ).toBe('{"command":"ls"}');
    expect(
      summarizeSubagentActivity(
        activity({
          type: "tool_execution_end",
          data: {
            toolName: "bash",
            args: { command: "ls" },
            result: { content: [{ type: "text", text: "very long command output" }] },
          },
        }),
      ),
    ).toBe('{"command":"ls"}');
  });

  it("formats usage and duration", () => {
    expect(formatSubagentTokens(usage)).toBe("12,345 tokens");
    expect(formatSubagentCost(usage)).toBe("$1.23");
    expect(formatSubagentActiveMs(500)).toBe("500ms");
    expect(formatSubagentActiveMs(4200)).toBe("4.2s");
    expect(formatSubagentActiveMs(95_000)).toBe("1m 35s");
  });

  it("breaks the usage total into non-zero categories", () => {
    expect(formatSubagentUsageBreakdown(usage)).toBe("10 in · 20 out");
    expect(
      formatSubagentUsageBreakdown({
        ...usage,
        input: 1_234,
        output: 999_499,
        cacheRead: 2_400_000,
        cacheWrite: 120_000,
      }),
    ).toBe("1.2k in · 999k out · 2.4M cache read · 120k cache write");
    expect(
      formatSubagentUsageBreakdown({ ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBeNull();
  });

  it("labels a live assistant frame as streaming", () => {
    expect(
      subagentActivityLabel(
        activity({
          kind: "child_message",
          type: "message_update",
          liveOnly: true,
          data: {
            message: { role: "assistant", content: [{ type: "text", text: "Partial answ" }] },
          },
        }),
      ),
    ).toBe("Streaming");
    expect(
      subagentActivityLabel(
        activity({
          kind: "child_message",
          type: "message_update",
          liveOnly: true,
          data: {
            message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan" }] },
          },
        }),
      ),
    ).toBe("Thinking");
  });

  it("explains max-turn failures as the harness limit, not the Pi turn count", () => {
    expect(isSubagentMaxTurnReason("Stopped after reaching the turn limit.")).toBe(true);
    expect(isSubagentMaxTurnReason("Maximum turns exceeded")).toBe(true);
    expect(isSubagentMaxTurnReason("max_turns reached")).toBe(true);
    expect(isSubagentMaxTurnReason("Provider crashed")).toBe(false);
    expect(isSubagentMaxTurnReason(undefined)).toBe(false);

    const baseRun = runEntry("run-1", "failed");
    const failedRun: SubagentRunEntry = {
      ...baseRun,
      view: {
        ...baseRun.view,
        result: {
          run_id: "run-1",
          model: "claude-sonnet-5",
          directory: "/tmp/work",
          status: "failed",
          reason: "limit_exceeded:max_turns — Reached maximum number of turns (30)",
          usage: { ...usage, turns: 1 },
        },
      },
    };
    expect(subagentMaxTurnExplanation(failedRun)).toBe(
      "The provider stopped after reaching its 30-turn internal limit. Internal provider turns are separate from the Pi turn count shown in this panel.",
    );

    const crashedRun: SubagentRunEntry = {
      ...baseRun,
      view: {
        ...baseRun.view,
        result: {
          run_id: "run-1",
          model: "claude-sonnet-5",
          directory: "/tmp/work",
          status: "failed",
          reason: "Provider crashed",
          usage,
        },
      },
    };
    expect(subagentMaxTurnExplanation(crashedRun)).toBeNull();
  });

  it("calls out actionable input without making false claims for workflow agents", () => {
    expect(subagentRunAccessibleStatus("needs_input")).toBe("Needs input — needs your input");
    expect(subagentRunAccessibleStatus("needs_input", true)).toBe(
      "Stopping — workflow agents cannot pause for input",
    );
    expect(subagentRunAccessibleStatus("running")).toBe("Running");
    expect(subagentRunAccessibleStatus("failed")).toBe("Failed");

    const baseRun = runEntry("workflow-input", "needs_input");
    const workflowRun: SubagentRunEntry = {
      ...baseRun,
      view: {
        ...baseRun.view,
        workflow: { runId: "wf-1", label: "Unattended review" },
      },
    };
    expect(subagentRunStatusLabel(workflowRun)).toBe("Stopping");
  });

  it("summarizes roster activity for the compact inspector trigger", () => {
    const stats = summarizeSubagentRoster([
      runEntry("a", "running"),
      runEntry("b", "spawning"),
      runEntry("c", "needs_input"),
      runEntry("d", "failed"),
      runEntry("e", "done"),
      runEntry("f", "killed"),
      runEntry("g", "interrupted"),
    ]);
    expect(stats).toEqual({
      total: 7,
      active: 2,
      spawning: 1,
      running: 1,
      needsInput: 1,
      workflowStopping: 0,
      done: 1,
      failed: 1,
      stopped: 2,
      settled: 4,
    });
    expect(subagentRosterOverviewLabel(stats)).toBe(
      "1 waiting · 1 spawning · 1 running · 1 done · 1 failed · 2 stopped",
    );
    expect(subagentRosterOverviewLabel(summarizeSubagentRoster([runEntry("e", "done")]))).toBe(
      "1 done",
    );

    const baseRun = runEntry("workflow-input", "needs_input");
    const workflowRun: SubagentRunEntry = {
      ...baseRun,
      view: {
        ...baseRun.view,
        workflow: { runId: "wf-1", label: "Unattended review" },
      },
    };
    expect(subagentRosterOverviewLabel(summarizeSubagentRoster([workflowRun]))).toBe("1 stopping");
  });
});
