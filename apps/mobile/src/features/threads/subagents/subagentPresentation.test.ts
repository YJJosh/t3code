import type {
  SubagentActivityEntry,
  SubagentRunEntry,
} from "@t3tools/client-runtime/state/subagents";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_VISIBLE_CHILD_ACTIVITY,
  selectVisibleSubagentActivity,
  summarizeSubagentActivity,
  threadSupportsPiSubagents,
} from "./subagentPresentation";

function provider(instanceId: string, driver: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
  } as ServerProvider;
}

describe("mobile Pi child-run presentation", () => {
  it("prefers the actual session provider over the persisted model selection", () => {
    const thread = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("saved-pi"),
        model: "model",
      },
      session: {
        providerInstanceId: ProviderInstanceId.make("live-codex"),
        providerName: "codex",
      },
    } as const;
    const serverConfig = {
      providers: [provider("saved-pi", "pi"), provider("live-codex", "codex")],
    };

    expect(threadSupportsPiSubagents(thread, serverConfig)).toBe(false);
  });

  it("uses the persisted provider when there is no live session", () => {
    const thread = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("my-pi"),
        model: "model",
      },
      session: null,
    } as const;

    expect(
      threadSupportsPiSubagents(thread, {
        providers: [provider("my-pi", "pi")],
      }),
    ).toBe(true);
    expect(threadSupportsPiSubagents(thread, null)).toBe(false);
  });

  it("extracts readable nested child activity", () => {
    const activity = {
      sequence: 1,
      timestamp: "2026-07-10T00:00:00.000Z",
      kind: "child_tool",
      type: "tool_result",
      data: {
        toolName: "read",
        result: { content: [{ text: "Opened src/App.tsx" }] },
      },
      liveOnly: false,
    } satisfies SubagentActivityEntry;

    expect(summarizeSubagentActivity(activity)).toBe("read: Opened src/App.tsx");
  });

  it("shows compact tool arguments when no text result exists yet", () => {
    const activity = {
      sequence: 1,
      timestamp: "2026-07-10T00:00:00.000Z",
      kind: "child_tool",
      type: "tool_execution_start",
      data: { toolName: "bash", args: { command: "vp test" } },
      liveOnly: false,
    } satisfies SubagentActivityEntry;

    expect(summarizeSubagentActivity(activity)).toBe('bash: {"command":"vp test"}');
  });

  it("caps rendered activity to the latest mobile window", () => {
    const activity = Array.from({ length: MAX_VISIBLE_CHILD_ACTIVITY + 5 }, (_, index) => ({
      sequence: index + 1,
      timestamp: "2026-07-10T00:00:00.000Z",
      kind: "child_message" as const,
      type: "message",
      data: {},
      liveOnly: false,
    }));
    const run = { activity } as unknown as SubagentRunEntry;

    const visible = selectVisibleSubagentActivity(run);
    expect(visible).toHaveLength(MAX_VISIBLE_CHILD_ACTIVITY);
    expect(visible[0]?.sequence).toBe(6);
  });
});
