/** Pure helpers for Pi 0.84.4's JSONL RPC protocol. */
import { type PiSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type PiRpcImage = {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
};

/** Commands used by the adapter, kept structurally aligned with Pi 0.84.4. */
export type PiRpcCommand =
  | {
      readonly id?: string;
      readonly type: "prompt";
      readonly message: string;
      readonly images?: PiRpcImage[];
    }
  | {
      readonly id?: string;
      readonly type: "steer";
      readonly message: string;
      readonly images?: PiRpcImage[];
    }
  | { readonly id?: string; readonly type: "abort" }
  | { readonly id?: string; readonly type: "get_state" }
  | {
      readonly id?: string;
      readonly type: "set_model";
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly id?: string; readonly type: "set_thinking_level"; readonly level: PiThinkingLevel }
  | { readonly id?: string; readonly type: "set_session_name"; readonly name: string }
  | { readonly id?: string; readonly type: "get_commands" };

export type PiExtensionUiRequest =
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "select";
      readonly title: string;
      readonly options: string[];
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "confirm";
      readonly title: string;
      readonly message: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "input";
      readonly title: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "editor";
      readonly title: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "notify";
      readonly message: string;
      readonly notifyType?: "info" | "warning" | "error";
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
      readonly [key: string]: unknown;
    };

export type PiExtensionUiResponse =
  | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly confirmed: boolean }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };

export const DEFAULT_PI_BINARY = "pi";
export const DEFAULT_PI_PROFILE = "coder";
export const PI_SUBAGENTS_RPC_BRIDGE_ENV = "PI_SUBAGENTS_RPC_BRIDGE";
export const PI_SUBAGENTS_RPC_EVENT_PREFIX = "pi-subagents:event:v1:";

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

export const PI_THINKING_OPTION_ID = "reasoning";
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
  readonly profile?: string | undefined;
  readonly model?: string | undefined;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  readonly resumeSessionId?: string | undefined;
  readonly sessionName?: string | undefined;
}

/** Build arguments for one long-lived Pi RPC process. */
export function buildPiRpcArgs(config: PiSettings, options: PiSpawnOptions = {}): string[] {
  const profile = options.profile?.trim() || config.profile?.trim() || DEFAULT_PI_PROFILE;
  const args = ["--mode", "rpc", "--approve", "--profile", profile];
  if (options.resumeSessionId?.trim()) args.push("--session", options.resumeSessionId.trim());
  if (options.sessionName?.trim()) args.push("--name", options.sessionName.trim());
  if (options.model?.trim()) args.push("--model", options.model.trim());
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  return args;
}

export function resolvePiBinary(config: PiSettings): string {
  return config.binaryPath?.trim() || DEFAULT_PI_BINARY;
}

export function buildPiRpcEnv(
  config: PiSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const agentDir = config.agentDir?.trim();
  return {
    ...baseEnv,
    // Optional Pi extensions can emit structured workflow notifications. The
    // adapter translates their lifecycle to canonical task.* events; controls
    // remain a later slice on top of the native Agents panel.
    [PI_SUBAGENTS_RPC_BRIDGE_ENV]: "1",
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  };
}

const PiTaskBridgeEventSchema = Schema.Struct({
  contractVersion: Schema.Literal(1),
  managerId: Schema.NonEmptyString,
  sequence: Schema.Int,
  timestamp: Schema.String,
  kind: Schema.String,
  runId: Schema.optional(Schema.String),
  view: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  activity: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  snapshot: Schema.optional(Schema.Unknown),
  replay: Schema.optional(Schema.Boolean),
});
export type PiTaskBridgeEvent = typeof PiTaskBridgeEventSchema.Type;
const decodePiTaskBridgeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(PiTaskBridgeEventSchema),
);

/**
 * Parse the optional pi-subagents notification without importing its fork-only
 * contracts. The adapter intentionally consumes only stable lifecycle fields
 * and projects them into upstream task.* events.
 */
export function parsePiTaskBridgeNotification(
  request: PiExtensionUiRequest,
): PiTaskBridgeEvent | undefined {
  if (request.method !== "notify" || !request.message.startsWith(PI_SUBAGENTS_RPC_EVENT_PREFIX)) {
    return undefined;
  }
  return Option.getOrUndefined(
    decodePiTaskBridgeEvent(request.message.slice(PI_SUBAGENTS_RPC_EVENT_PREFIX.length)),
  );
}

export function autoRespondToExtensionUi(
  request: PiExtensionUiRequest,
): PiExtensionUiResponse | undefined {
  switch (request.method) {
    case "confirm":
      return { type: "extension_ui_response", id: request.id, confirmed: true };
    case "select": {
      const first = request.options[0];
      return first === undefined
        ? { type: "extension_ui_response", id: request.id, cancelled: true }
        : { type: "extension_ui_response", id: request.id, value: first };
    }
    case "input":
    case "editor":
      return { type: "extension_ui_response", id: request.id, cancelled: true };
    default:
      return undefined;
  }
}

export function extractPiAssistantText(message: unknown): { text: string; thinking: string } {
  let text = "";
  const thinkingParts: string[] = [];
  if (
    message &&
    typeof message === "object" &&
    "content" in message &&
    Array.isArray((message as { content: unknown }).content)
  ) {
    for (const part of (message as { content: ReadonlyArray<unknown> }).content) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") text += record.text;
      if (
        record.type === "thinking" &&
        typeof record.thinking === "string" &&
        record.thinking.length > 0
      ) {
        thinkingParts.push(record.thinking);
      }
    }
  }
  return { text, thinking: thinkingParts.join("\n\n") };
}
