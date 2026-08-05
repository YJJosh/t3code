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
  EventId,
  type ModelSelection,
  PI_BACKGROUND_TERMINAL_EVENT_CONTRACT_VERSION,
  PI_PROFILE_OPTION_ID,
  type PiSettings,
  type PiBackgroundTerminalControlInput,
  type PiBackgroundTerminalControlResult,
  type PiSubagentControlInput,
  type PiSubagentEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderItemId,
  RuntimeItemId,
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
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
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
  extractPiAssistantText,
  parsePiBackgroundTerminalNotification,
  parsePiContextWindow,
  parsePiFastServiceEnabled,
  parsePiSubagentNotification,
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
} from "../pi/piRpcProtocol.ts";
import {
  makePiRpcConnection,
  type PiRpcConnection,
  type PiRpcResponse,
} from "./PiRpcConnection.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const CLAUDE_AGENT_SDK_RPC_BRIDGE_ENV = "CLAUDE_AGENT_SDK_RPC_BRIDGE";
const CLAUDE_AGENT_SDK_RPC_EVENT_PREFIX = "claude-agent-sdk:tool-lifecycle:v1:";
const TOOL_UPDATE_MIN_INTERVAL_NANOS = 1_000_000_000n;
const TOOL_UPDATE_SUMMARY_MAX_CHARS = 4_000;
const TOOL_UPDATE_TRUNCATION_MARKER = "…[truncated]\n";

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
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
  /** Current assistant item id + accumulated text/reasoning for delta diffing. */
  assistantItemId: ProviderItemId | undefined;
  assistantText: string;
  reasoningText: string;
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
  /** Cached extension-command availability and synchronized session state. */
  extensionCommandNames: ReadonlySet<string> | undefined;
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

function piRpcCommandNames(response: PiRpcResponse): ReadonlySet<string> {
  if (!isRecord(response.data) || !Array.isArray(response.data.commands)) {
    return new Set();
  }
  return new Set(
    response.data.commands.flatMap((command) =>
      isRecord(command) && typeof command.name === "string" ? [command.name] : [],
    ),
  );
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
    const subagentEvents = yield* PubSub.unbounded<{
      readonly threadId: ThreadId;
      readonly event: PiSubagentEvent;
    }>();
    const backgroundTerminalEvents = yield* makeBackgroundTerminalEventPubSub();
    const backgroundTerminalControlWaiters = new Map<
      string,
      Deferred.Deferred<PiBackgroundTerminalControlResult>
    >();
    const backgroundTerminalManagerIds = new Map<ThreadId, string>();
    const backgroundTerminalControlKey = (threadId: ThreadId, requestId: string) =>
      `${threadId}\u0000${requestId}`;

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

    const piAdvertisesCommand = (ctx: PiSessionContext, commandName: string, refresh = false) =>
      Effect.gen(function* () {
        if (refresh || ctx.extensionCommandNames === undefined) {
          const commands = yield* request(ctx, { type: "get_commands" });
          ctx.extensionCommandNames = piRpcCommandNames(commands);
        }
        return ctx.extensionCommandNames.has(commandName);
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
        }
        const subagentEvent = parsePiSubagentNotification(request);
        if (subagentEvent) {
          yield* PubSub.publish(subagentEvents, { threadId: ctx.threadId, event: subagentEvent });
          return;
        }
        const backgroundTerminalEvent = parsePiBackgroundTerminalNotification(request);
        if (backgroundTerminalEvent) {
          const activeManagerId = backgroundTerminalManagerIds.get(ctx.threadId);
          // A manager switch is authoritative only when announced by a snapshot.
          // Ignore late non-snapshot events from a stopped/replaced Pi process.
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
              backgroundTerminalControlKey(ctx.threadId, backgroundTerminalEvent.control.requestId),
            );
            if (waiter) {
              yield* Deferred.succeed(waiter, backgroundTerminalEvent.control).pipe(Effect.ignore);
            }
          }
          return;
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

    const emitAssistantDelta = (
      ctx: PiSessionContext,
      message: unknown,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        if (!isRecord(message) || message.role !== "assistant") return;
        const { text, thinking } = extractPiAssistantText(message);
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
        if (thinking.length > ctx.reasoningText.length) {
          const delta = thinking.slice(ctx.reasoningText.length);
          ctx.reasoningText = thinking;
          yield* emit({
            type: "content.delta",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(turnId ? { turnId } : {}),
            itemId,
            payload: { streamKind: "reasoning_text", delta },
          });
        }
        if (text.length > ctx.assistantText.length) {
          const delta = text.slice(ctx.assistantText.length);
          ctx.assistantText = text;
          yield* emit({
            type: "content.delta",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(turnId ? { turnId } : {}),
            itemId,
            payload: { streamKind: "assistant_text", delta },
          });
        }
      });

    const finishAssistantItem = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.assistantItemId === undefined) return;
        const itemId = RuntimeItemId.make(ctx.assistantItemId);
        const turnId = ctx.activeTurnId;
        yield* emit({
          type: "item.completed",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(turnId ? { turnId } : {}),
          itemId,
          payload: { itemType: "assistant_message", status: "completed" },
        });
        ctx.assistantItemId = undefined;
        ctx.assistantText = "";
        ctx.reasoningText = "";
      });

    const completeTurn = (
      ctx: PiSessionContext,
      state: "completed" | "failed" | "cancelled" | "interrupted",
      extra?: { readonly errorMessage?: string; readonly stopReason?: string | null },
    ) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurnId;
        if (turnId === undefined) return;
        yield* finishAssistantItem(ctx);
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
          case "agent_start":
            yield* ensureActiveTurnForAgentStart(ctx);
            return;
          case "message_start":
            // The turn is opened by sendTurn or an explicit agent_start. Pi may
            // emit startup/profile and late extension messages outside a turn;
            // those messages must not invent autonomous work on their own.
            return;
          case "message_update":
          case "message_end":
            if (
              ctx.activeTurnId === undefined ||
              !isRecord(message.message) ||
              message.message.role !== "assistant"
            ) {
              return;
            }
            yield* emitAssistantDelta(ctx, message.message);
            if (message.type === "message_end") {
              yield* finishAssistantItem(ctx);
            }
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
          assistantText: "",
          reasoningText: "",
          toolArgsByCallId: new Map(),
          toolUpdateEmittedAtByCallId: new Map(),
          lastAgentEndOutcome: undefined,
          terminalFailure: undefined,
          interruptRequested: false,
          extensionCommandNames: undefined,
          contextWindowSelectionKey: undefined,
          fastServiceEnabled: undefined,
          sendSemaphore,
          stopped: false,
        };

        // A Pi process owns its extension-local terminal manager. Clear the
        // previous process epoch before wiring onMessage so a real startup
        // snapshot from the new extension always wins this ordering race.
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
          env: buildPiRpcEnv(piSettings, baseEnv),
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
            const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
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

            // A sendTurn while a turn is in flight is a steer that folds into the
            // active turn; otherwise it opens a new turn.
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

            yield* request(
              ctx,
              steering
                ? { type: "steer", message: text ?? "", ...(images.length > 0 ? { images } : {}) }
                : { type: "prompt", message: text ?? "", ...(images.length > 0 ? { images } : {}) },
            ).pipe(
              Effect.tapError(() =>
                completeTurn(ctx, "failed", { errorMessage: "Failed to send prompt to Pi." }),
              ),
            );

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

    const controlSubagent = (input: PiSubagentControlInput) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A prompt beginning with an unknown slash command is forwarded to the
        // model by Pi. Verify the private bridge command exists before sending
        // it so opening a thread without the optional pi-subagents extension
        // can never create an unintended user turn.
        if (!(yield* piAdvertisesCommand(ctx, "subagents-rpc", true))) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "controlSubagent",
            issue: "The Pi subagent control extension is not installed in this session.",
          });
        }
        const envelope = {
          action: input.action,
          ...(input.requestId ? { request_id: input.requestId } : {}),
          ...(input.runId ? { run_id: input.runId } : {}),
          ...(input.action === "steer" || input.action === "reply"
            ? { message: input.message }
            : {}),
          ...(input.action === "kill" ? { reason: input.reason } : {}),
        };
        const encoded = yield* encodeUnknownJsonString(envelope).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "subagents-rpc",
                detail: "Failed to encode Pi subagent control.",
                cause,
              }),
          ),
        );
        yield* request(ctx, {
          type: "prompt",
          message: `/subagents-rpc ${encoded}`,
        });
      });

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
        // Pi treats unknown slash commands as model prompts. Only send this
        // private extension command after it was advertised by the live session.
        if (!(yield* piAdvertisesCommand(ctx, "background-terminals-rpc", true))) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "controlBackgroundTerminal",
            issue: "The Pi background-terminal control extension is not installed in this session.",
          });
        }
        const requestId = input.requestId ?? `t3-${yield* randomUUIDv4}`;
        const waiterKey = backgroundTerminalControlKey(input.threadId, requestId);
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
            Effect.timeout("12 seconds"),
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

    const nameSession: NonNullable<PiAdapterShape["nameSession"]> = (threadId, name) =>
      Effect.gen(function* () {
        const trimmed = name.trim();
        if (!trimmed) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "nameSession",
            issue: "Session name must be non-empty.",
          });
        }
        const ctx = yield* requireSession(threadId);
        yield* request(ctx, { type: "set_session_name", name: trimmed });
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEvents)),
        Effect.tap(() => PubSub.shutdown(subagentEvents)),
        Effect.tap(() => PubSub.shutdown(backgroundTerminalEvents)),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEvents);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      subagents: {
        control: controlSubagent,
        streamEvents: Stream.fromPubSub(subagentEvents),
      },
      backgroundTerminals: {
        control: controlBackgroundTerminal,
        streamEvents: Stream.fromPubSub(backgroundTerminalEvents),
      },
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
      nameSession,
      stopAll,
      streamEvents,
    } satisfies PiAdapterShape;
  });
}
