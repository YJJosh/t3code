import { describe, expect, it } from "vite-plus/test";

import type { SubagentActivityEntry } from "@t3tools/client-runtime/state/subagents";
import type { PiSubagentUsage } from "@t3tools/contracts";

import {
  formatSubagentActiveMs,
  formatSubagentCost,
  formatSubagentTokens,
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
});
