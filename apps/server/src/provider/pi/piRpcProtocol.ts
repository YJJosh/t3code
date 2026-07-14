/**
 * Pure Pi RPC protocol helpers: process spawn arguments, environment, thinking
 * levels, and the yolo-mode `extension_ui_request` auto-responder.
 *
 * Kept free of Effect and I/O so every branch is unit-testable in isolation
 * (see piRpcProtocol.test.ts). The stateful transport lives in
 * `../Layers/PiRpcConnection.ts`.
 *
 * @module provider/pi/piRpcProtocol
 */
import {
  PiSubagentEvent,
  type PiSettings,
  type PiSubagentEvent as PiSubagentEventType,
} from "@t3tools/contracts";
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type PiRpcCommand = RpcCommand;
export type PiExtensionUiRequest = RpcExtensionUIRequest;
export type PiExtensionUiResponse = RpcExtensionUIResponse;

export const DEFAULT_PI_BINARY = "pi";
export const DEFAULT_PI_PROFILE = "coder";
export const PI_SUBAGENTS_RPC_BRIDGE_ENV = "PI_SUBAGENTS_RPC_BRIDGE";
export const PI_SUBAGENTS_RPC_EVENT_PREFIX = "pi-subagents:event:v1:";

const decodePiSubagentEventJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(PiSubagentEvent),
);

/** Pi's `ThinkingLevel` union, mirrored so we can validate without importing runtime code. */
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/**
 * The provider-option id under which the UI carries a per-turn thinking level.
 * Matches the descriptor id built in `../Layers/PiProvider.ts`.
 */
export const PI_THINKING_OPTION_ID = "reasoning";

/** Pi model options + extension commands exposed in the composer. */
export const PI_CONTEXT_WINDOW_OPTION_ID = "contextWindow";
export const PI_CONTEXT_COMMAND = "context";
export const PI_AUTO_CONTEXT_WINDOW = "auto";
export const PI_SERVICE_TIER_OPTION_ID = "serviceTier";
export const PI_STANDARD_SERVICE_TIER = "default";
export const PI_FAST_SERVICE_TIER = "priority";
export const PI_CODEX_FAST_COMMAND = "fast";
const PI_CODEX_FAST_MODEL_SLUGS = new Set([
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
]);

export function supportsPiCodexFastService(modelSlug: string | undefined): boolean {
  return modelSlug !== undefined && PI_CODEX_FAST_MODEL_SLUGS.has(modelSlug);
}

export function parsePiFastServiceEnabled(value: unknown): boolean | undefined {
  if (value === PI_FAST_SERVICE_TIER) return true;
  if (value === PI_STANDARD_SERVICE_TIER) return false;
  return undefined;
}

/** Validate a composer value before interpolating it into Pi's `/context` command. */
export function parsePiContextWindow(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === PI_AUTO_CONTEXT_WINDOW) return normalized;
  if (!/^[0-9]+(?:\.[0-9]+)?(?:k|m)?$/.test(normalized)) return undefined;

  const suffix = normalized.at(-1);
  const numericText = suffix === "k" || suffix === "m" ? normalized.slice(0, -1) : normalized;
  const numericValue = Number(numericText);
  return Number.isFinite(numericValue) && numericValue > 0 ? normalized : undefined;
}

export function parsePiThinkingLevel(value: unknown): PiThinkingLevel | undefined {
  return typeof value === "string" && (PI_THINKING_LEVELS as ReadonlyArray<string>).includes(value)
    ? (value as PiThinkingLevel)
    : undefined;
}

export interface PiSpawnOptions {
  /** Profile selected for this thread, overriding the provider setting. */
  readonly profile?: string | undefined;
  /**
   * Resolved model slug (e.g. `anthropic/claude-sonnet-5`) or `undefined` to
   * let Pi use its configured default.
   */
  readonly model?: string | undefined;
  /** Thinking level for the initial run, appended as `--thinking`. */
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  /**
   * When set, resume this exact Pi session id/path (`--session`). Used to
   * re-attach a thread's conversation after a subprocess restart.
   */
  readonly resumeSessionId?: string | undefined;
}

/**
 * Build the argument vector for a long-lived `pi --mode rpc` subprocess.
 *
 * Invariants required by the task:
 *  - always `--mode rpc`
 *  - always `--approve` (trust project-local `.pi` resources for the run)
 *  - always `--profile <profile>` (default `coder`)
 *  - normal extensions / skills / prompt templates / context files stay
 *    ENABLED — we never pass `--no-extensions`, `--no-skills`, etc.
 *  - the agent directory is selected via the `PI_CODING_AGENT_DIR` env var
 *    (see {@link buildPiRpcEnv}), NOT a CLI flag.
 */
export function buildPiRpcArgs(config: PiSettings, options: PiSpawnOptions = {}): string[] {
  const profile = options.profile?.trim() || config.profile?.trim() || DEFAULT_PI_PROFILE;
  const args = ["--mode", "rpc", "--approve", "--profile", profile];

  if (options.resumeSessionId?.trim()) {
    args.push("--session", options.resumeSessionId.trim());
  }
  if (options.model?.trim()) {
    args.push("--model", options.model.trim());
  }
  if (options.thinkingLevel) {
    args.push("--thinking", options.thinkingLevel);
  }
  return args;
}

/** Resolve the Pi binary path from config, falling back to the PATH lookup. */
export function resolvePiBinary(config: PiSettings): string {
  return config.binaryPath?.trim() || DEFAULT_PI_BINARY;
}

/**
 * Build the child environment.
 *
 * A blank `agentDir` means "use the real default `~/.pi/agent`", so we leave
 * `PI_CODING_AGENT_DIR` untouched (never copy/isolate the agent config). Only
 * when the user configured an explicit override do we set it.
 */
export function buildPiRpcEnv(
  config: PiSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const agentDir = config.agentDir?.trim();
  return {
    ...baseEnv,
    // Opt in to structured pi-subagents notifications. Extensions that do not
    // implement the bridge simply ignore this environment variable.
    [PI_SUBAGENTS_RPC_BRIDGE_ENV]: "1",
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  };
}

/** Decode a structured pi-subagents envelope from an RPC UI notification. */
export function parsePiSubagentNotification(
  request: PiExtensionUiRequest,
): PiSubagentEventType | undefined {
  if (
    request.method !== "notify" ||
    typeof request.message !== "string" ||
    !request.message.startsWith(PI_SUBAGENTS_RPC_EVENT_PREFIX)
  ) {
    return undefined;
  }
  return Option.getOrUndefined(
    decodePiSubagentEventJson(request.message.slice(PI_SUBAGENTS_RPC_EVENT_PREFIX.length)),
  );
}

/**
 * Compute the auto-response to an `extension_ui_request` for a session running
 * in yolo mode.
 *
 * Policy (per task):
 *  - `confirm`  → auto-confirm (`confirmed: true`)
 *  - `select`   → choose the first offered option
 *  - `input` / `editor` → cancel safely — we must NOT silently invent arbitrary
 *    text, so we return the `cancelled` response rather than a fabricated value
 *  - `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` are
 *    fire-and-forget notifications with no response channel → `undefined`
 */
export function autoRespondToExtensionUi(
  request: PiExtensionUiRequest,
): PiExtensionUiResponse | undefined {
  switch (request.method) {
    case "confirm":
      return { type: "extension_ui_response", id: request.id, confirmed: true };
    case "select": {
      const first = request.options[0];
      if (first === undefined) {
        return { type: "extension_ui_response", id: request.id, cancelled: true };
      }
      return { type: "extension_ui_response", id: request.id, value: first };
    }
    case "input":
    case "editor":
      // Do not fabricate free-form text. Cancel so the extension handles the
      // absence of input deterministically instead of receiving junk.
      return { type: "extension_ui_response", id: request.id, cancelled: true };
    default:
      // notify / setStatus / setWidget / setTitle / set_editor_text: no reply.
      return undefined;
  }
}

/** Extract the plain-text delta from a Pi assistant message content array. */
export function extractPiAssistantText(message: unknown): { text: string; thinking: string } {
  let text = "";
  let thinking = "";
  if (
    message &&
    typeof message === "object" &&
    "content" in message &&
    Array.isArray((message as { content: unknown }).content)
  ) {
    for (const part of (message as { content: ReadonlyArray<unknown> }).content) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        text += record.text;
      } else if (record.type === "thinking" && typeof record.thinking === "string") {
        thinking += record.thinking;
      }
    }
  }
  return { text, thinking };
}
