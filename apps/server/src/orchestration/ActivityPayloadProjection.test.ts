import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(data: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-tool" as OrchestrationThreadActivity["id"],
    tone: "tool",
    kind: "tool.completed",
    summary: "Read",
    payload: {
      itemType: "dynamic_tool_call",
      status: "completed",
      data,
    },
    turnId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("projectActivityPayload", () => {
  it("retains bounded structured Pi tool arguments, results, and correlation metadata", () => {
    const projected = projectActivityPayload(
      activity({
        toolCallId: "tool-1",
        args: { file_path: "/tmp/app.ts" },
        result: { content: [{ type: "text", text: "source" }] },
        providerMetadata: {
          provider: "claude-agent-sdk",
          sdkSessionId: "sdk-session-1",
        },
        isError: false,
        ignoredInternalField: "not sent",
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      data: {
        toolCallId: "tool-1",
        args: { file_path: "/tmp/app.ts" },
        result: { content: [{ type: "text", text: "source" }] },
        providerMetadata: {
          provider: "claude-agent-sdk",
          sdkSessionId: "sdk-session-1",
        },
        isError: false,
      },
    });
  });

  it("truncates oversized tool output before it reaches snapshots and WebSockets", () => {
    const projected = projectActivityPayload(
      activity({
        toolCallId: "tool-large",
        result: { content: "x".repeat(40_000) },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    const result = data.result as Record<string, unknown>;
    const content = result.content as string;

    expect(content.length).toBeLessThan(40_000);
    expect(content).toContain("[truncated]");
  });
});
