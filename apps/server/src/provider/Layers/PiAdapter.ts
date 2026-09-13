/**
 * PiAdapter — long-lived `pi --mode rpc` subprocess adapter (one per thread).
 *
 * Maps Pi RPC `AgentSessionEvent`s (agent/message/tool/turn/retry/compaction)
 * and `extension_ui_request`s onto the canonical `ProviderRuntimeEvent` stream.
 * The subprocess keeps normal extensions/skills/prompt-templates/context files
 * enabled and discovers project `.pi` resources from the thread cwd; it runs
 * against the real default `~/.pi/agent` unless an override is configured.
 *
 * Interactive approvals: the session runs in yolo mode, so we auto-confirm
 * confirms and pick the first select option. `input`/`editor` requests are
 * cancelled (never fabricated) and surfaced as a `runtime.warning` so state is
 * not silently corrupted.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  classifyTaskAgentKind,
  EventId,
  type ModelSelection,
  PI_BACKGROUND_TERMINAL_EVENT_CONTRACT_VERSION,
  PI_PROFILE_OPTION_ID,
  type PiBackgroundTerminalControlInput,
  type PiBackgroundTerminalControlResult,
  type PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderItemId,
  RuntimeItemId,
  RuntimeTaskId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  applyPiAssistantBlockEvent,
  applyPiAssistantSnapshot,
  makePiAssistantContentState,
  type PiAssistantContentDelta,
  type PiAssistantContentState,
} from "../pi/piAssistantContent.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { makeBackgroundTerminalEventPubSub } from "../backgroundTerminalEvents.ts";
import {
  autoRespondToExtensionUi,
  buildPiRpcArgs,
  buildPiRpcEnv,
  extractPiAssistantContent,
  extractPiAssistantText,
  parsePiBackgroundTerminalNotification,
  parsePiContextWindow,
  parsePiFastServiceEnabled,
  parsePiTaskBridgeNotification,
  parsePiThinkingLevel,
  PI_AUTO_CONTEXT_WINDOW,
  PI_CODEX_FAST_COMMAND,
  PI_CONTEXT_COMMAND,
  PI_CONTEXT_WINDOW_OPTION_ID,
  PI_SERVICE_TIER_OPTION_ID,
  PI_THINKING_OPTION_ID,
  resolvePiBinary,
  supportsPiCodexFastService,
  type PiExtensionUiRequest,
  type PiTaskBridgeEvent,
} from "../pi/piRpcProtocol.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  makePiRpcConnection,
  type PiRpcConnection,
  type PiRpcResponse,
} from "./PiRpcConnection.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const CLAUDE_AGENT_SDK_RPC_BRIDGE_ENV = "CLAUDE_AGENT_SDK_RPC_BRIDGE";
const CLAUDE_AGENT_SDK_RPC_EVENT_PREFIX = "claude-agent-sdk:tool-lifecycle:v1:";
const TOOL_UPDATE_MIN_INTERVAL_NANOS = 1_000_000_000n;
const TOOL_UPDATE_SUMMARY_MAX_CHARS = 4_000;
const TOOL_UPDATE_TRUNCATION_MARKER = "…[truncated]\n";
const PI_EXTENSION_CONTROL_TIMEOUT = "12 seconds";
const PI_ASYNC_RESULT_CUSTOM_TYPES = new Set([
  "subagents-result",
  "subagents-workflow-result",
  "background-terminal-result",
]);

type PiAssistantPhase = "commentary" | "final_answer";
type PiAssistantOrigin = "normal" | "async_result";

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
}

interface SubagentLiveMessage {
  readonly text: string;
  readonly thinking: string;
  readonly publishedAt: number;
}

type PiTaskControlResult = NonNullable<PiTaskBridgeEvent["control"]>;

interface PiRpcCommandCatalog {
  readonly allNames: ReadonlySet<string>;
  readonly extensionNames: ReadonlySet<string>;
}

interface PendingUserExtensionCommand {
  readonly turnId: TurnId;
  readonly openedTurn: boolean;
  agentStarted: boolean;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly connection: PiRpcConnection;
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  /** Pi session id (from get_state / session events) for resume. */
  piSessionId: string | undefined;
  /** Current canonical segment + indexed blocks for the whole native assistant message. */
  assistantItemId: ProviderItemId | undefined;
  assistantItemHasText: boolean;
  assistantItemHasReasoning: boolean;
  assistantWorkBoundaryPending: boolean;
  assistantContent: PiAssistantContentState;
  /** Native source of subsequent assistant replies; reset only by a real user message. */
  assistantOrigin: PiAssistantOrigin;
  hasPrimaryAssistantAnswer: boolean;
  /** Cumulative, rate-limited live assistant state for each child transcript. */
  subagentLiveMessages: Map<string, SubagentLiveMessage>;
  /** Last published time for other high-frequency child transcript events. */
  subagentLivePublishedAtByKey: Map<string, number>;
  /** Pi only repeats tool args on start/update; retain them for the final result. */
  toolArgsByCallId: Map<string, unknown>;
  /** Last persisted progress time per tool; Pi progress payloads are cumulative. */
  toolUpdateEmittedAtByCallId: Map<string, bigint>;
  /** The most recent low-level run outcome, finalized only by agent_settled. */
  lastAgentEndOutcome:
    | {
        readonly state: "completed" | "failed" | "interrupted";
        readonly errorMessage?: string;
        readonly stopReason: string | null;
      }
    | undefined;
  /** A terminal retry/compaction outcome that Pi did not otherwise attach to agent_end. */
  terminalFailure:
    | {
        readonly state: "failed" | "interrupted";
        readonly errorMessage?: string;
        readonly stopReason?: string;
      }
    | undefined;
  interruptRequested: boolean;
  /** Cached command metadata and synchronized session state. */
  commandCatalog: PiRpcCommandCatalog | undefined;
  pendingUserExtensionCommand: PendingUserExtensionCommand | undefined;
  contextWindowSelectionKey: string | undefined;
  fastServiceEnabled: boolean | undefined;
  /** Keeps model/thinking/context/service-tier synchronization atomic with its prompt. */
  sendSemaphore: Semaphore.Semaphore;
  stopped: boolean;
}

interface PiToolMeta {
  readonly toolName?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observePiMessageOrigin(ctx: PiSessionContext, message: unknown): void {
  if (!isRecord(message)) return;
  if (message.role === "user") {
    ctx.assistantOrigin = "normal";
    ctx.hasPrimaryAssistantAnswer = false;
    return;
  }
  if (
    message.role === "custom" &&
    typeof message.customType === "string" &&
    PI_ASYNC_RESULT_CUSTOM_TYPES.has(message.customType)
  ) {
    ctx.assistantOrigin = "async_result";
  }
}

// A background result may supply the first answer rather than a late
// acknowledgement. Unknown/partial replies remain unclassified so the client
// does not fold the only answer without an explicit work boundary.
function classifyPiAssistantPhase(
  ctx: PiSessionContext,
  stopReason?: unknown,
): PiAssistantPhase | undefined {
  if (ctx.assistantWorkBoundaryPending || stopReason === "toolUse" || !ctx.assistantItemHasText) {
    return "commentary";
  }
  if (ctx.assistantOrigin === "async_result") {
    return ctx.hasPrimaryAssistantAnswer ? "commentary" : undefined;
  }
  return stopReason === "stop" ? "final_answer" : undefined;
}

function toolItemType(toolName: unknown): "command_execution" | "dynamic_tool_call" {
  return toolName === "bash" ? "command_execution" : "dynamic_tool_call";
}

function parseClaudeAgentSdkToolNotification(request: PiExtensionUiRequest):
  | {
      readonly phase: "start" | "end";
      readonly event: Record<string, unknown>;
    }
  | undefined {
  if (
    request.method !== "notify" ||
    typeof request.message !== "string" ||
    !request.message.startsWith(CLAUDE_AGENT_SDK_RPC_EVENT_PREFIX)
  ) {
    return undefined;
  }
  try {
    const event = JSON.parse(
      request.message.slice(CLAUDE_AGENT_SDK_RPC_EVENT_PREFIX.length),
    ) as unknown;
    if (
      !isRecord(event) ||
      event.contractVersion !== 1 ||
      event.provider !== "claude-agent-sdk" ||
      (event.phase !== "start" && event.phase !== "end") ||
      typeof event.toolCallId !== "string" ||
      typeof event.toolName !== "string"
    ) {
      return undefined;
    }
    return { phase: event.phase, event };
  } catch {
    return undefined;
  }
}

function readPiSessionId(response: PiRpcResponse): string | undefined {
  if (!response.success || !isRecord(response.data)) return undefined;
  return typeof response.data.sessionId === "string" ? response.data.sessionId : undefined;
}

function readAgentEndOutcome(message: Record<string, unknown>): {
  readonly state: "completed" | "failed" | "interrupted";
  readonly errorMessage?: string;
  readonly stopReason: string | null;
} {
  const messages = Array.isArray(message.messages) ? message.messages : [];
  const assistant = [...messages]
    .toReversed()
    .find((candidate) => isRecord(candidate) && candidate.role === "assistant");
  if (!isRecord(assistant)) return { state: "completed", stopReason: null };
  const stopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : null;
  const errorMessage =
    typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
      ? assistant.errorMessage
      : undefined;
  if (stopReason === "error" || errorMessage) {
    return {
      state: "failed",
      stopReason,
      errorMessage: errorMessage ?? "Pi stopped with an error.",
    };
  }
  if (stopReason === "aborted") return { state: "interrupted", stopReason };
  return { state: "completed", stopReason };
}

/** Split a `provider/model` slug into `{ provider, modelId }` for `set_model`. */
export function splitPiModelSlug(slug: string): { provider: string; modelId: string } | undefined {
  const trimmed = slug.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return undefined;
  }
  return { provider: trimmed.slice(0, slashIndex), modelId: trimmed.slice(slashIndex + 1) };
}

function piRpcCommandCatalog(response: PiRpcResponse): PiRpcCommandCatalog {
  const allNames = new Set<string>();
  const extensionNames = new Set<string>();
  if (!isRecord(response.data) || !Array.isArray(response.data.commands)) {
    return { allNames, extensionNames };
  }
  for (const command of response.data.commands) {
    if (!isRecord(command) || typeof command.name !== "string") continue;
    allNames.add(command.name);
    // Older Pi versions omitted source. Keep those entries available for
    // internal capability checks, but never guess that they are extensions:
    // sending an ordinary prompt/template through this lifecycle would risk
    // completing a real agent turn from the prompt acknowledgement alone.
    if (command.source === "extension") extensionNames.add(command.name);
  }
  return { allNames, extensionNames };
}

function piSlashCommandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  // Match Pi's extension-command parser exactly: only an ASCII space ends the
  // command name. Tabs/newlines remain ordinary prompt text to Pi.
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  return name.length > 0 ? name : undefined;
}

function piRpcStateIsIdle(response: PiRpcResponse): boolean {
  return (
    isRecord(response.data) &&
    response.data.isStreaming === false &&
    response.data.isCompacting === false &&
    response.data.pendingMessageCount === 0
  );
}

type PiTaskEventType = "task.started" | "task.progress" | "task.updated" | "task.completed";
type PiTaskProjection = {
  [Type in PiTaskEventType]: Pick<
    Extract<ProviderRuntimeEvent, { readonly type: Type }>,
    "type" | "payload"
  >;
}[PiTaskEventType];

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function taskViewLinkage(view: Record<string, unknown>, runId: string) {
  const workflow = isRecord(view.workflow) ? view.workflow : undefined;
  const taskType = "pi-subagent";
  const title = nonEmptyString(workflow?.label) ?? nonEmptyString(view.task);
  const model = nonEmptyString(view.model);
  const workflowName = nonEmptyString(workflow?.name);
  const workflowRunId = nonEmptyString(workflow?.runId);
  const phaseTitle = nonEmptyString(workflow?.phase);
  return {
    taskType,
    agentKind: classifyTaskAgentKind({ taskType }),
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(workflowName ? { workflowName } : {}),
    ...(workflowRunId ? { parentAgentId: workflowRunId } : {}),
    ...(phaseTitle ? { phaseTitle } : {}),
    runHandles: { runId },
  };
}

function taskUsage(view: Record<string, unknown>):
  | {
      readonly totalTokens: number;
      readonly inputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly outputTokens?: number;
      readonly toolUses?: number;
      readonly durationMs?: number;
    }
  | undefined {
  if (!isRecord(view.usageSoFar)) return undefined;
  const totalTokens = nonNegativeInt(view.usageSoFar.total);
  if (totalTokens === undefined) return undefined;
  const inputTokens = nonNegativeInt(view.usageSoFar.input);
  const cachedInputTokens = nonNegativeInt(view.usageSoFar.cacheRead);
  const outputTokens = nonNegativeInt(view.usageSoFar.output);
  const toolUses = nonNegativeInt(view.usageSoFar.turns);
  const durationMs = nonNegativeInt(view.activeMs);
  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function taskCompletionStatus(view: Record<string, unknown>): "completed" | "failed" | "stopped" {
  return view.state === "done" ? "completed" : view.state === "failed" ? "failed" : "stopped";
}

function taskTranscriptEvent(event: PiTaskBridgeEvent) {
  if (!event.activity || !event.runId) return undefined;
  const type = nonEmptyString(event.activity.type);
  const data = isRecord(event.activity.data) ? event.activity.data : undefined;
  if (!type || !data) return undefined;
  return {
    managerId: event.managerId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind: event.kind,
    activity: {
      type,
      data,
      ...(event.activity.liveOnly === true ? { liveOnly: true } : {}),
    },
  };
}

const SUBAGENT_LIVE_PUBLISH_INTERVAL_MS = 100;

function normalizeTaskBridgeTranscriptEvent(
  event: PiTaskBridgeEvent,
  liveMessages: Map<string, SubagentLiveMessage>,
  livePublishedAtByKey: Map<string, number>,
): PiTaskBridgeEvent | undefined {
  const runId = event.runId;
  const activity = event.activity;
  const activityType = activity ? nonEmptyString(activity.type) : undefined;
  const activityData = activity && isRecord(activity.data) ? activity.data : undefined;
  if (!runId || !activity || !activityType || !activityData) {
    if (runId && ["terminal", "killed", "interrupted"].includes(event.kind)) {
      liveMessages.delete(runId);
      for (const key of livePublishedAtByKey.keys()) {
        if (key.startsWith(`${runId}:`)) livePublishedAtByKey.delete(key);
      }
    }
    return event;
  }

  if (activityType === "message_update") {
    const data = activityData;
    const message = isRecord(data.message) ? data.message : undefined;
    const current = liveMessages.get(runId);
    let text = current?.text ?? "";
    let thinking = current?.thinking ?? "";
    let forcePublish = activity.liveOnly !== true;
    if (message?.role === "assistant") {
      const extracted = extractPiAssistantText(message);
      text = extracted.text;
      thinking = extracted.thinking;
    } else if (isRecord(data.assistantMessageEvent)) {
      const update = data.assistantMessageEvent;
      if (update.type === "text_delta" && typeof update.delta === "string") {
        text += update.delta;
        forcePublish ||= update.delta.includes("\n");
      } else if (update.type === "thinking_delta" && typeof update.delta === "string") {
        thinking += update.delta;
        forcePublish ||= update.delta.includes("\n");
      } else if (update.type === "text_end" && typeof update.content === "string") {
        text = update.content;
      } else if (update.type === "thinking_end" && typeof update.content === "string") {
        thinking = update.content;
      }
    }
    const parsedTimestamp = Date.parse(event.timestamp);
    const eventTime = Number.isFinite(parsedTimestamp)
      ? parsedTimestamp
      : (current?.publishedAt ?? 0) + SUBAGENT_LIVE_PUBLISH_INTERVAL_MS;
    const shouldPublish =
      current === undefined ||
      forcePublish ||
      eventTime - current.publishedAt >= SUBAGENT_LIVE_PUBLISH_INTERVAL_MS;
    liveMessages.set(runId, {
      text,
      thinking,
      publishedAt: shouldPublish ? eventTime : (current?.publishedAt ?? eventTime),
    });
    if (!shouldPublish) return undefined;
    return {
      ...event,
      activity: {
        ...activity,
        data: {
          ...data,
          message: {
            role: "assistant",
            content: [
              ...(thinking ? [{ type: "thinking", thinking }] : []),
              ...(text ? [{ type: "text", text }] : []),
            ],
          },
        },
      },
    };
  }

  if (activityType === "message_end") liveMessages.delete(runId);

  const toolCallId = nonEmptyString(activityData.toolCallId) ?? "activity";
  const liveKey = `${runId}:${activityType}:${toolCallId}`;
  if (activity.liveOnly === true) {
    const lastPublishedAt = livePublishedAtByKey.get(liveKey);
    const parsedTimestamp = Date.parse(event.timestamp);
    const eventTime = Number.isFinite(parsedTimestamp)
      ? parsedTimestamp
      : (lastPublishedAt ?? 0) + SUBAGENT_LIVE_PUBLISH_INTERVAL_MS;
    if (
      lastPublishedAt !== undefined &&
      eventTime - lastPublishedAt < SUBAGENT_LIVE_PUBLISH_INTERVAL_MS
    ) {
      return undefined;
    }
    livePublishedAtByKey.set(liveKey, eventTime);
  } else if (activityType.endsWith("_end")) {
    for (const key of livePublishedAtByKey.keys()) {
      if (key.startsWith(`${runId}:`) && key.endsWith(`:${toolCallId}`)) {
        livePublishedAtByKey.delete(key);
      }
    }
  }
  return event;
}

function projectTaskView(
  kind: PiTaskBridgeEvent["kind"],
  view: Record<string, unknown>,
  fallbackRunId?: string,
  transcriptEvent?: ReturnType<typeof taskTranscriptEvent>,
): ReadonlyArray<PiTaskProjection> {
  const runId = nonEmptyString(view.runId) ?? fallbackRunId;
  if (!runId) return [];
  const taskId = RuntimeTaskId.make(runId);
  const linkage = taskViewLinkage(view, runId);
  const progressDescription = nonEmptyString(view.progressNote);
  const description = progressDescription ?? nonEmptyString(view.task) ?? `Pi agent ${runId}`;
  const summary =
    (isRecord(view.result) && isRecord(view.result.result)
      ? nonEmptyString(view.result.result.summary)
      : undefined) ??
    (isRecord(view.result) ? nonEmptyString(view.result.reason) : undefined) ??
    nonEmptyString(view.reason);
  const typedUsage = taskUsage(view);
  const common = { taskId, ...linkage };

  switch (kind) {
    case "run_created":
      return [{ type: "task.started", payload: { ...common, description } }];
    case "run_running":
    case "resumed":
    case "steered":
      return [
        {
          type: "task.updated",
          payload: {
            ...common,
            status: "running",
            ...(progressDescription ? { description: progressDescription } : {}),
          },
        },
      ];
    case "needs_input":
      return [
        {
          type: "task.updated",
          payload: {
            ...common,
            status: "waiting",
            ...(progressDescription ? { description: progressDescription } : {}),
          },
        },
      ];
    case "terminal":
    case "killed":
    case "interrupted":
      return [
        {
          type: "task.completed",
          payload: {
            ...common,
            status: taskCompletionStatus(view),
            ...(summary ? { summary } : {}),
            ...(typedUsage ? { typedUsage } : {}),
          },
        },
      ];
    case "control_result":
      return [];
    default:
      return [
        {
          type: "task.progress",
          payload: {
            ...common,
            description,
            ...(summary && !transcriptEvent ? { summary } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...(transcriptEvent ? { transcriptEvent } : {}),
          },
        },
      ];
  }
}

/**
 * Translation seam for optional Pi workflow extensions. No fork-only contract
 * crosses the provider boundary: clients receive the same task.* lifecycle
 * rendered by the upstream Agents panel.
 */
export function projectPiTaskBridgeEvent(
  event: PiTaskBridgeEvent,
): ReadonlyArray<PiTaskProjection> {
  if (event.kind === "snapshot" && isRecord(event.snapshot) && Array.isArray(event.snapshot.runs)) {
    const runs = event.snapshot.runs.filter(isRecord);
    const starts = runs.flatMap((candidate) => projectTaskView("run_created", candidate));
    const transcript = Array.isArray(event.snapshot.events)
      ? event.snapshot.events.flatMap((candidate) => {
          if (
            !isRecord(candidate) ||
            !isRecord(candidate.view) ||
            !isRecord(candidate.activity) ||
            typeof candidate.managerId !== "string" ||
            typeof candidate.sequence !== "number" ||
            typeof candidate.timestamp !== "string" ||
            typeof candidate.kind !== "string" ||
            typeof candidate.runId !== "string"
          ) {
            return [];
          }
          const replayEvent = candidate as PiTaskBridgeEvent;
          return projectTaskView(
            replayEvent.kind,
            replayEvent.view!,
            replayEvent.runId,
            taskTranscriptEvent(replayEvent),
          );
        })
      : [];
    const states = runs.flatMap((candidate) => {
      const state = candidate.state;
      const lifecycleKind =
        state === "done" || state === "failed" || state === "killed" || state === "interrupted"
          ? state === "done" || state === "failed"
            ? "terminal"
            : state
          : state === "needs_input"
            ? "needs_input"
            : "run_running";
      return projectTaskView(lifecycleKind, candidate);
    });
    return [...starts, ...transcript, ...states];
  }
  return event.view
    ? projectTaskView(event.kind, event.view, event.runId, taskTranscriptEvent(event))
    : [];
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const baseEnv = {
      ...(options?.environment ?? process.env),
      // Claude Code executes its native tools inside one provider call, so Pi
      // cannot emit ordinary tool_execution events for them. Opt into the
      // extension's structured RPC notification bridge for canonical rows.
      [CLAUDE_AGENT_SDK_RPC_BRIDGE_ENV]: "1",
    };

    const sessions = new Map<ThreadId, PiSessionContext>();
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const backgroundTerminalEvents = yield* makeBackgroundTerminalEventPubSub();
    const backgroundTerminalControlWaiters = new Map<
      string,
      Deferred.Deferred<PiBackgroundTerminalControlResult>
    >();
    const taskControlWaiters = new Map<
      string,
      Deferred.Deferred<PiTaskControlResult, ProviderAdapterRequestError>
    >();
    const backgroundTerminalManagerIds = new Map<ThreadId, string>();
    const extensionControlKey = (threadId: ThreadId, requestId: string) =>
      `${threadId}\u0000${requestId}`;
    const failTaskControlWaiters = (threadId: ThreadId, detail: string) =>
      Effect.gen(function* () {
        for (const [key, waiter] of taskControlWaiters) {
          if (!key.startsWith(`${threadId}\u0000`)) continue;
          taskControlWaiters.delete(key);
          yield* Deferred.fail(
            waiter,
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "subagents-rpc",
              detail,
            }),
          ).pipe(Effect.ignore);
        }
      });

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
    const resetBackgroundTerminals = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const id = yield* randomUUIDv4;
        const managerId = `pi-session-${id}`;
        backgroundTerminalManagerIds.set(threadId, managerId);
        yield* PubSub.publish(backgroundTerminalEvents, {
          threadId,
          event: {
            contractVersion: PI_BACKGROUND_TERMINAL_EVENT_CONTRACT_VERSION,
            managerId,
            sequence: 1,
            timestamp: yield* nowIso,
            kind: "snapshot",
            snapshot: { terminals: [], replay: true },
          },
        });
      });

    const emitWarning = (
      threadId: ThreadId,
      turnId: TurnId | undefined,
      message: string,
      detail?: unknown,
    ) =>
      Effect.gen(function* () {
        yield* emit({
          type: "runtime.warning",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId,
          ...(turnId ? { turnId } : {}),
          payload: { message, ...(detail !== undefined ? { detail } : {}) },
        });
      });

    const emitRuntimeError = (
      threadId: ThreadId,
      turnId: TurnId | undefined,
      message: string,
      detail?: unknown,
    ) =>
      Effect.gen(function* () {
        yield* emit({
          type: "runtime.error",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId,
          ...(turnId ? { turnId } : {}),
          payload: { message, ...(detail !== undefined ? { detail } : {}) },
        });
      });

    const request = (ctx: PiSessionContext, command: Parameters<PiRpcConnection["request"]>[0]) =>
      ctx.connection.request(command).pipe(
        Effect.flatMap((response) =>
          response.success
            ? Effect.succeed(response)
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: command.type,
                  detail: response.error || `Pi rejected RPC command '${command.type}'.`,
                }),
              ),
        ),
      );

    const selectPiModel = (
      ctx: PiSessionContext,
      model: string,
      operation: "startSession" | "sendTurn",
    ) =>
      Effect.gen(function* () {
        const split = splitPiModelSlug(model);
        if (!split) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: `Pi model '${model}' must use a provider/model slug.`,
          });
        }
        yield* request(ctx, {
          type: "set_model",
          provider: split.provider,
          modelId: split.modelId,
        });
      });

    const loadPiCommandCatalog = Effect.fn("loadPiCommandCatalog")(function* (
      ctx: PiSessionContext,
      refresh = false,
    ) {
      if (refresh || ctx.commandCatalog === undefined) {
        const commands = yield* request(ctx, { type: "get_commands" });
        ctx.commandCatalog = piRpcCommandCatalog(commands);
      }
      return ctx.commandCatalog;
    });

    const piAdvertisesCommand = Effect.fn("piAdvertisesCommand")(function* (
      ctx: PiSessionContext,
      commandName: string,
      refresh = false,
    ) {
      const catalog = yield* loadPiCommandCatalog(ctx, refresh);
      return catalog.allNames.has(commandName);
    });

    const syncContextWindow = (
      ctx: PiSessionContext,
      model: string | undefined,
      selection: string | undefined,
    ) =>
      Effect.gen(function* () {
        if (selection === undefined) return;
        const selectionKey = `${model ?? ""}\u0000${selection}`;
        if (selectionKey === ctx.contextWindowSelectionKey) return;
        if (!(yield* piAdvertisesCommand(ctx, PI_CONTEXT_COMMAND))) {
          // Capabilities are discovered with the configured default profile,
          // while a draft can select another profile. Revalidate against the
          // live session and drop a stale option instead of failing the thread.
          ctx.contextWindowSelectionKey = selectionKey;
          if (selection !== PI_AUTO_CONTEXT_WINDOW) {
            yield* emitWarning(
              ctx.threadId,
              ctx.activeTurnId,
              "Ignoring the context-window selection because this Pi profile does not provide /context.",
              { model, selection },
            );
          }
          return;
        }
        yield* request(ctx, {
          type: "prompt",
          message: `/${PI_CONTEXT_COMMAND} ${selection}`,
        });
        ctx.contextWindowSelectionKey = selectionKey;
      });

    const syncFastService = (ctx: PiSessionContext, enabled: boolean | undefined) =>
      Effect.gen(function* () {
        if (enabled === undefined || enabled === ctx.fastServiceEnabled) return;
        if (!(yield* piAdvertisesCommand(ctx, PI_CODEX_FAST_COMMAND))) {
          // As with /context, a per-draft profile can differ from the profile
          // used for provider discovery. Treat an unavailable command as an
          // unsupported option for this session rather than a startup error.
          ctx.fastServiceEnabled = enabled;
          if (enabled) {
            yield* emitWarning(
              ctx.threadId,
              ctx.activeTurnId,
              "Ignoring Codex Fast because this Pi profile does not provide /fast.",
              { model: ctx.session.model },
            );
          }
          return;
        }
        yield* request(ctx, {
          type: "prompt",
          message: `/${PI_CODEX_FAST_COMMAND} ${enabled ? "on" : "off"}`,
        });
        ctx.fastServiceEnabled = enabled;
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    // ── Pi RPC event → canonical runtime event translation ──────────────

    const emitTaskBridgeEvent = (ctx: PiSessionContext, event: PiTaskBridgeEvent) =>
      Effect.forEach(
        projectPiTaskBridgeEvent(event),
        (projection) =>
          Effect.gen(function* () {
            const eventBase = {
              ...(yield* makeStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
              raw: { source: "pi.rpc" as const, messageType: event.kind, payload: event },
            };
            switch (projection.type) {
              case "task.started":
                yield* emit({ ...eventBase, ...projection });
                return;
              case "task.progress":
                yield* emit({ ...eventBase, ...projection });
                return;
              case "task.updated":
                yield* emit({ ...eventBase, ...projection });
                return;
              case "task.completed":
                yield* emit({ ...eventBase, ...projection });
                return;
            }
          }),
        { discard: true },
      );

    const emitUserExtensionCommandInfo = Effect.fn("emitUserExtensionCommandInfo")(function* (
      ctx: PiSessionContext,
      turnId: TurnId,
      message: string,
    ) {
      const itemId = RuntimeItemId.make(yield* randomUUIDv4);
      yield* emit({
        type: "item.started",
        ...(yield* makeStamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId,
        itemId,
        payload: { itemType: "assistant_message", status: "inProgress" },
      });
      yield* emit({
        type: "content.delta",
        ...(yield* makeStamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId,
        itemId,
        payload: { streamKind: "assistant_text", delta: message },
      });
      const completedPayload = {
        itemType: "assistant_message" as const,
        status: "completed" as const,
        phase: "final_answer" as const,
      };
      yield* emit({
        type: "item.completed",
        ...(yield* makeStamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId,
        itemId,
        payload: completedPayload,
      });
    });

    const handleExtensionUiRequest = (ctx: PiSessionContext, request: PiExtensionUiRequest) =>
      Effect.gen(function* () {
        const claudeTool = parseClaudeAgentSdkToolNotification(request);
        if (claudeTool) {
          if (ctx.activeTurnId !== undefined) {
            const event = claudeTool.event;
            const providerMetadata = Object.fromEntries(
              [
                "provider",
                "sequence",
                "timestamp",
                "piSessionId",
                "sdkSessionId",
                "promptId",
                "parentToolCallId",
                "agentId",
                "durationMs",
              ].flatMap((key) => (event[key] === undefined ? [] : [[key, event[key]]])),
            );
            yield* handleToolEvent(
              ctx,
              claudeTool.phase === "start" ? "item.started" : "item.completed",
              {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                ...(event.args !== undefined ? { args: event.args } : {}),
                ...(claudeTool.phase === "end"
                  ? {
                      result:
                        event.result ??
                        (typeof event.error === "string" ? { error: event.error } : undefined),
                      isError: event.isError === true,
                    }
                  : {}),
                providerMetadata,
              },
            );
          }
          return;
        }
        const taskBridgeEvent = parsePiTaskBridgeNotification(request);
        if (taskBridgeEvent) {
          const control = taskBridgeEvent.control;
          if (taskBridgeEvent.kind === "control_result" && control?.requestId) {
            const waiter = taskControlWaiters.get(
              extensionControlKey(ctx.threadId, control.requestId),
            );
            if (waiter) {
              yield* Deferred.succeed(waiter, control).pipe(Effect.ignore);
            }
          }
          const normalized = normalizeTaskBridgeTranscriptEvent(
            taskBridgeEvent,
            ctx.subagentLiveMessages,
            ctx.subagentLivePublishedAtByKey,
          );
          if (normalized) yield* emitTaskBridgeEvent(ctx, normalized);
          return;
        }
        const backgroundTerminalEvent = parsePiBackgroundTerminalNotification(request);
        if (backgroundTerminalEvent) {
          const activeManagerId = backgroundTerminalManagerIds.get(ctx.threadId);
          // A manager switch is authoritative only when announced by a
          // snapshot. Ignore late updates from a replaced Pi process.
          if (
            activeManagerId !== undefined &&
            activeManagerId !== backgroundTerminalEvent.managerId &&
            backgroundTerminalEvent.kind !== "snapshot"
          ) {
            return;
          }
          if (activeManagerId === undefined || backgroundTerminalEvent.kind === "snapshot") {
            backgroundTerminalManagerIds.set(ctx.threadId, backgroundTerminalEvent.managerId);
          }
          yield* PubSub.publish(backgroundTerminalEvents, {
            threadId: ctx.threadId,
            event: backgroundTerminalEvent,
          });
          if (
            backgroundTerminalEvent.kind === "control_result" &&
            backgroundTerminalEvent.control.requestId
          ) {
            const waiter = backgroundTerminalControlWaiters.get(
              extensionControlKey(ctx.threadId, backgroundTerminalEvent.control.requestId),
            );
            if (waiter) {
              yield* Deferred.succeed(waiter, backgroundTerminalEvent.control).pipe(Effect.ignore);
            }
          }
          return;
        }
        if (
          request.method === "notify" &&
          (request.notifyType === "warning" || request.notifyType === "error")
        ) {
          const message =
            typeof request.message === "string" && request.message.trim().length > 0
              ? request.message
              : `Pi extension reported a ${request.notifyType}.`;
          if (request.notifyType === "error") {
            yield* emitRuntimeError(ctx.threadId, ctx.activeTurnId, message, request);
          } else {
            yield* emitWarning(ctx.threadId, ctx.activeTurnId, message, request);
          }
        } else if (request.method === "notify" && request.notifyType === "info") {
          const pending = ctx.pendingUserExtensionCommand;
          const message = request.message.trim();
          // Pi notifications do not carry their originating prompt id. The
          // prompt request/ack window is the only authoritative correlation
          // boundary available, so only surface info while that user command
          // owns the current turn. Startup and bridge notifications stay quiet.
          if (pending && message && ctx.activeTurnId === pending.turnId) {
            yield* emitUserExtensionCommandInfo(ctx, pending.turnId, message);
          }
        }
        const response = autoRespondToExtensionUi(request);
        if (response === undefined) {
          // Fire-and-forget notification (notify/setStatus/…): nothing to reply.
          return;
        }
        if ("cancelled" in response) {
          yield* emitWarning(
            ctx.threadId,
            ctx.activeTurnId,
            `Pi extension requested '${request.method}' input; auto-cancelled in yolo mode (no fabricated input).`,
            request,
          );
        }
        yield* ctx.connection
          .send(response)
          .pipe(
            Effect.catch((cause) =>
              emitWarning(ctx.threadId, ctx.activeTurnId, cause.message, cause),
            ),
          );
      });

    const finishAssistantSegment = Effect.fn("finishAssistantSegment")(function* (
      ctx: PiSessionContext,
      phase: PiAssistantPhase | undefined,
    ) {
      if (ctx.assistantItemId === undefined) return;
      const itemId = RuntimeItemId.make(ctx.assistantItemId);
      const turnId = ctx.activeTurnId;
      if (phase === "final_answer" && ctx.assistantItemHasText) {
        ctx.hasPrimaryAssistantAnswer = true;
      }
      const completedPayload = {
        itemType: "assistant_message" as const,
        status: "completed" as const,
        ...(phase !== undefined ? { phase } : {}),
      };
      yield* emit({
        type: "item.completed",
        ...(yield* makeStamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...(turnId ? { turnId } : {}),
        itemId,
        payload: completedPayload,
      });
      ctx.assistantItemId = undefined;
      ctx.assistantItemHasText = false;
      ctx.assistantItemHasReasoning = false;
      ctx.assistantWorkBoundaryPending = false;
    });

    const finishAssistantMessage = Effect.fn("finishAssistantMessage")(function* (
      ctx: PiSessionContext,
      phase: PiAssistantPhase | undefined,
    ) {
      yield* finishAssistantSegment(ctx, phase);
      ctx.assistantContent = makePiAssistantContentState();
    });

    const emitAssistantContentDeltas = Effect.fn("emitAssistantContentDeltas")(function* (
      ctx: PiSessionContext,
      deltas: ReadonlyArray<PiAssistantContentDelta>,
    ) {
      for (const delta of deltas) {
        // Content-block boundaries alone are not semantic: providers can put
        // a legitimate final answer in several adjacent text blocks. Split
        // only when Pi exposed an intervening tool/work boundary.
        if (
          ctx.assistantItemHasText &&
          (ctx.assistantWorkBoundaryPending ||
            (delta.startsBlock && delta.workBoundaryBefore === true))
        ) {
          yield* finishAssistantSegment(ctx, "commentary");
        }

        const segmentAlreadyHasThisStream =
          delta.streamKind === "assistant_text"
            ? ctx.assistantItemHasText
            : ctx.assistantItemHasReasoning;
        const canonicalDelta =
          delta.startsBlock && !segmentAlreadyHasThisStream && delta.blockBoundary
            ? delta.delta.slice(delta.blockBoundary.length)
            : delta.delta;
        if (!canonicalDelta) continue;

        const turnId = ctx.activeTurnId;
        if (ctx.assistantItemId === undefined) {
          ctx.assistantItemId = ProviderItemId.make(yield* randomUUIDv4);
          yield* emit({
            type: "item.started",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(turnId ? { turnId } : {}),
            itemId: RuntimeItemId.make(ctx.assistantItemId),
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        }
        const itemId = RuntimeItemId.make(ctx.assistantItemId);
        yield* emit({
          type: "content.delta",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(turnId ? { turnId } : {}),
          itemId,
          payload: {
            streamKind: delta.streamKind,
            delta: canonicalDelta,
            ...(delta.contentIndex !== undefined ? { contentIndex: delta.contentIndex } : {}),
          },
        });
        if (delta.streamKind === "assistant_text") {
          ctx.assistantItemHasText = true;
        } else {
          ctx.assistantItemHasReasoning = true;
        }
      }
    });

    const emitAssistantSnapshot = Effect.fn("emitAssistantSnapshot")(function* (
      ctx: PiSessionContext,
      message: unknown,
    ) {
      if (!isRecord(message) || message.role !== "assistant") return;
      const { text, thinking, blocks } = extractPiAssistantContent(message);
      const result = applyPiAssistantSnapshot(ctx.assistantContent, {
        assistant_text: text,
        reasoning_text: thinking,
        blocks,
      });
      ctx.assistantContent = result.state;
      yield* emitAssistantContentDeltas(ctx, result.deltas);
    });

    const emitAssistantEventDelta = Effect.fn("emitAssistantEventDelta")(function* (
      ctx: PiSessionContext,
      event: unknown,
    ) {
      if (!isRecord(event) || typeof event.type !== "string") return;
      if (event.type === "toolcall_start") {
        if (ctx.assistantItemHasText) ctx.assistantWorkBoundaryPending = true;
        return;
      }
      if (
        event.type === "text_start" ||
        event.type === "text_delta" ||
        event.type === "text_end" ||
        event.type === "thinking_start" ||
        event.type === "thinking_delta" ||
        event.type === "thinking_end"
      ) {
        const result = applyPiAssistantBlockEvent(ctx.assistantContent, {
          type: event.type,
          ...(typeof event.contentIndex === "number" ? { contentIndex: event.contentIndex } : {}),
          ...(typeof event.delta === "string" ? { delta: event.delta } : {}),
          ...(typeof event.content === "string" ? { content: event.content } : {}),
        });
        ctx.assistantContent = result.state;
        yield* emitAssistantContentDeltas(ctx, result.deltas);
        return;
      }
      if (event.type === "done" && isRecord(event.message)) {
        yield* emitAssistantSnapshot(ctx, event.message);
        return;
      }
      if (event.type === "error" && isRecord(event.error)) {
        yield* emitAssistantSnapshot(ctx, event.error);
      }
    });

    const completeTurn = (
      ctx: PiSessionContext,
      state: "completed" | "failed" | "cancelled" | "interrupted",
      extra?: { readonly errorMessage?: string; readonly stopReason?: string | null },
      expectedTurnId?: TurnId,
    ) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurnId;
        if (turnId === undefined || (expectedTurnId !== undefined && turnId !== expectedTurnId)) {
          return;
        }
        // A process exit, abort, or malformed native stream can omit
        // message_end. Keep any partial content, but never promote it to a
        // terminal answer without an authoritative stop response.
        yield* finishAssistantMessage(ctx, classifyPiAssistantPhase(ctx));
        const updatedAt = yield* nowIso;
        const { activeTurnId: _drop, ...rest } = ctx.session;
        ctx.session = { ...rest, status: "ready", updatedAt };
        ctx.activeTurnId = undefined;
        // A tool may never emit its terminal frame after cancellation or
        // extension failure. Turn settlement is the final ownership boundary
        // for cached arguments, so no interrupted call can leak into the next
        // turn or accumulate for the lifetime of the Pi process.
        ctx.toolArgsByCallId.clear();
        ctx.toolUpdateEmittedAtByCallId.clear();
        yield* emit({
          type: "turn.completed",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state,
            ...(extra?.stopReason !== undefined ? { stopReason: extra.stopReason } : {}),
            ...(extra?.errorMessage ? { errorMessage: extra.errorMessage } : {}),
          },
        });
      });

    const ensureActiveTurnForAgentStart = (ctx: PiSessionContext) =>
      ctx.activeTurnId !== undefined
        ? Effect.succeed(ctx.activeTurnId)
        : ctx.sendSemaphore.withPermit(
            Effect.gen(function* () {
              if (ctx.activeTurnId !== undefined) return ctx.activeTurnId;

              // An agent_start after the previous agent_settled is autonomous work
              // (for example, a background subagent reporting back). Represent that
              // run as a synthetic turn. Other late extension/message events remain
              // ignored so startup profile notifications cannot invent turns.
              const turnId = TurnId.make(yield* randomUUIDv4);
              const updatedAt = yield* nowIso;
              ctx.activeTurnId = turnId;
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt,
              };
              yield* emit({
                type: "turn.started",
                ...(yield* makeStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: ctx.session.model ? { model: ctx.session.model } : {},
              });
              return turnId;
            }),
          );

    const boundedToolUpdateTail = (
      value: string,
      omittedEarlierText = false,
    ): string | undefined => {
      const contentBudget = omittedEarlierText
        ? TOOL_UPDATE_SUMMARY_MAX_CHARS - TOOL_UPDATE_TRUNCATION_MARKER.length
        : TOOL_UPDATE_SUMMARY_MAX_CHARS;
      const start = Math.max(0, value.length - contentBudget);
      const truncated = omittedEarlierText || start > 0;
      let tail = value.slice(start).trim();
      if (!tail) return undefined;
      if (!truncated) return tail;
      const truncatedContentBudget =
        TOOL_UPDATE_SUMMARY_MAX_CHARS - TOOL_UPDATE_TRUNCATION_MARKER.length;
      if (tail.length > truncatedContentBudget) {
        tail = tail.slice(tail.length - truncatedContentBudget);
      }
      return `${TOOL_UPDATE_TRUNCATION_MARKER}${tail}`;
    };

    const toolResultSummary = (result: unknown): string | undefined => {
      if (!isRecord(result)) return undefined;
      if (typeof result.error === "string") {
        return boundedToolUpdateTail(result.error);
      }
      if (typeof result.content === "string") {
        return boundedToolUpdateTail(result.content);
      }
      if (!Array.isArray(result.content)) return undefined;

      const chunks: string[] = [];
      let remaining = TOOL_UPDATE_SUMMARY_MAX_CHARS;
      let index = result.content.length - 1;
      for (; index >= 0 && remaining > 0; index -= 1) {
        const part = result.content[index];
        if (!isRecord(part) || typeof part.text !== "string" || part.text.length === 0) continue;
        if (part.text.length > remaining) {
          chunks.push(part.text.slice(part.text.length - remaining));
          remaining = 0;
          break;
        }
        chunks.push(part.text);
        remaining -= part.text.length;
      }
      let omittedEarlierText = false;
      for (; index >= 0; index -= 1) {
        const part = result.content[index];
        if (isRecord(part) && typeof part.text === "string" && part.text.length > 0) {
          omittedEarlierText = true;
          break;
        }
      }
      if (chunks.length === 0) return undefined;
      return boundedToolUpdateTail(chunks.toReversed().join(""), omittedEarlierText);
    };

    const handleToolEvent = (
      ctx: PiSessionContext,
      lifecycle: "item.started" | "item.updated" | "item.completed",
      message: Record<string, unknown>,
    ) =>
      Effect.gen(function* () {
        if (lifecycle === "item.started" && ctx.assistantItemHasText) {
          // Claude's SDK bridge can expose a real tool call between two text
          // blocks inside one native assistant message. Defer completion until
          // more content arrives so trailing/aborted text is retained.
          ctx.assistantWorkBoundaryPending = true;
        }
        const suppliedToolCallId =
          typeof message.toolCallId === "string" ? message.toolCallId : undefined;
        // A random fallback would let every malformed progress frame bypass the
        // per-call throttle. Starts/completions remain observable, but an
        // uncorrelatable intermediate update is not useful.
        if (lifecycle === "item.updated" && suppliedToolCallId === undefined) return;
        const toolCallId = suppliedToolCallId ?? (yield* randomUUIDv4);
        if ("args" in message) ctx.toolArgsByCallId.set(toolCallId, message.args);
        if (lifecycle === "item.updated") {
          const now = yield* Clock.currentTimeNanos;
          const lastEmittedAt = ctx.toolUpdateEmittedAtByCallId.get(toolCallId);
          if (lastEmittedAt !== undefined && now - lastEmittedAt < TOOL_UPDATE_MIN_INTERVAL_NANOS) {
            return;
          }
          ctx.toolUpdateEmittedAtByCallId.set(toolCallId, now);
        }
        const args = ctx.toolArgsByCallId.get(toolCallId);
        const result = lifecycle === "item.completed" ? message.result : undefined;
        const partialResult = lifecycle === "item.updated" ? message.partialResult : undefined;
        const summary = toolResultSummary(partialResult) ?? toolResultSummary(result);
        // Pi sends the entire accumulated tool result on every progress frame.
        // Persist only the bounded display summary for intermediate updates;
        // the final item.completed event retains the structured result once.
        const projectedPartialResult =
          partialResult === undefined ? undefined : (summary ?? "Tool output updated.");
        const itemId = RuntimeItemId.make(toolCallId);
        const turnId = ctx.activeTurnId;
        const itemType = toolItemType((message as PiToolMeta).toolName);
        const isError = message.isError === true;
        const status =
          lifecycle === "item.completed" ? (isError ? "failed" : "completed") : "inProgress";
        if (lifecycle === "item.completed") {
          // Capture args/result above, then release per-call state before the
          // first publish yield so interruption cannot strand this call's data.
          ctx.toolArgsByCallId.delete(toolCallId);
          ctx.toolUpdateEmittedAtByCallId.delete(toolCallId);
        }
        yield* emit({
          type: lifecycle,
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(turnId ? { turnId } : {}),
          itemId,
          payload: {
            itemType,
            status,
            ...(typeof message.toolName === "string" ? { title: message.toolName } : {}),
            ...(summary ? { detail: summary } : {}),
            data: {
              toolCallId,
              ...(args !== undefined ? { args } : {}),
              ...(projectedPartialResult !== undefined
                ? { partialResult: projectedPartialResult }
                : {}),
              ...(result !== undefined ? { result } : {}),
              ...(isRecord(message.providerMetadata)
                ? { providerMetadata: message.providerMetadata }
                : {}),
              ...(lifecycle === "item.completed" ? { isError } : {}),
            },
          },
        });
        yield* emit({
          type: "tool.progress",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(turnId ? { turnId } : {}),
          itemId,
          payload: {
            toolUseId: toolCallId,
            ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
            ...(summary ? { summary } : {}),
          },
        });
      });

    const handlePiMessage = (ctx: PiSessionContext) => (message: unknown) =>
      Effect.gen(function* () {
        if (ctx.stopped || !isRecord(message) || typeof message.type !== "string") return;
        if (options?.nativeEventLogger) {
          yield* options.nativeEventLogger.write(message, ctx.threadId);
        }
        if (message.type === "message_start" || message.type === "message_end") {
          observePiMessageOrigin(ctx, message.message);
        }
        switch (message.type) {
          case "extension_ui_request":
            yield* handleExtensionUiRequest(ctx, message as unknown as PiExtensionUiRequest);
            return;
          case "response": {
            // Correlated callers own failure handling; an unrelated command
            // rejection must never settle the active model turn.
            if (message.command === "get_state" && isRecord(message.data)) {
              const sessionId = message.data.sessionId;
              if (typeof sessionId === "string") ctx.piSessionId = sessionId;
            }
            return;
          }
          case "agent_start": {
            const turnId = yield* ensureActiveTurnForAgentStart(ctx);
            const pending = ctx.pendingUserExtensionCommand;
            if (pending?.turnId === turnId) pending.agentStarted = true;
            return;
          }
          case "message_start":
            // The turn is opened by sendTurn or an explicit agent_start. Pi may
            // emit startup/profile and late extension messages outside a turn;
            // those messages must not invent autonomous work on their own.
            if (
              ctx.activeTurnId !== undefined &&
              isRecord(message.message) &&
              message.message.role === "assistant" &&
              (ctx.assistantItemId !== undefined || ctx.assistantContent.blocks.size > 0)
            ) {
              // Preserve incomplete content without assuming it is a final answer.
              yield* finishAssistantMessage(ctx, classifyPiAssistantPhase(ctx));
            }
            return;
          case "message_update":
            if (ctx.activeTurnId === undefined) return;
            // Legacy Pi frames carried both the block delta and a cumulative
            // message. Apply the delta first, then reconcile the snapshot, so
            // either delivery shape can take over without replaying content.
            yield* emitAssistantEventDelta(ctx, message.assistantMessageEvent);
            if (isRecord(message.message) && message.message.role === "assistant") {
              yield* emitAssistantSnapshot(ctx, message.message);
            }
            return;
          case "message_end":
            if (
              ctx.activeTurnId === undefined ||
              !isRecord(message.message) ||
              message.message.role !== "assistant"
            ) {
              return;
            }
            yield* emitAssistantSnapshot(ctx, message.message);
            yield* finishAssistantMessage(
              ctx,
              classifyPiAssistantPhase(ctx, message.message.stopReason),
            );
            return;
          case "tool_execution_start":
            if (ctx.activeTurnId !== undefined) {
              yield* handleToolEvent(ctx, "item.started", message);
            }
            return;
          case "tool_execution_update":
            if (ctx.activeTurnId !== undefined) {
              yield* handleToolEvent(ctx, "item.updated", message);
            }
            return;
          case "tool_execution_end":
            if (ctx.activeTurnId !== undefined) {
              yield* handleToolEvent(ctx, "item.completed", message);
            }
            return;
          case "agent_end":
            // This is only a low-level run boundary. Pi can continue via
            // retry, compaction, or queued input; agent_settled is canonical.
            ctx.lastAgentEndOutcome = readAgentEndOutcome(message);
            return;
          case "agent_settled": {
            const outcome = ctx.interruptRequested
              ? { state: "cancelled" as const, stopReason: "cancelled" }
              : (ctx.terminalFailure ??
                ctx.lastAgentEndOutcome ?? { state: "completed" as const, stopReason: null });
            // Clear the old turn's terminal state before completeTurn yields.
            // Once completeTurn releases activeTurnId, a concurrent send can
            // legitimately begin and record terminal state for the next turn.
            ctx.lastAgentEndOutcome = undefined;
            ctx.terminalFailure = undefined;
            ctx.interruptRequested = false;
            yield* completeTurn(ctx, outcome.state, {
              ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
              ...("errorMessage" in outcome && outcome.errorMessage
                ? { errorMessage: outcome.errorMessage }
                : {}),
            });
            return;
          }
          case "auto_retry_start":
            yield* emitWarning(
              ctx.threadId,
              ctx.activeTurnId,
              "Pi is retrying the request after a transient error.",
              message,
            );
            return;
          case "auto_retry_end":
            if (message.success === false) {
              const errorMessage =
                typeof message.finalError === "string" && message.finalError.trim()
                  ? message.finalError
                  : "Pi exhausted its automatic retry attempts.";
              ctx.terminalFailure = { state: "failed", errorMessage };
            }
            yield* emitWarning(
              ctx.threadId,
              ctx.activeTurnId,
              message.success === false
                ? "Pi automatic retry failed."
                : "Pi automatic retry recovered.",
              message,
            );
            return;
          case "compaction_start":
            yield* emitWarning(
              ctx.threadId,
              ctx.activeTurnId,
              "Pi is compacting context.",
              message,
            );
            return;
          case "compaction_end": {
            const errorMessage =
              typeof message.errorMessage === "string" && message.errorMessage.trim()
                ? message.errorMessage
                : undefined;
            if (message.aborted === true) {
              ctx.terminalFailure = {
                state: "interrupted",
                stopReason: "compaction aborted",
              };
            } else if (errorMessage) {
              ctx.terminalFailure = { state: "failed", errorMessage };
            }
            if (errorMessage) {
              yield* emitRuntimeError(
                ctx.threadId,
                ctx.activeTurnId,
                "Pi context compaction failed.",
                message,
              );
            } else if (message.aborted === true) {
              yield* emitWarning(
                ctx.threadId,
                ctx.activeTurnId,
                "Pi context compaction was aborted.",
                message,
              );
            } else {
              yield* emit({
                type: "thread.state.changed",
                ...(yield* makeStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                payload: { state: "compacted", detail: message.result ?? message },
              });
            }
            return;
          }
          case "extension_error": {
            const error =
              typeof message.error === "string" && message.error.trim()
                ? message.error
                : "Pi extension failed.";
            const event = typeof message.event === "string" ? ` during ${message.event}` : "";
            const extensionPath =
              typeof message.extensionPath === "string" ? ` (${message.extensionPath})` : "";
            yield* emitRuntimeError(
              ctx.threadId,
              ctx.activeTurnId,
              `Pi extension error${extensionPath}${event}: ${error}`,
              message,
            );
            return;
          }
          default:
            return;
        }
      });

    const startEventPump = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        // Watch for unexpected process exit while a turn is in flight.
        yield* ctx.connection.awaitExit.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (ctx.stopped || sessions.get(ctx.threadId) !== ctx) return;
              if (ctx.activeTurnId !== undefined) {
                yield* completeTurn(ctx, "failed", {
                  errorMessage: `Pi process exited unexpectedly (code ${code}).`,
                });
              }
              yield* emit({
                type: "session.exited",
                ...(yield* makeStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                payload: { exitKind: code === 0 ? "graceful" : "error" },
              });
              sessions.delete(ctx.threadId);
              yield* resetBackgroundTerminals(ctx.threadId);
              ctx.stopped = true;
              yield* failTaskControlWaiters(
                ctx.threadId,
                "The Pi session exited before the task control completed.",
              );
              // The session scope is independent from startSession's request
              // scope. Close it on spontaneous exit as well as explicit stop,
              // otherwise its queues and transport fibers survive after the
              // context is removed from `sessions` and can never be reached by
              // the adapter finalizer.
              yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
            }),
          ),
          Effect.forkIn(ctx.scope),
        );
      });

    // ── ProviderAdapterShape methods ────────────────────────────────────

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* failTaskControlWaiters(
          ctx.threadId,
          "The Pi session stopped before the task control completed.",
        );
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) === ctx) {
          sessions.delete(ctx.threadId);
          yield* resetBackgroundTerminals(ctx.threadId);
          yield* emit({
            type: "session.exited",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            payload: { exitKind: "graceful" },
          });
        }
      });

    const resolveModelSelection = (modelSelection: ModelSelection | undefined) => {
      const selection = modelSelection?.instanceId === boundInstanceId ? modelSelection : undefined;
      const model = selection?.model?.trim() || undefined;
      const thinkingLevel = parsePiThinkingLevel(
        getModelSelectionStringOptionValue(selection, PI_THINKING_OPTION_ID),
      );
      const contextWindow = parsePiContextWindow(
        getModelSelectionStringOptionValue(selection, PI_CONTEXT_WINDOW_OPTION_ID),
      );
      const fastServiceEnabled = supportsPiCodexFastService(model)
        ? (parsePiFastServiceEnabled(
            getModelSelectionStringOptionValue(selection, PI_SERVICE_TIER_OPTION_ID),
          ) ?? false)
        : undefined;
      const profile = getModelSelectionStringOptionValue(selection, PI_PROFILE_OPTION_ID)?.trim();
      return {
        model,
        thinkingLevel,
        contextWindow,
        fastServiceEnabled,
        profile: profile || undefined,
      };
    };

    const startSession: PiAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const cwd = path.resolve(input.cwd.trim());
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const { model, thinkingLevel, contextWindow, fastServiceEnabled, profile } =
          resolveModelSelection(input.modelSelection);
        const resumeSessionId =
          isRecord(input.resumeCursor) && typeof input.resumeCursor.piSessionId === "string"
            ? input.resumeCursor.piSessionId
            : undefined;

        const sessionScope = yield* Scope.make();
        let scopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const sendSemaphore = yield* Semaphore.make(1);
        const ctx: PiSessionContext = {
          threadId: input.threadId,
          connection: undefined as unknown as PiRpcConnection,
          scope: sessionScope,
          session: undefined as unknown as ProviderSession,
          activeTurnId: undefined,
          turns: [],
          piSessionId: resumeSessionId,
          assistantItemId: undefined,
          assistantItemHasText: false,
          assistantItemHasReasoning: false,
          assistantWorkBoundaryPending: false,
          assistantContent: makePiAssistantContentState(),
          assistantOrigin: "normal",
          hasPrimaryAssistantAnswer: false,
          subagentLiveMessages: new Map(),
          subagentLivePublishedAtByKey: new Map(),
          toolArgsByCallId: new Map(),
          toolUpdateEmittedAtByCallId: new Map(),
          lastAgentEndOutcome: undefined,
          terminalFailure: undefined,
          interruptRequested: false,
          commandCatalog: undefined,
          pendingUserExtensionCommand: undefined,
          contextWindowSelectionKey: undefined,
          fastServiceEnabled: undefined,
          sendSemaphore,
          stopped: false,
        };

        // The extension-local manager belongs to one Pi subprocess. Clear
        // any prior process epoch before the new process can emit events.
        yield* resetBackgroundTerminals(input.threadId);

        const connection = yield* makePiRpcConnection({
          threadId: input.threadId,
          binaryPath: resolvePiBinary(piSettings),
          args: buildPiRpcArgs(piSettings, {
            ...(profile ? { profile } : {}),
            ...(model ? { model } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
          }),
          cwd,
          env: buildPiRpcEnv(path, piSettings, baseEnv),
          onMessage: (message) =>
            handlePiMessage(ctx)(message).pipe(Effect.catchCause(() => Effect.void)),
          onParseFailure: (line) =>
            emitWarning(input.threadId, ctx.activeTurnId, "Pi emitted an unparseable RPC frame.", {
              line: line.slice(0, 2_000),
            }).pipe(Effect.catchCause(() => Effect.void)),
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        (ctx as { connection: PiRpcConnection }).connection = connection;

        // Pi creates/opens the durable session during process startup. Resolve
        // its authoritative id before returning so T3 persists a usable resume
        // cursor even if the process dies before the first turn.
        const stateResponse = yield* request(ctx, { type: "get_state" });
        const activePiSessionId = readPiSessionId(stateResponse);
        if (!activePiSessionId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "get_state",
            detail: "Pi RPC state response did not include a session id.",
          });
        }
        ctx.piSessionId = activePiSessionId;
        // Profiles can intentionally choose their own default during
        // session_start, overriding Pi's CLI --model argument. Reassert T3's
        // selected model over RPC before configuring model-specific options.
        if (model) {
          yield* selectPiModel(ctx, model, "startSession");
        }
        if (thinkingLevel) {
          yield* request(ctx, { type: "set_thinking_level", level: thinkingLevel });
        }

        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(model ? { model } : {}),
          threadId: input.threadId,
          resumeCursor: { piSessionId: activePiSessionId },
          createdAt: now,
          updatedAt: now,
        };
        (ctx as { session: ProviderSession }).session = session;
        yield* syncContextWindow(ctx, model, contextWindow);
        yield* syncFastService(ctx, fastServiceEnabled);

        sessions.set(input.threadId, ctx);
        scopeTransferred = true;
        yield* startEventPump(ctx);

        yield* emit({
          type: "session.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: {},
        });
        yield* emit({
          type: "session.state.changed",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Pi RPC session ready" },
        });
        yield* emit({
          type: "thread.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: activePiSessionId },
        });
        return session;
      }).pipe(Effect.scoped);

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.flatMap(requireSession(input.threadId), (ctx) =>
        ctx.sendSemaphore.withPermit(
          Effect.gen(function* () {
            const { model, thinkingLevel, contextWindow, fastServiceEnabled } =
              resolveModelSelection(input.modelSelection);

            // In-session model / thinking switch.
            if (model && model !== ctx.session.model) {
              yield* selectPiModel(ctx, model, "sendTurn");
              ctx.session = { ...ctx.session, model };
            }
            if (thinkingLevel) {
              yield* request(ctx, { type: "set_thinking_level", level: thinkingLevel });
            }
            yield* syncContextWindow(ctx, model, contextWindow);
            yield* syncFastService(ctx, fastServiceEnabled);

            const text = input.input?.trim();
            // Pi's RPC transport accepts image payloads only. Generic files
            // are represented by the path text ProviderService adds to the
            // prompt, matching the other image-only adapters.
            const images = yield* Effect.forEach(
              (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
              (attachment) =>
                Effect.gen(function* () {
                  const attachmentPath = resolveAttachmentPath({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachment,
                  });
                  if (!attachmentPath) {
                    return yield* new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "prompt",
                      detail: `Invalid attachment id '${attachment.id}'.`,
                    });
                  }
                  const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapterRequestError({
                          provider: PROVIDER,
                          method: "prompt",
                          detail: cause.message,
                          cause,
                        }),
                    ),
                  );
                  return {
                    type: "image" as const,
                    data: Buffer.from(bytes).toString("base64"),
                    mimeType: attachment.mimeType,
                  };
                }),
            );

            if (!text && images.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }

            // sendTurn is itself an authoritative user-origin signal. Pi
            // normally echoes role:user, but extension slash commands may
            // complete without emitting that native message.
            ctx.assistantOrigin = "normal";
            ctx.hasPrimaryAssistantAnswer = false;

            const slashCommandName = text ? piSlashCommandName(text) : undefined;
            const extensionCommandName =
              slashCommandName !== undefined &&
              (yield* loadPiCommandCatalog(ctx)).extensionNames.has(slashCommandName)
                ? slashCommandName
                : undefined;

            // A sendTurn while a turn is in flight is normally a steer that
            // folds into the active turn. Registered extension commands are
            // the exception: Pi executes them only through prompt(), including
            // while an agent run is streaming.
            const steering = ctx.activeTurnId !== undefined;
            const turnId = ctx.activeTurnId ?? TurnId.make(yield* randomUUIDv4);
            if (!steering) {
              ctx.lastAgentEndOutcome = undefined;
              ctx.terminalFailure = undefined;
              ctx.interruptRequested = false;
            }
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            if (!steering) {
              yield* emit({
                type: "turn.started",
                ...(yield* makeStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: ctx.session.model ? { model: ctx.session.model } : {},
              });
            }

            const rpcInput = {
              message: text ?? "",
              ...(images.length > 0 ? { images } : {}),
            };
            if (extensionCommandName !== undefined) {
              const pending: PendingUserExtensionCommand = {
                turnId,
                openedTurn: !steering,
                agentStarted: false,
              };
              ctx.pendingUserExtensionCommand = pending;
              yield* Effect.gen(function* () {
                yield* request(ctx, { type: "prompt", ...rpcInput });
                if (!pending.openedTurn) return;

                const state = yield* request(ctx, { type: "get_state" });
                if (
                  ctx.activeTurnId === turnId &&
                  !pending.agentStarted &&
                  piRpcStateIsIdle(state)
                ) {
                  yield* completeTurn(ctx, "completed", undefined, turnId);
                }
              }).pipe(
                Effect.tapError(() =>
                  pending.openedTurn
                    ? completeTurn(
                        ctx,
                        "failed",
                        { errorMessage: "Failed to run the Pi extension command." },
                        turnId,
                      )
                    : Effect.void,
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (ctx.pendingUserExtensionCommand === pending) {
                      ctx.pendingUserExtensionCommand = undefined;
                    }
                  }),
                ),
              );
            } else {
              yield* request(
                ctx,
                steering ? { type: "steer", ...rpcInput } : { type: "prompt", ...rpcInput },
              ).pipe(
                Effect.tapError(() =>
                  completeTurn(
                    ctx,
                    "failed",
                    { errorMessage: "Failed to send prompt to Pi." },
                    turnId,
                  ),
                ),
              );
            }

            ctx.turns = [
              ...ctx.turns,
              { id: turnId, items: [{ prompt: text ?? "", images: images.length }] },
            ];
            return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
          }),
        ),
      );

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) return;
        const active = ctx.activeTurnId;
        if (active === undefined) return;
        if (turnId !== undefined && turnId !== active) return;
        ctx.interruptRequested = true;
        yield* request(ctx, { type: "abort" }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              ctx.interruptRequested = false;
            }),
          ),
          Effect.ignore,
        );
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId) =>
      Effect.gen(function* () {
        // Yolo mode resolves approvals in-process; there is no pending queue.
        yield* requireSession(threadId);
      });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
      });

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      });

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        // Documented gap: Pi RPC exposes fork/switch_session but not an
        // N-turn rollback of the live session. Fail typed rather than pretend.
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollback",
          detail: "Pi sessions do not support provider-side rollback yet.",
        });
      });

    const controlTask: NonNullable<PiAdapterShape["controlTask"]> = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // Pi forwards unknown slash commands to the model. Revalidate the
        // private bridge command before every control so a missing extension
        // can never turn a UI action into an unintended user prompt.
        if (!(yield* piAdvertisesCommand(ctx, "subagents-rpc", true))) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "controlTask",
            issue: "The Pi subagent control extension is not installed in this session.",
          });
        }
        const action = input.action === "stop" ? "kill" : input.action;
        const requestId = `t3-${yield* randomUUIDv4}`;
        const waiterKey = extensionControlKey(input.threadId, requestId);
        const envelope = {
          action,
          request_id: requestId,
          run_id: input.taskId,
          ...(input.action === "steer" || input.action === "reply"
            ? { message: input.message }
            : { reason: input.reason ?? "Stopped from T3 Code" }),
        };
        const encoded = yield* encodeUnknownJsonString(envelope).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "subagents-rpc",
                detail: "Failed to encode Pi task control.",
                cause,
              }),
          ),
        );
        const waiter = yield* Deferred.make<PiTaskControlResult, ProviderAdapterRequestError>();
        taskControlWaiters.set(waiterKey, waiter);
        const result = yield* Effect.gen(function* () {
          yield* request(ctx, {
            type: "prompt",
            message: `/subagents-rpc ${encoded}`,
          });
          return yield* Deferred.await(waiter).pipe(
            Effect.timeout(PI_EXTENSION_CONTROL_TIMEOUT),
            Effect.catchTag("TimeoutError", (cause) =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "subagents-rpc",
                  detail: "Timed out waiting for the Pi task control result.",
                  cause,
                }),
              ),
            ),
          );
        }).pipe(Effect.ensuring(Effect.sync(() => taskControlWaiters.delete(waiterKey))));
        if (result.action !== action || !result.success) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "subagents-rpc",
            detail:
              result.error ||
              (result.action !== action
                ? `Pi returned a '${result.action}' result for the '${action}' task control.`
                : `Pi rejected the ${input.action} task control.`),
          });
        }
      }).pipe(Effect.asVoid);

    const controlBackgroundTerminal = (input: PiBackgroundTerminalControlInput) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (
          input.action === "kill" &&
          backgroundTerminalManagerIds.get(input.threadId) !== input.managerId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "controlBackgroundTerminal",
            issue: "The selected background terminal belongs to a stale Pi process.",
          });
        }
        // Pi forwards unknown slash commands to the model. Never send the
        // private control command until the live extension advertises it.
        if (!(yield* piAdvertisesCommand(ctx, "background-terminals-rpc", true))) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "controlBackgroundTerminal",
            issue: "The Pi background-terminal control extension is not installed in this session.",
          });
        }
        const requestId = input.requestId ?? `t3-${yield* randomUUIDv4}`;
        const waiterKey = extensionControlKey(input.threadId, requestId);
        if (backgroundTerminalControlWaiters.has(waiterKey)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "controlBackgroundTerminal",
            issue: `A background-terminal control with request id '${requestId}' is already pending.`,
          });
        }
        const envelope = {
          action: input.action,
          request_id: requestId,
          ...(input.action === "kill" ? { terminal_id: input.terminalId } : {}),
        };
        const encoded = yield* encodeUnknownJsonString(envelope).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "background-terminals-rpc",
                detail: "Failed to encode Pi background-terminal control.",
                cause,
              }),
          ),
        );
        const waiter = yield* Deferred.make<PiBackgroundTerminalControlResult>();
        backgroundTerminalControlWaiters.set(waiterKey, waiter);
        const result = yield* Effect.gen(function* () {
          yield* request(ctx, {
            type: "prompt",
            message: `/background-terminals-rpc ${encoded}`,
          });
          return yield* Deferred.await(waiter).pipe(
            Effect.timeout(PI_EXTENSION_CONTROL_TIMEOUT),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "background-terminals-rpc",
                  detail: "Timed out waiting for the Pi background-terminal control result.",
                  cause,
                }),
            ),
          );
        }).pipe(
          Effect.ensuring(Effect.sync(() => backgroundTerminalControlWaiters.delete(waiterKey))),
        );
        if (result.action !== input.action || !result.success) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "background-terminals-rpc",
            detail:
              result.error ||
              (result.action !== input.action
                ? `Pi returned a '${result.action}' result for the '${input.action}' control.`
                : `Pi rejected the background-terminal ${input.action} control.`),
          });
        }
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEvents)),
        Effect.tap(() => PubSub.shutdown(backgroundTerminalEvents)),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEvents);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
      },
      compaction: { type: "slash-command", command: "/compact" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      controlTask,
      backgroundTerminals: {
        control: controlBackgroundTerminal,
        streamEvents: Stream.fromPubSub(backgroundTerminalEvents),
      },
      stopAll,
      streamEvents,
    } satisfies PiAdapterShape;
  });
}
