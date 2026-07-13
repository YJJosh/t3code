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
  PI_PROFILE_OPTION_ID,
  type PiSettings,
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
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
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
import {
  autoRespondToExtensionUi,
  buildPiRpcArgs,
  buildPiRpcEnv,
  extractPiAssistantText,
  parsePiFastServiceEnabled,
  parsePiSubagentNotification,
  parsePiThinkingLevel,
  PI_CODEX_FAST_COMMAND,
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
  /** Cached `/fast` command availability and synchronized session state. */
  fastCommandAvailable: boolean | undefined;
  fastServiceEnabled: boolean | undefined;
  /** Keeps model/thinking/service-tier synchronization atomic with its prompt. */
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
      ...(errorMessage ? { errorMessage } : {}),
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

function piRpcAdvertisesCommand(response: PiRpcResponse, commandName: string): boolean {
  if (!isRecord(response.data) || !Array.isArray(response.data.commands)) {
    return false;
  }
  return response.data.commands.some(
    (command) => isRecord(command) && command.name === commandName,
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
    const baseEnv = options?.environment ?? process.env;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const subagentEvents = yield* PubSub.unbounded<{
      readonly threadId: ThreadId;
      readonly event: PiSubagentEvent;
    }>();

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

    const syncFastService = (ctx: PiSessionContext, enabled: boolean | undefined) =>
      Effect.gen(function* () {
        if (enabled === undefined || enabled === ctx.fastServiceEnabled) return;
        if (ctx.fastCommandAvailable === undefined) {
          const commands = yield* request(ctx, { type: "get_commands" });
          ctx.fastCommandAvailable = piRpcAdvertisesCommand(commands, PI_CODEX_FAST_COMMAND);
        }
        if (!ctx.fastCommandAvailable) {
          if (!enabled) {
            ctx.fastServiceEnabled = false;
            return;
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: PI_CODEX_FAST_COMMAND,
            detail:
              "Pi does not advertise the /fast command required for Codex priority service. Enable the effort-commands extension in the selected Pi profile.",
          });
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
        const subagentEvent = parsePiSubagentNotification(request);
        if (subagentEvent) {
          yield* PubSub.publish(subagentEvents, { threadId: ctx.threadId, event: subagentEvent });
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

    const handleToolEvent = (
      ctx: PiSessionContext,
      lifecycle: "item.started" | "item.updated" | "item.completed",
      message: Record<string, unknown>,
    ) =>
      Effect.gen(function* () {
        const toolCallId =
          typeof message.toolCallId === "string" ? message.toolCallId : yield* randomUUIDv4;
        const itemId = RuntimeItemId.make(toolCallId);
        const turnId = ctx.activeTurnId;
        const itemType = toolItemType((message as PiToolMeta).toolName);
        const status =
          lifecycle === "item.completed"
            ? message.isError === true
              ? "failed"
              : "completed"
            : "inProgress";
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
          },
        });
      });

    const handlePiMessage = (ctx: PiSessionContext) => (message: unknown) =>
      Effect.gen(function* () {
        if (!isRecord(message) || typeof message.type !== "string") return;
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
          case "message_start":
            return;
          case "message_update":
          case "message_end":
            yield* emitAssistantDelta(ctx, message.message);
            if (message.type === "message_end") {
              yield* finishAssistantItem(ctx);
            }
            return;
          case "tool_execution_start":
            yield* handleToolEvent(ctx, "item.started", message);
            return;
          case "tool_execution_update":
            yield* handleToolEvent(ctx, "item.updated", message);
            return;
          case "tool_execution_end":
            yield* handleToolEvent(ctx, "item.completed", message);
            return;
          case "agent_end": {
            // The true finalizer. `willRetry` means Pi will auto-retry, so the
            // turn is still running — do not settle yet.
            if (message.willRetry === true) return;
            const outcome = readAgentEndOutcome(message);
            yield* completeTurn(ctx, outcome.state, {
              stopReason: outcome.stopReason,
              ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
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
          case "compaction_start":
          case "compaction_end":
            yield* emitWarning(
              ctx.threadId,
              ctx.activeTurnId,
              `Pi context ${message.type}.`,
              message,
            );
            return;
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
              if (ctx.stopped) return;
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
        sessions.delete(ctx.threadId);
        yield* emit({
          type: "session.exited",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const resolveModelSelection = (modelSelection: ModelSelection | undefined) => {
      const selection = modelSelection?.instanceId === boundInstanceId ? modelSelection : undefined;
      const model = selection?.model?.trim() || undefined;
      const thinkingLevel = parsePiThinkingLevel(
        getModelSelectionStringOptionValue(selection, PI_THINKING_OPTION_ID),
      );
      const fastServiceEnabled = supportsPiCodexFastService(model)
        ? (parsePiFastServiceEnabled(
            getModelSelectionStringOptionValue(selection, PI_SERVICE_TIER_OPTION_ID),
          ) ?? false)
        : undefined;
      const profile = getModelSelectionStringOptionValue(selection, PI_PROFILE_OPTION_ID)?.trim();
      return { model, thinkingLevel, fastServiceEnabled, profile: profile || undefined };
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

        const { model, thinkingLevel, fastServiceEnabled, profile } = resolveModelSelection(
          input.modelSelection,
        );
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
          fastCommandAvailable: undefined,
          fastServiceEnabled: undefined,
          sendSemaphore,
          stopped: false,
        };

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
            const { model, thinkingLevel, fastServiceEnabled } = resolveModelSelection(
              input.modelSelection,
            );

            // In-session model / thinking switch.
            if (model && model !== ctx.session.model) {
              yield* selectPiModel(ctx, model, "sendTurn");
              ctx.session = { ...ctx.session, model };
            }
            if (thinkingLevel) {
              yield* request(ctx, { type: "set_thinking_level", level: thinkingLevel });
            }
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
        yield* request(ctx, { type: "abort" }).pipe(Effect.ignore);
        yield* completeTurn(ctx, "cancelled", { stopReason: "cancelled" });
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
        const commands = yield* request(ctx, { type: "get_commands" });
        if (!piRpcAdvertisesCommand(commands, "subagents-rpc")) {
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

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEvents)),
        Effect.tap(() => PubSub.shutdown(subagentEvents)),
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
      stopAll,
      streamEvents,
    } satisfies PiAdapterShape;
  });
}
