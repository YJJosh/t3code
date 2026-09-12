import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  autoRespondToExtensionUi,
  buildPiRpcArgs,
  buildPiRpcEnv,
  extractPiAssistantText,
  parsePiBackgroundTerminalNotification,
  parsePiContextWindow,
  parsePiFastServiceEnabled,
  parsePiTaskBridgeNotification,
  parsePiThinkingLevel,
  PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX,
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

  it.effect("uses Pi defaults and normalizes the child agent directory", () =>
    Effect.gen(function* () {
      const paths = yield* Path.Path;
      expect(resolvePiBinary(decodeSettings({}))).toBe("pi");
      expect(resolvePiBinary(decodeSettings({ binaryPath: "/opt/pi" }))).toBe("/opt/pi");
      expect(buildPiRpcEnv(paths, decodeSettings({}), { HOME: "/home/test" })).toEqual({
        HOME: "/home/test",
        PI_SUBAGENTS_RPC_BRIDGE: "1",
        PI_BACKGROUND_TERMINALS_RPC_BRIDGE: "1",
        PI_CODING_AGENT_DIR: paths.join("/home/test", ".pi", "agent"),
      });
      expect(
        buildPiRpcEnv(paths, decodeSettings({ agentDir: "~/agents" }), {
          HOME: "/home/test",
          PI_CODING_AGENT_DIR: "/ignored",
        }),
      ).toEqual({
        HOME: "/home/test",
        PI_SUBAGENTS_RPC_BRIDGE: "1",
        PI_BACKGROUND_TERMINALS_RPC_BRIDGE: "1",
        PI_CODING_AGENT_DIR: paths.join("/home/test", "agents"),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("normalizes current and legacy environment overrides without mutating them", () =>
    Effect.gen(function* () {
      const paths = yield* Path.Path;
      const environment = { HOME: "/home/test", TAU_CODING_AGENT_DIR: "~/tau-agent" };
      expect(buildPiRpcEnv(paths, decodeSettings({}), environment).PI_CODING_AGENT_DIR).toBe(
        paths.join("/home/test", "tau-agent"),
      );
      expect(
        buildPiRpcEnv(paths, decodeSettings({}), {
          ...environment,
          PI_CODING_AGENT_DIR: "~/pi-agent",
        }).PI_CODING_AGENT_DIR,
      ).toBe(paths.join("/home/test", "pi-agent"));
      expect(environment).toEqual({ HOME: "/home/test", TAU_CODING_AGENT_DIR: "~/tau-agent" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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

  it("preserves correlated Pi subagent control results", () => {
    const event = {
      contractVersion: 1,
      managerId: "manager-1",
      sequence: 2,
      timestamp: "2026-01-01T00:00:01.000Z",
      kind: "control_result",
      runId: "rmre1dz89-9",
      control: {
        requestId: "control-1",
        action: "reply",
        success: false,
        error: "The run is no longer waiting for input.",
      },
    } as const;
    expect(
      parsePiTaskBridgeNotification({
        type: "extension_ui_request",
        id: "notice-control",
        method: "notify",
        message: `${PI_SUBAGENTS_RPC_EVENT_PREFIX}${JSON.stringify(event)}`,
      }),
    ).toEqual(event);
  });

  it("parses schema-valid background-terminal notifications", () => {
    const event = {
      contractVersion: 1 as const,
      managerId: "manager-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      kind: "snapshot" as const,
      snapshot: { terminals: [], replay: true },
    };
    expect(
      parsePiBackgroundTerminalNotification({
        type: "extension_ui_request",
        id: "notice-bg-1",
        method: "notify",
        message: `${PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX}${JSON.stringify(event)}`,
      }),
    ).toEqual(event);
    expect(
      parsePiBackgroundTerminalNotification({
        type: "extension_ui_request",
        id: "notice-bg-2",
        method: "notify",
        message: `${PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX}{not-json}`,
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

  it("extracts assistant text and thinking with explicit content-block boundaries", () => {
    expect(
      extractPiAssistantText({
        content: [
          { type: "thinking", thinking: "first\n\n" },
          { type: "text", text: "Now I’ll verify the command." },
          { type: "thinking", thinking: "second" },
          { type: "text", text: "# Invoice Summary" },
          { type: "text", text: "| Total | $42 |" },
        ],
      }),
    ).toEqual({
      text: "Now I’ll verify the command.\n\n# Invoice Summary\n\n| Total | $42 |",
      thinking: "first\n\nsecond",
    });
    expect(extractPiAssistantText(null)).toEqual({ text: "", thinking: "" });
  });
});
