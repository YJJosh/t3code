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
  cacheRead: 2_000,
  cacheWrite: 0,
  total: 2_015,
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
        reason: "limit_exceeded:max_turns — Reached maximum number of turns (30)",
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
    expect(markup).toContain("Reached maximum number of turns (30)");
    // Provider-internal turns must not be inferred from usage.turns, which is outer Pi lifecycle usage.
    expect(markup).toContain("Pi turns");
    expect(markup).toContain("The provider stopped after reaching its 30-turn internal limit.");
    expect(markup).not.toContain("30 agent turns");
  });

  it("breaks the usage total into categories", () => {
    const markup = renderToStaticMarkup(
      <SubagentRunDetail
        environmentId={"env-test" as EnvironmentId}
        threadId={"11111111-1111-4111-8111-111111111111" as ThreadId}
        run={failedRun()}
      />,
    );

    expect(markup).toContain("2,015 tokens");
    expect(markup).toContain("10 in · 5 out · 2k cache read");
  });

  it("shows a streaming assistant row while the run is active", () => {
    const base = failedRun();
    const run: SubagentRunEntry = {
      ...base,
      view: { ...base.view, state: "running", result: undefined },
      activity: [
        {
          sequence: 2,
          timestamp: "2026-07-25T12:00:01.000Z",
          kind: "child_message",
          type: "message_update",
          data: {
            message: { role: "assistant", content: [{ type: "text", text: "Partial answ" }] },
          },
          liveOnly: true,
        },
      ],
      lastSequence: 2,
    };

    const markup = renderToStaticMarkup(
      <SubagentRunDetail
        environmentId={"env-test" as EnvironmentId}
        threadId={"11111111-1111-4111-8111-111111111111" as ThreadId}
        run={run}
      />,
    );

    expect(markup).toContain("Partial answ");
    expect(markup).toContain("Streaming");
  });
});
