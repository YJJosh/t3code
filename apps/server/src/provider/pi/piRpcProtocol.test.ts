import { describe, expect, it } from "@effect/vitest";
import { PiSettings, PiSubagentEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  autoRespondToExtensionUi,
  buildPiRpcArgs,
  buildPiRpcEnv,
  extractPiAssistantText,
  parsePiSubagentNotification,
  parsePiThinkingLevel,
  PI_SUBAGENTS_RPC_EVENT_PREFIX,
  resolvePiBinary,
  type PiExtensionUiRequest,
} from "./piRpcProtocol.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const DEFAULTS = decodePiSettings({});

describe("PiSettings defaults", () => {
  it("supplies the documented defaults from an empty config", () => {
    expect(DEFAULTS).toEqual({
      enabled: true,
      binaryPath: "pi",
      profile: "coder",
      agentDir: "",
      customModels: [],
    });
  });
});

describe("buildPiRpcArgs", () => {
  it("always requests rpc mode with --approve and the default coder profile", () => {
    expect(buildPiRpcArgs(DEFAULTS)).toEqual(["--mode", "rpc", "--approve", "--profile", "coder"]);
  });

  it("does not disable extensions/skills/prompts/context (keeps them enabled)", () => {
    const args = buildPiRpcArgs(DEFAULTS);
    expect(args).not.toContain("--no-extensions");
    expect(args).not.toContain("--no-skills");
    expect(args).not.toContain("--no-prompt-templates");
    expect(args).not.toContain("--no-context-files");
  });

  it("honors a custom profile", () => {
    const args = buildPiRpcArgs(decodePiSettings({ profile: "reviewer" }));
    expect(args).toEqual(["--mode", "rpc", "--approve", "--profile", "reviewer"]);
  });

  it("appends resume/model/thinking flags in order", () => {
    const args = buildPiRpcArgs(DEFAULTS, {
      model: "anthropic/claude-sonnet-5",
      thinkingLevel: "high",
      resumeSessionId: "abc123",
    });
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--approve",
      "--profile",
      "coder",
      "--session",
      "abc123",
      "--model",
      "anthropic/claude-sonnet-5",
      "--thinking",
      "high",
    ]);
  });
});

describe("buildPiRpcEnv", () => {
  it("uses the real default agent dir when agentDir is blank (no override set)", () => {
    const env = buildPiRpcEnv(DEFAULTS, { HOME: "/home/x" });
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.PI_SUBAGENTS_RPC_BRIDGE).toBe("1");
    expect(env.HOME).toBe("/home/x");
  });

  it("sets PI_CODING_AGENT_DIR only when an override is configured", () => {
    const env = buildPiRpcEnv(decodePiSettings({ agentDir: "/custom/agent" }), { HOME: "/home/x" });
    expect(env.PI_CODING_AGENT_DIR).toBe("/custom/agent");
  });
});

describe("parsePiSubagentNotification", () => {
  it("decodes only valid prefixed v1 notify events", () => {
    const envelope = {
      contractVersion: 1 as const,
      managerId: "pi-subagents:manager",
      sequence: 1,
      timestamp: "2026-07-09T12:00:00.000Z",
      kind: "control_result" as const,
      control: { action: "replay" as const, success: true, requestId: "ui-1" },
    };
    const encode = Schema.encodeSync(Schema.fromJsonString(PiSubagentEvent));
    expect(
      parsePiSubagentNotification({
        type: "extension_ui_request",
        id: "notify-1",
        method: "notify",
        message: `${PI_SUBAGENTS_RPC_EVENT_PREFIX}${encode(envelope)}`,
      }),
    ).toEqual(envelope);
    expect(
      parsePiSubagentNotification({
        type: "extension_ui_request",
        id: "notify-2",
        method: "notify",
        message: "ordinary extension notification",
      }),
    ).toBeUndefined();
    expect(
      parsePiSubagentNotification({
        type: "extension_ui_request",
        id: "notify-3",
        method: "notify",
        message: `${PI_SUBAGENTS_RPC_EVENT_PREFIX}{bad`,
      }),
    ).toBeUndefined();
  });
});

describe("resolvePiBinary", () => {
  it("defaults to `pi` and honors an explicit path", () => {
    expect(resolvePiBinary(DEFAULTS)).toBe("pi");
    expect(resolvePiBinary(decodePiSettings({ binaryPath: "/opt/pi" }))).toBe("/opt/pi");
  });
});

describe("parsePiThinkingLevel", () => {
  it("accepts valid levels and rejects everything else", () => {
    expect(parsePiThinkingLevel("high")).toBe("high");
    expect(parsePiThinkingLevel("xhigh")).toBe("xhigh");
    expect(parsePiThinkingLevel("max")).toBe("max");
    expect(parsePiThinkingLevel("ultra")).toBeUndefined();
    expect(parsePiThinkingLevel(undefined)).toBeUndefined();
    expect(parsePiThinkingLevel(5)).toBeUndefined();
  });
});

describe("autoRespondToExtensionUi (yolo mode)", () => {
  const base = { type: "extension_ui_request" as const, id: "req-1" };

  it("auto-confirms confirm requests", () => {
    const request: PiExtensionUiRequest = {
      ...base,
      method: "confirm",
      title: "Proceed?",
      message: "Are you sure?",
    };
    expect(autoRespondToExtensionUi(request)).toEqual({
      type: "extension_ui_response",
      id: "req-1",
      confirmed: true,
    });
  });

  it("selects the first option for select requests", () => {
    const request: PiExtensionUiRequest = {
      ...base,
      method: "select",
      title: "Pick",
      options: ["alpha", "beta"],
    };
    expect(autoRespondToExtensionUi(request)).toEqual({
      type: "extension_ui_response",
      id: "req-1",
      value: "alpha",
    });
  });

  it("cancels (never fabricates) input and editor requests", () => {
    const input: PiExtensionUiRequest = { ...base, method: "input", title: "Name?" };
    const editor: PiExtensionUiRequest = { ...base, method: "editor", title: "Edit" };
    expect(autoRespondToExtensionUi(input)).toEqual({
      type: "extension_ui_response",
      id: "req-1",
      cancelled: true,
    });
    expect(autoRespondToExtensionUi(editor)).toEqual({
      type: "extension_ui_response",
      id: "req-1",
      cancelled: true,
    });
  });

  it("returns no response for fire-and-forget notifications", () => {
    const notify: PiExtensionUiRequest = { ...base, method: "notify", message: "hi" };
    expect(autoRespondToExtensionUi(notify)).toBeUndefined();
  });
});

describe("extractPiAssistantText", () => {
  it("concatenates text and thinking parts of an assistant message", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ],
    };
    expect(extractPiAssistantText(message)).toEqual({ text: "Hello world", thinking: "hmm" });
  });

  it("is defensive against non-conforming payloads", () => {
    expect(extractPiAssistantText(null)).toEqual({ text: "", thinking: "" });
    expect(extractPiAssistantText({ content: "nope" })).toEqual({ text: "", thinking: "" });
  });
});
