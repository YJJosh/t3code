import type { SubagentRunEntry } from "@t3tools/client-runtime/state/subagents";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./SubagentRunControls", () => ({
  SubagentRunControls: () => null,
}));

import { SubagentRunDetail } from "./SubagentRunDetail";

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  total: 15,
  turns: 1,
  cost_estimate_usd: 0.01,
} as const;

function failedRun(): SubagentRunEntry {
  return {
    view: {
      runId: "review-failure",
      task: "Review the change",
      model: "test/model",
      state: "failed",
      directory: "/workspace",
      skills: [],
      turns: 1,
      activeMs: 1_000,
      usageSoFar: usage,
      openQuestions: [],
      result: {
        run_id: "review-failure",
        model: "test/model",
        directory: "/workspace",
        status: "failed",
        result: {
          status: "failed",
          summary: "Partial review completed.",
          files_changed: [],
          open_questions: [],
        },
        reason: "Stopped after reaching the turn limit.",
        usage,
      },
      checkAfterTokens: 1_000,
      nextCheckTokens: 2_000,
      managerCheckPending: false,
    },
    activity: [],
    lastSequence: 1,
    updatedAt: "2026-07-25T12:00:00.000Z",
  };
}

describe("SubagentRunDetail", () => {
  it("shows the termination reason alongside a partial structured summary", () => {
    const markup = renderToStaticMarkup(
      <SubagentRunDetail
        environmentId={"env-test" as EnvironmentId}
        threadId={"11111111-1111-4111-8111-111111111111" as ThreadId}
        run={failedRun()}
      />,
    );

    expect(markup).toContain("Partial review completed.");
    expect(markup).toContain("Stopped after reaching the turn limit.");
  });
});
