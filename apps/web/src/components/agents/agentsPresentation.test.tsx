import { describe, expect, it } from "vite-plus/test";
import type { RuntimeSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  agentStatusLabel,
  formatAgentElapsedSeconds,
  preferredInspectorAgent,
} from "./agentsPresentation";
const agent = (
  id: string,
  status: RuntimeSubagentStatus,
  kind: "subagent" | "workflow" = "subagent",
) => ({ id, status, kind });

describe("agent inspector presentation", () => {
  it("prioritizes agents needing input, then active work, then failures", () => {
    const settled = agent("settled", "completed");
    const failed = agent("failed", "failed");
    const active = agent("active", "running");
    const waiting = agent("waiting", "waiting");
    expect(preferredInspectorAgent([settled, failed, active, waiting])?.id).toBe("waiting");
    expect(preferredInspectorAgent([settled, failed, active])?.id).toBe("active");
    expect(preferredInspectorAgent([settled, failed])?.id).toBe("failed");
    expect(
      preferredInspectorAgent([agent("coordinator", "running", "workflow"), settled])?.id,
    ).toBe("settled");
  });
  it("labels interruption honestly instead of claiming that history is running", () => {
    expect(agentStatusLabel(agent("interrupted", "interrupted"))).toBe("Stopped");
    expect(agentStatusLabel(agent("waiting", "waiting"))).toBe("Waiting");
  });
  it("formats elapsed clocks without sub-second churn", () => {
    expect(formatAgentElapsedSeconds(9.9)).toBe("9s");
    expect(formatAgentElapsedSeconds(65)).toBe("1m 05s");
    expect(formatAgentElapsedSeconds(3661)).toBe("1h 01m");
  });
});
