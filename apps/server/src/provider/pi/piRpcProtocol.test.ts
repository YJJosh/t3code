import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  autoRespondToExtensionUi,
  buildPiRpcArgs,
  buildPiRpcEnv,
  extractPiAssistantText,
  parsePiContextWindow,
  parsePiFastServiceEnabled,
  parsePiTaskBridgeNotification,
  parsePiThinkingLevel,
  PI_SUBAGENTS_RPC_EVENT_PREFIX,
  resolvePiBinary,
  supportsPiCodexFastService,
} from "./piRpcProtocol.ts";

const decodeSettings = Schema.decodeSync(PiSettings);

describe("Pi RPC protocol", () => {
  it("builds approved long-lived RPC arguments without disabling resources", () => {
    expect(buildPiRpcArgs(decodeSettings({}))).toEqual([
      "--mode",
      "rpc",
      "--approve",
      "--profile",
      "coder",
    ]);
    expect(
      buildPiRpcArgs(decodeSettings({ profile: "provider-default" }), {
        profile: "thread-profile",
        resumeSessionId: "session-1",
        model: "anthropic/claude-sonnet-5",
        thinkingLevel: "high",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--approve",
      "--profile",
      "thread-profile",
      "--session",
      "session-1",
      "--model",
      "anthropic/claude-sonnet-5",
      "--thinking",
      "high",
    ]);
  });

  it("uses Pi defaults and applies only explicit binary/agent-directory overrides", () => {
    expect(resolvePiBinary(decodeSettings({}))).toBe("pi");
    expect(resolvePiBinary(decodeSettings({ binaryPath: "/opt/pi" }))).toBe("/opt/pi");
    expect(buildPiRpcEnv(decodeSettings({}), { HOME: "/home/test" })).toEqual({
      HOME: "/home/test",
      PI_SUBAGENTS_RPC_BRIDGE: "1",
    });
    expect(buildPiRpcEnv(decodeSettings({ agentDir: "/agents" }), { HOME: "/home/test" })).toEqual({
      HOME: "/home/test",
      PI_SUBAGENTS_RPC_BRIDGE: "1",
      PI_CODING_AGENT_DIR: "/agents",
    });
  });

  it("parses only safe thinking, context, and service-tier selections", () => {
    expect(parsePiThinkingLevel("max")).toBe("max");
    expect(parsePiThinkingLevel("turbo")).toBeUndefined();
    expect(parsePiContextWindow("200k")).toBe("200k");
    expect(parsePiContextWindow("1.5m")).toBe("1.5m");
    expect(parsePiContextWindow("auto")).toBe("auto");
    expect(parsePiContextWindow("200k\n/fast on")).toBeUndefined();
    expect(parsePiFastServiceEnabled("priority")).toBe(true);
    expect(parsePiFastServiceEnabled("default")).toBe(false);
    expect(supportsPiCodexFastService("openai-codex/gpt-5.4")).toBe(true);
    expect(supportsPiCodexFastService("anthropic/claude-sonnet-5")).toBe(false);
  });

  it("parses optional workflow notifications without exporting fork-only contracts", () => {
    const event = {
      contractVersion: 1,
      managerId: "manager-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      kind: "run_created",
      runId: "run-1",
      view: { runId: "run-1", task: "Review", state: "running" },
    };
    expect(
      parsePiTaskBridgeNotification({
        type: "extension_ui_request",
        id: "notice-1",
        method: "notify",
        message: `${PI_SUBAGENTS_RPC_EVENT_PREFIX}${JSON.stringify(event)}`,
      }),
    ).toEqual(event);
    expect(
      parsePiTaskBridgeNotification({
        type: "extension_ui_request",
        id: "notice-2",
        method: "notify",
        message: `${PI_SUBAGENTS_RPC_EVENT_PREFIX}{not-json}`,
      }),
    ).toBeUndefined();
  });

  it("auto-confirms yolo-safe UI requests and cancels text input", () => {
    expect(
      autoRespondToExtensionUi({
        type: "extension_ui_request",
        id: "confirm-1",
        method: "confirm",
        title: "Proceed?",
        message: "Continue",
      }),
    ).toEqual({ type: "extension_ui_response", id: "confirm-1", confirmed: true });
    expect(
      autoRespondToExtensionUi({
        type: "extension_ui_request",
        id: "input-1",
        method: "input",
        title: "Secret",
      }),
    ).toEqual({ type: "extension_ui_response", id: "input-1", cancelled: true });
  });

  it("extracts assistant text and separated thinking blocks defensively", () => {
    expect(
      extractPiAssistantText({
        content: [
          { type: "thinking", thinking: "first" },
          { type: "thinking", thinking: "second" },
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      }),
    ).toEqual({ text: "Hello world", thinking: "first\n\nsecond" });
    expect(extractPiAssistantText(null)).toEqual({ text: "", thinking: "" });
  });
});
