import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import {
  makePiDaemonConnection,
  piDaemonSkipKey,
  isPiDaemonSkipped,
  skipPiDaemon,
} from "./PiDaemonConnection.ts";
import { findPiSessionsExtension } from "./PiSessionsStart.ts";
import { piSessionsHome } from "./PiSessionsSocket.ts";
import {
  applyPiAssistantBlockEvent,
  applyPiAssistantSnapshot,
  makePiAssistantContentState,
  piAssistantBlockHasContent,
  type PiAssistantContentState,
  type PiAssistantContentDelta,
} from "./piAssistantContent.ts";
import * as Path from "effect/Path";
import { DulliBridgeRegistry, DulliSharedEnvironment } from "./bridges.ts";
import {
  buildPiRpcArgs,
  buildPiRpcEnv,
  parsePiContextWindow,
  parsePiFastServiceEnabled,
  supportsPiCodexFastService,
  extractPiAssistantContent,
  parseClaudeCodeToolTrace,
} from "./piRpcProtocol.ts";
import { resolvePiSessionConfigSet } from "./piConfigSetDiscovery.ts";
import { discoverPiProfileChoices } from "./piProfileDiscovery.ts";
/**
 * Honor the user’s Pi: no --no-* flags, and Pi’s session file is the durable native ref.
 * Only agent_settled ends a turn; agent_end can precede retries or continuations.
 * Confirm idleness because extensions can start detached compaction during settlement.
 * Extension dialogs use runtime requests; terminal-only decoration has no T3 surface.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { readToolOutputImage } from "@t3tools/shared/toolOutput";
import * as Predicate from "effect/Predicate";
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import { DulliSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { parsePiCompactCommand, type PiCompactCommand } from "./commands.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcRecord,
  type PiRpcConnection,
  PiRpcError,
} from "./rpc.ts";
import { buildPiRpcLaunch, materializePiT3McpExtension } from "./mcpInjection.ts";
import { PI_FILE_CHANGE_TOOLS } from "./mcpExtensionSource.ts";

export const DULLI_PROVIDER = ProviderDriverKind.make("dulli");
const PI_DRIVER_KIND = DULLI_PROVIDER;
const decodeClaudeBridgePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const DEFAULT_PI_SETTINGS = Schema.decodeSync(DulliSettings)({});

/**
 * Sentinel model slug meaning "do not call set_model": Pi resolves the model
 * from the user's own settings.json (`defaultProvider`/`defaultModel`).
 */
const PI_INHERIT_MODEL_SLUG = "default";

const STREAM_FLUSH_MS = 50;
const PI_REQUEST_TIMEOUT_MS = 15_000;
// Session lifecycle hooks reload extensions, MCP servers and language servers.
const PI_SESSION_TIMEOUT_MS = 60_000;
const PI_UNSOLICITED_ACTIVITY_ERROR =
  "Pi started agent work outside an active T3 turn. The session was stopped to prevent invisible tool execution.";
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
const SETTLE_PROBE_RETRY_DELAY = Duration.millis(100);

const PiProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // Mode changes restart this process so the injected permission hook gets
    // one immutable policy for its whole lifetime.
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    // Dulli runs in full-access mode. Extension confirmation dialogs are
    // supported, but they do not provide a supervised tool-approval policy.
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    // T3 delegation uses the shared MCP `delegate_task` path. Installed Pi
    // subagent extensions are observed best-effort, but their official tool
    // runs children with --no-session and exposes no resumable child id.
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: true,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    // T3 delivers both full and delta handoffs through Pi's normal user-message
    // input, so neither strategy depends on a Pi-specific context hook.
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    // CommandPolicy.ensureRollback requires the snapshot whenever provider
    // rollback is enabled; rollbackThread returns the updated provider thread.
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

// pi-sessions/src/rpc-host.ts deliberately exposes less than standalone RPC.
const PI_SHARED_COMMANDS = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "get_state",
  "get_messages",
  "get_available_models",
  "get_commands",
  "set_model",
  "set_thinking_level",
  "set_session_name",
  "extension_ui_response",
]);
const PiSharedProviderCapabilitiesV2 = {
  ...PiProviderCapabilitiesV2,
  threads: {
    ...PiProviderCapabilitiesV2.threads,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
  },
  checkpointing: {
    ...PiProviderCapabilitiesV2.checkpointing,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface DulliAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: DulliSettings;
  readonly environment: NodeJS.ProcessEnv;
  /**
   * Where to offer a wake turn for provider-initiated work. Without one, such
   * work has no owner and the adapter stops it.
   */
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}

/** Concatenate the `text` fields of a Pi content-block array. */
function contentText(content: unknown, separator = ""): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) => {
      if (recordField(block, "type") === "text") return recordString(block, "text") ?? "";
      return "";
    })
    .filter((part) => part.length > 0)
    .join(separator);
}

const MAX_STRUCTURED_TOOL_OUTPUT_BYTES = 64 * 1024;

/** Preserve complete structured JSON only when its size and traversal remain bounded. */
function isBoundedStructuredToolValue(value: unknown): boolean {
  let bytes = MAX_STRUCTURED_TOOL_OUTPUT_BYTES;
  let nodes = 4_096;
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 32 || --nodes < 0 || bytes < 0) return false;
    if (Array.isArray(entry)) {
      bytes -= 2 + entry.length;
      return entry.every((item) => visit(item, depth + 1));
    }
    if (Predicate.isObject(entry)) {
      bytes -= 2;
      for (const key in entry) {
        if (!Object.hasOwn(entry, key)) continue;
        if (key.length > bytes) return false;
        bytes -= Buffer.byteLength(JSON.stringify(key), "utf8") + 2;
        if (!visit(entry[key], depth + 1)) return false;
      }
      return bytes >= 0;
    }
    if (typeof entry === "string" && entry.length > bytes) return false;
    bytes -= Buffer.byteLength(JSON.stringify(entry) ?? "null", "utf8");
    return bytes >= 0;
  };
  return visit(value, 0);
}

/** Keep model content and distinct typed values; server ingestion owns image byte policy. */
function piToolOutput(result: unknown, toolName: string): unknown {
  const rawContent = recordField(result, "content");
  const content = Array.isArray(rawContent)
    ? rawContent
    : typeof rawContent === "string"
      ? [{ type: "text", text: rawContent }]
      : [];
  let structured = recordField(result, "structuredContent");
  // Pi MCP tools return the full CallToolResult to scripts. The model content
  // is already captured, so store only its distinct structured payload.
  const details = recordField(result, "details");
  const isMcpResult =
    toolName.startsWith("mcp__") &&
    recordString(details, "server") !== undefined &&
    recordString(details, "tool") !== undefined &&
    Array.isArray(recordField(structured, "content"));
  if (isMcpResult) {
    structured = recordField(structured, "structuredContent");
  }
  if (typeof structured === "string" && structured === contentText(content)) {
    structured = undefined;
  }
  // Native read repeats its image and first text note as structured output.
  // Drop only that exact mirror; an extension's extra metadata stays distinct.
  if (toolName === "read" && Predicate.isObject(structured)) {
    const image = readToolOutputImage(structured);
    const note =
      recordString(
        content.find((block) => recordField(block, "type") === "text"),
        "text",
      ) ?? "";
    if (
      image !== null &&
      Object.keys(structured).every((key) => ["type", "data", "mimeType", "note"].includes(key)) &&
      recordString(structured, "note") === note &&
      content.some((block) => {
        const match = readToolOutputImage(block);
        return match !== null && match.mimeType === image.mimeType && match.data === image.data;
      })
    ) {
      structured = undefined;
    }
  }
  if (structured !== undefined && !isBoundedStructuredToolValue(structured)) {
    return {
      content: [
        ...content,
        {
          type: "text",
          text: "Structured output omitted because it exceeds the stored result limit.",
        },
      ],
    };
  }
  if (
    !isMcpResult &&
    structured === undefined &&
    content.every((block) => recordField(block, "type") === "text")
  ) {
    const text = contentText(content);
    return text.length > 0 ? text : undefined;
  }
  return {
    content,
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: DULLI_PROVIDER, nativeId, strength };
}

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// ── per-session state ─────────────────────────────────────────

interface PiStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  phase?: "commentary" | "final_answer";
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

type PiCompactionStatus = "running" | "completed" | "failed" | "cancelled";

interface PiCompactionState {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
}

interface PiProviderRetryState {
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

function compactionTitle(status: PiCompactionStatus): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
}

interface ActivePiTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  /** Increments on assistant `message_start` so content indexes stay unique. */
  messageOrdinal: number;
  segmentOrdinal: number;
  assistantContent: PiAssistantContentState;
  workBoundaryPending: boolean;
  assistantOrigin: "normal" | "async_result";
  hasPrimaryAnswer: boolean;
  claudeTraces: Map<number, { toolCallId: string; toolName: string; done: boolean }>;
  readonly toolUpdatedAt: Map<string, number>;
  readonly streamItems: Map<string, PiStreamItemState>;
  readonly toolArgs: Map<string, unknown>;
  /**
   * First-seen time per `toolCallId`. Later update/end events reuse it so a
   * tool keeps one start timestamp and reports a real duration.
   */
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  interrupted: boolean;
  /** Cancellation of the latest native run; new work can recover before settlement. */
  nativeAborted: boolean;
  /**
   * Whether any agent run activity was observed. Command-only prompts (pure
   * extension slash commands) never start an agent run and never emit
   * `agent_settled`; their deferred prompt ack plus an idle probe settles
   * the turn instead.
   */
  sawAgentActivity: boolean;
  /** A user prompt joined provider-native work whose settlement may already be queued. */
  adoptedWake: boolean;
  /** Only slash-command prompts can complete without starting an agent run. */
  readonly promptMayBeCommandOnly: boolean;
  /** Pi reports context as unknown immediately after compaction; keep its estimate for the meter. */
  latestCompactionAfterTokens: number | null;
  /** Last streamed usage total already emitted on the running turn. */
  lastLiveUsedTokens: number | null;
  /** Invalidates idle snapshots when new work starts after a settle probe. */
  settleProbeGeneration: number;
  /** An extension may start compaction immediately after Pi emits agent_settled. */
  settleWhenIdle: boolean;
  sawCompaction: boolean;
  /** RPC compact is in flight; Pi abort does not cancel it. */
  manualCompactInFlight: boolean;
  activeCompaction: PiCompactionState | null;
  activeProviderRetry: PiProviderRetryState | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
  /** Native retry can recover its work without accepting a rejected joining prompt. */
  rejectedPromptFailure: ReturnType<typeof makeProviderFailure> | null;
  /** Session-tree refs read just before Stop terminates Pi, when no read is possible later. */
  stopTreeRefs?: PiTurnTreeRefs | null;
}

interface PiTurnTreeRefs {
  /** Omitted keeps the synthetic ref; null means the turn left nothing on the active branch. */
  readonly nativeTurnRef: OrchestrationV2ProviderRef | null | undefined;
  readonly leafId: string | null;
  /** Set after a native rewind: every user entry still on the active branch. */
  readonly retainedNativeTurnIds: ReadonlyArray<string> | undefined;
}

interface PendingPiPrompt {
  readonly nativeRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly questionId: string;
  readonly approvalKey: string;
  readonly expiresAt: number | null;
  expirationFiber: Fiber.Fiber<void> | null;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

/**
 * The T3 bridge confirms tool calls as `Allow <tool>?`. Edits surface as
 * file-change approvals so clients render them like other providers' edits;
 * every other confirmation, including ones from user extensions, is a command.
 */
function piApprovalRequestKind(title: string): "command" | "file-change" {
  const toolName = /^Allow (\S+)\?$/.exec(title)?.[1];
  return toolName !== undefined &&
    (PI_FILE_CHANGE_TOOLS as ReadonlyArray<string>).includes(toolName)
    ? "file-change"
    : "command";
}

interface PiThreadState {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActivePiTurn | null;
}

interface PiWake {
  readonly state: PiThreadState;
  readonly events: Array<PiRpcRecord>;
}

// ── adapter ───────────────────────────────────────────────────

export const makeDulliAdapterV2 = Effect.fn("makeDulliAdapterV2")(function* (
  options: DulliAdapterV2Options,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const fileSystem = yield* FileSystem.FileSystem;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const paths = yield* Path.Path;
  const bridgeFactories = yield* DulliBridgeRegistry;
  const sharedEnvironment = yield* DulliSharedEnvironment;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const { continuationRequests } = options;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: DULLI_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: DULLI_PROVIDER,
    getCapabilities: Effect.fn("DulliAdapterV2.getCapabilities")(function () {
      return Effect.succeed(
        options.settings.piSessions && options.settings.shareWithTerminal
          ? PiSharedProviderCapabilitiesV2
          : PiProviderCapabilitiesV2,
      );
    }),
    planSelectionTransition: Effect.fn("DulliAdapterV2.planSelectionTransition")(function ({
      current,
      target,
    }) {
      return Effect.succeed(
        ["profile", "configSet"].some(
          (key) =>
            getModelSelectionStringOptionValue(current, key) !==
            getModelSelectionStringOptionValue(target, key),
        )
          ? { type: "restart_session" as const }
          : turnScopedSelectionTransition(),
      );
    }),
    openSession: Effect.fn("DulliAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const mcpSession = yield* mcpSessions.read(input.threadId);
      const provideCacheFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: DULLI_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      // The extension owns both the optional MCP bridge and Pi's permission
      // hook. Materialize it even when this session has no MCP credential so
      // Supervised never silently degrades to unrestricted tool execution.
      const extensionPath = yield* provideCacheFs(
        materializePiT3McpExtension(host.paths.providerStatusCacheDir),
      );
      const profile =
        getModelSelectionStringOptionValue(input.modelSelection, "profile")?.trim() ||
        options.settings.profile ||
        "coder";
      const configSet = yield* resolvePiSessionConfigSet(
        { agentDir: options.settings.agentDir, environment: options.environment },
        getModelSelectionStringOptionValue(input.modelSelection, "configSet"),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, paths),
        Effect.mapError((cause) => protocolError(cause.message)),
      );
      const nativeEnvironment = buildPiRpcEnv(
        paths,
        options.settings,
        options.environment,
        configSet,
      );
      const agentDir = nativeEnvironment.PI_CODING_AGENT_DIR!;
      if (
        getModelSelectionStringOptionValue(input.modelSelection, "profile") &&
        (yield* fileSystem
          .exists(paths.join(agentDir, "profiles.json"))
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        const profiles = yield* discoverPiProfileChoices({
          agentDir,
          configuredProfile: options.settings.profile,
          environment: nativeEnvironment,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, paths),
        );
        if (!profiles.some((entry) => entry.id === profile))
          return yield* protocolError(
            `Pi profile "${profile}" is not available in this home. Choose a profile defined there.`,
          );
      }
      const resolvedLaunchArgs = { args: buildPiRpcArgs(options.settings, { profile }).slice(2) };
      const launch = buildPiRpcLaunch({
        launchArgs: resolvedLaunchArgs.args,
        environment: {
          ...nativeEnvironment,
          CLAUDE_AGENT_SDK_RPC_BRIDGE: "1",
          PI_HTML_SHOW_RPC_BRIDGE: "1",
          ...(options.settings.piSessions
            ? {
                PI_SESSIONS_T3_THREAD: input.threadId,
                ...(sharedEnvironment ? { PI_SESSIONS_T3_ENVIRONMENT: sharedEnvironment } : {}),
              }
            : { PI_SESSIONS: "off" }),
        },
        mcpSession,
        extensionPath,
        // Dulli follows the fork's full-local-access policy; the MCP bridge
        // still supplies T3 tools and orchestration guidance.
        runtimeMode: "full-access",
      });
      const sessionsExtension = options.settings.piSessions
        ? findPiSessionsExtension(piSessionsHome(launch.env, paths), paths)
        : undefined;
      const scopedLaunch = yield* agentScope.wrap({
        command: options.settings.binaryPath || "pi",
        args: sessionsExtension ? [...launch.args, "-e", sessionsExtension] : launch.args,
        name: "dulli",
        threadId: input.threadId,
        env: launch.env,
      });
      const spawnOptions = {
        command: scopedLaunch.command,
        args: scopedLaunch.args,
        cwd,
        env: launch.env,
      };
      const daemonKey = piDaemonSkipKey(
        { ...spawnOptions, command: options.settings.binaryPath || "pi" },
        paths,
      );
      const owned = makePiRpcConnection(spawnOptions).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.map((connection) => ({ connection, shared: false, started: true })),
      );
      if (input.attachOnly && !(options.settings.piSessions && options.settings.shareWithTerminal))
        return yield* protocolError("Shared sessions are disabled");
      const daemonScope = yield* Scope.make();
      yield* Scope.addFinalizer(scope, Scope.close(daemonScope, Exit.void));
      let opened = yield* (
        options.settings.piSessions &&
        options.settings.shareWithTerminal &&
        (input.attachOnly || !(yield* isPiDaemonSkipped(daemonKey)))
          ? makePiDaemonConnection(
              { ...spawnOptions, threadId: input.threadId },
              {
                ...(input.attachOnly ? { attach: true } : {}),
                ...(input.initialNativeThreadId
                  ? { sessionFile: input.initialNativeThreadId }
                  : {}),
              },
            ).pipe(
              Effect.provideService(Path.Path, paths),
              Effect.provideService(Scope.Scope, daemonScope),
              Effect.map((result) => ({ ...result, shared: true })),
              Effect.catch((cause) => {
                // A second writer is never a fallback. A binary without the extension
                // is retried only after ten minutes, scoped to its home and executable.
                return Scope.close(daemonScope, Exit.void).pipe(
                  Effect.andThen(
                    input.attachOnly || cause.detail?.includes("open elsewhere")
                      ? Effect.fail(cause)
                      : (cause.detail?.includes("did not start in time")
                          ? skipPiDaemon(daemonKey)
                          : Effect.void
                        ).pipe(Effect.andThen(owned)),
                  ),
                );
              }),
            )
          : owned
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: DULLI_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      // Keep one adapter event stream across daemon detach/rpc-open. A shared
      // host owns one native file; it cannot switch_session or new_session.
      const rpcEvents = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
      let binding = 0;
      let sharedNeedsOpen = false;
      const forwardConnection = Effect.fn("DulliAdapter.forwardConnection")(
        function* (source: PiRpcConnection, generation: number) {
          while (true) {
            const event = yield* Queue.take(source.events);
            if (generation === binding)
              yield* Queue.offer(rpcEvents, { ...event, t3BindingGeneration: generation });
          }
        },
        (effect, _source, generation) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              generation === binding ? Queue.failCause(rpcEvents, cause) : Effect.void,
            ),
            Effect.forkIn(scope),
          ),
      );
      if (opened.shared) yield* forwardConnection(opened.connection, binding);
      const sharedCommand = (record: PiRpcRecord) =>
        !opened.shared || PI_SHARED_COMMANDS.has(String(record.type))
          ? Effect.void
          : Effect.fail(
              new PiRpcError({
                operation: String(record.type),
                detail: `Unknown command: ${String(record.type)} (not available in a chat shared with the terminal)`,
              }),
            );
      const connection: PiRpcConnection = !opened.shared
        ? opened.connection
        : {
            events: rpcEvents,
            exited: Effect.suspend(() => opened.connection.exited),
            request: (record, timeoutMs) =>
              sharedCommand(record).pipe(
                Effect.andThen(Effect.suspend(() => opened.connection.request(record, timeoutMs))),
              ),
            send: (record) =>
              sharedCommand(record).pipe(
                Effect.andThen(Effect.suspend(() => opened.connection.send(record))),
              ),
            terminate: Effect.suspend(() => opened.connection.terminate),
          };
      const startupEvents: PiRpcRecord[] = [];
      let externalUserOrdinal = 0;
      let sharedReady = !opened.shared;
      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: DULLI_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: opened.shared ? PiSharedProviderCapabilitiesV2 : PiProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const pendingPrompts = new Map<string, PendingPiPrompt>();
      const sessionApprovals = new Set<string>();
      // Answering a dialog and terminalizing a turn both publish lifecycle
      // events. Pi can settle immediately after `extension_ui_response`, so
      // serialize the two paths to stop `turn.terminal` from overtaking the
      // dialog's own resolution updates.
      const sessionEventPermit = yield* Semaphore.make(1);
      let threadState: PiThreadState | null = null;
      let registrationAttempted = false;
      let lastNativeThreadId: string | null = null;
      // User Stop intentionally tears down this RPC process after aborting.
      // Keep that intent beyond turn finalization so the later stdout close is
      // not mistaken for an unexpected transport failure.
      let stopRequested = false;
      // Native work is held until an orchestrator-owned continuation or user
      // turn attaches. The guard remains for sessions with no routable owner.
      let unsolicitedActivityDetected = false;
      let pendingWake: PiWake | null = null;
      let rollbackBarrier: Deferred.Deferred<
        void,
        ProviderAdapter.ProviderAdapterProtocolError
      > | null = null;
      let closed = false;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          pendingWake = null;
          if (rollbackBarrier !== null)
            yield* Deferred.fail(
              rollbackBarrier,
              protocolError("Pi session closed during rollback"),
            );
        }),
      );
      let appliedModel: string | null = null;
      let appliedThinking: string | null = null;
      let appliedContext: string | null = null;
      let appliedFast: string | null = null;
      /** Last thread title synced into pi's session name (`/resume` listing). */
      let appliedSessionName: string | null = null;
      /** Extension failures raised during startup are attached to the next turn. */
      const outOfTurnExtensionErrors: Array<PiRpcRecord> = [];
      /**
       * Leaf entry id of the pi session tree as of the last turn boundary.
       * Turn-start user entries are located relative to it, giving each
       * provider turn a durable native ref for session-tree rollback.
       */
      let lastKnownLeaf: string | null = null;
      /**
       * Set when a `get_entries` capture failed. Pi may have advanced past
       * `lastKnownLeaf` since, so the cursor no longer bounds a single turn
       * and the next capture re-syncs it instead of trusting it.
       */
      let leafCursorStale = false;
      // Pi's own configured defaults, captured from the first `get_state` so
      // that selecting the displayed "Pi default" again can restore them. Pi
      // has no "unset" commands, so the baselines have to be replayed
      // explicitly.
      let baselineModel: { provider: string; modelId: string } | null = null;
      let baselineThinking: string | null = null;
      /** Context window of the model Pi currently runs, from get_state and set_model. */
      let contextWindow: number | null = null;
      const modelContextWindows = new Map<string, number>();
      let modelsDiscovered = false;
      // Prompt responses carry no id. Keep their session-wide send order and
      // owner so a late ack from a settled turn cannot affect the next turn.
      const pendingPromptResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];
      const pendingCompactResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];

      const compactRpcRecord = (command: PiCompactCommand): PiRpcRecord =>
        command.customInstructions === undefined
          ? { type: "compact" }
          : { type: "compact", customInstructions: command.customInstructions };

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const bridges = yield* Effect.forEach(bridgeFactories, (factory) =>
        factory({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
          instanceId: options.instanceId,
          settings: options.settings,
          environment: launch.env,
          cwd,
          modelSelection: input.modelSelection,
          rpc: connection,
          emit,
          ids: idAllocator,
          getProviderThread: () => threadState?.providerThread ?? null,
          getItemOrdinal: (nativeItemId) =>
            threadState?.activeTurn ? itemOrdinal(threadState.activeTurn, nativeItemId) : 0,
          getActiveTurn: () =>
            threadState?.activeTurn
              ? {
                  input: threadState.activeTurn.turnInput,
                  providerTurn: threadState.activeTurn.providerTurn,
                }
              : null,
        }),
      );
      let bridgesStopped = false;
      let bridgesStarted = false;
      const stopBridges = Effect.suspend(() => {
        if (bridgesStopped) return Effect.void;
        bridgesStopped = true;
        return Effect.forEach(
          bridges,
          (bridge) => bridge.onStop?.(opened.shared ? "detached" : "stopped") ?? Effect.void,
          { discard: true },
        );
      });
      yield* Effect.addFinalizer(() => stopBridges);
      const bridgeInputs = new Set<string>();

      let noticeSequence = 0;
      // Pi RPC event handling stays untraced, including streaming updates.
      const emitNotice = Effect.fnUntraced(function* (message: string, level: string = "warning") {
        const at = yield* DateTime.now;
        const nativeItemId = `${input.providerSessionId}:notice:${noticeSequence++}`;
        const turn = threadState?.activeTurn;
        yield* emit({
          type: "turn_item.updated",
          driver: DULLI_PROVIDER,
          turnItem: {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: DULLI_PROVIDER,
              nativeItemId,
            }),
            threadId: input.threadId,
            runId: turn?.turnInput.runId ?? null,
            nodeId: turn?.turnInput.rootNodeId ?? null,
            providerThreadId: threadState?.providerThread.id ?? null,
            providerTurnId: turn?.providerTurn.id ?? null,
            nativeItemRef: providerRef(nativeItemId),
            parentItemId: null,
            ordinal: turn ? itemOrdinal(turn, nativeItemId) : 0,
            status: "completed",
            title: level,
            type: "system_notice",
            message: message.slice(0, 4_000),
            startedAt: at,
            completedAt: at,
            updatedAt: at,
          },
        });
      });

      const updateProviderSession =
        /* Pi RPC events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          status: OrchestrationV2ProviderSession["status"],
          lastError: string | null = sessionEntity.lastError,
        ) {
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: DULLI_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      const updateProviderThread =
        /* Pi RPC events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          state: PiThreadState,
          patch: Partial<OrchestrationV2ProviderThread>,
          retainedNativeTurnIds?: ReadonlyArray<string>,
        ) {
          const updatedAt = yield* DateTime.now;
          state.providerThread = { ...state.providerThread, ...patch, updatedAt };
          yield* emit({
            type: "provider_thread.updated",
            driver: DULLI_PROVIDER,
            providerThread: state.providerThread,
            ...(retainedNativeTurnIds === undefined ? {} : { retainedNativeTurnIds }),
          });
        });

      const itemOrdinal = (turn: ActivePiTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const request = (record: PiRpcRecord, timeoutMs = PI_REQUEST_TIMEOUT_MS) =>
        connection.request(record, timeoutMs);

      const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
        const value = recordNumber(input, key);
        return value === undefined ? undefined : Math.max(0, Math.trunc(value));
      };

      const rememberModelContextWindow = (model: unknown): number | null => {
        const provider = recordString(model, "provider");
        const id = recordString(model, "id");
        const capacity = nonNegativeInteger(model, "contextWindow");
        if (provider !== undefined && id !== undefined && capacity !== undefined && capacity > 0) {
          modelContextWindows.set(`${provider}/${id}`, capacity);
          return capacity;
        }
        return null;
      };

      const lifecycleRequest = (record: PiRpcRecord) =>
        request(record, PI_SESSION_TIMEOUT_MS).pipe(
          // A local timeout does not cancel Pi's lifecycle hook. Retire the
          // process before fallback can race its eventual switch/new-session.
          Effect.tapError((error) =>
            Effect.logWarning("Pi session lifecycle request failed", {
              providerSessionId: input.providerSessionId,
              operation: record["type"],
              errorTag: error._tag,
            }),
          ),
          Effect.catchTags({
            PiRpcTimeoutError: (error) =>
              connection.terminate.pipe(Effect.andThen(Effect.fail(error))),
          }),
          Effect.onInterrupt(() => connection.terminate),
        );

      const tokenUsageFromStats = (
        stats: unknown,
        fallbackUsedTokens: number | null,
        updatedAt: DateTime.Utc,
      ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
        const contextUsage = recordField(stats, "contextUsage");
        const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
        const usedTokens =
          nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
        if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
          return undefined;

        const totals = recordField(stats, "tokens");
        const inputTokens = nonNegativeInteger(totals, "input");
        const cachedInputTokens = nonNegativeInteger(totals, "cacheRead");
        const outputTokens = nonNegativeInteger(totals, "output");
        return {
          usedTokens,
          maxTokens,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          updatedAt: DateTime.formatIso(updatedAt),
        };
      };

      /**
       * Pi exposes context usage only through get_session_stats; attach it per settled turn.
       * Bound this secondary telemetry request and tolerate versions without stats,
       * leaving the meter on the last turn with a report.
       */
      const readTokenUsage = (fallbackUsedTokens: number | null, updatedAt: DateTime.Utc) =>
        opened.shared
          ? Effect.void
          : request({ type: "get_session_stats" }, 2_000).pipe(
              Effect.map((stats) => tokenUsageFromStats(stats, fallbackUsedTokens, updatedAt)),
              Effect.orElseSucceed(() => undefined),
            );

      /**
       * Pi attaches the current message's cumulative usage to every streaming
       * update (0.84.2+). Emit it on the running turn only when the total
       * changes, so the meter moves live without a burst of no-op updates.
       */
      const reportLiveUsage =
        /* Pi RPC events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActivePiTurn, usage: unknown) {
          const usedTokens = nonNegativeInteger(usage, "totalTokens");
          if (
            usedTokens === undefined ||
            usedTokens === 0 ||
            usedTokens === turn.lastLiveUsedTokens ||
            contextWindow === null ||
            contextWindow === 0
          ) {
            return;
          }
          turn.lastLiveUsedTokens = usedTokens;
          const inputTokens = nonNegativeInteger(usage, "input");
          const cachedInputTokens = nonNegativeInteger(usage, "cacheRead");
          const outputTokens = nonNegativeInteger(usage, "output");
          const updatedAt = yield* DateTime.now;
          yield* emit({
            type: "provider_turn.updated",
            driver: DULLI_PROVIDER,
            threadId: turn.turnInput.threadId,
            providerTurn: {
              ...turn.providerTurn,
              tokenUsage: {
                usedTokens,
                maxTokens: contextWindow,
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
                updatedAt: DateTime.formatIso(updatedAt),
              },
            },
          });
        });

      const baseItemFields = (
        turn: ActivePiTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: DULLI_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver: DULLI_PROVIDER,
          nativeItemId,
        }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        turn: ActivePiTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: DULLI_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({
              driver: DULLI_PROVIDER,
              nativeItemId,
            }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      // Pi RPC event handling stays untraced, including streaming updates.
      const emitProviderRetry = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        providerRetry: PiProviderRetryState,
        status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
        updatedAt: DateTime.Utc,
      ) {
        yield* emit({
          type: "turn_item.updated",
          driver: DULLI_PROVIDER,
          turnItem: makeProviderRetryTurnItem({
            driver: DULLI_PROVIDER,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: turn.turnInput.rootNodeId,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: providerRetry.itemOrdinal,
            failure: providerRetry.failure,
            retry: providerRetry.retry,
            status,
            startedAt: providerRetry.startedAt,
            updatedAt,
          }),
        });
      });

      const compactionNativeItemId = (turn: ActivePiTurn): string =>
        `compaction:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;

      // Pi RPC event handling stays untraced, including streaming updates.
      const emitCompaction = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        compaction: PiCompactionState,
        status: PiCompactionStatus,
        details: {
          readonly summary?: string;
          readonly beforeTokenCount?: number;
          readonly afterTokenCount?: number;
        } = {},
      ) {
        const emittedAt = yield* DateTime.now;
        const completedAt = status === "running" ? null : emittedAt;
        yield* emitItemNode(
          turn,
          compaction.nativeItemId,
          "system",
          status,
          compaction.startedAt,
          completedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: DULLI_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, compaction.nativeItemId, compaction.startedAt, emittedAt),
            status,
            title: compactionTitle(status),
            completedAt,
            type: "compaction",
            driver: DULLI_PROVIDER,
            ...details,
          },
        });
      });

      // ── streaming text / reasoning ────────────────────────

      const emitStreamItem =
        /* Pi RPC events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          turn: ActivePiTurn,
          item: PiStreamItemState,
          streaming: boolean,
        ) {
          const emittedAt = yield* DateTime.now;
          const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
          yield* emitItemNode(
            turn,
            item.nativeItemId,
            item.kind,
            streaming ? "running" : "completed",
            item.startedAt,
            streaming ? null : emittedAt,
          );
          if (item.kind === "assistant_message") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: DULLI_PROVIDER,
              nativeItemId: item.nativeItemId,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: DULLI_PROVIDER,
              turnItem: {
                ...base,
                status: streaming ? "running" : "completed",
                title: null,
                completedAt: streaming ? null : emittedAt,
                type: "assistant_message",
                ...(item.phase ? { phase: item.phase } : {}),
                messageId,
                text: item.text,
                streaming,
              },
            });
            yield* emit({
              type: "message.updated",
              driver: DULLI_PROVIDER,
              message: {
                id: messageId,
                threadId: turn.turnInput.threadId,
                runId: turn.turnInput.runId,
                nodeId: idAllocator.derive.nodeFromProviderItem({
                  driver: DULLI_PROVIDER,
                  nativeItemId: item.nativeItemId,
                }),
                role: "assistant",
                ...(item.phase ? { phase: item.phase } : {}),
                text: item.text,
                attachments: [],
                streaming,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: item.startedAt,
                updatedAt: emittedAt,
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver: DULLI_PROVIDER,
            turnItem: {
              ...base,
              status: streaming ? "running" : "completed",
              title: null,
              completedAt: streaming ? null : emittedAt,
              type: "reasoning",
              text: item.text,
              streaming,
            },
          });
        });

      const scheduleStreamFlush =
        /* Pi RPC events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActivePiTurn, item: PiStreamItemState) {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed ? Effect.void : emitStreamItem(turn, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      // Pi RPC event handling stays untraced, including streaming updates.
      const streamItemFor = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        kind: PiStreamItemState["kind"],
        contentIndex: number,
      ) {
        const nativeItemId = `${turn.providerTurn.id}:m${turn.messageOrdinal}:${kind}:c${contentIndex}`;
        const existing = turn.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const startedAt = yield* DateTime.now;
        const item: PiStreamItemState = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          startedAt,
        };
        turn.streamItems.set(nativeItemId, item);
        // Ordinal reserved on first delta so items appear in stream order.
        itemOrdinal(turn, nativeItemId);
        return item;
      });

      const completeStreamItem = (turn: ActivePiTurn, item: PiStreamItemState, text?: string) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
        });

      const completeOpenStreamItems = (turn: ActivePiTurn, phase?: "commentary" | "final_answer") =>
        Effect.forEach(
          Array.from(turn.streamItems.values()).filter((item) => !item.completed),
          (item) => {
            if (item.kind === "assistant_message" && phase) item.phase = phase;
            return completeStreamItem(turn, item);
          },
          { discard: true },
        );

      // Indexed blocks reconcile legacy cumulative snapshots with modern deltas.
      // Adjacent text blocks are paragraphs, not separate answers. Only a native
      // tool/work boundary splits a segment (no wording or length heuristics).
      // Pi RPC event handling stays untraced, including streaming updates.
      const appendAssistantDeltas = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        deltas: ReadonlyArray<PiAssistantContentDelta>,
      ) {
        for (const delta of deltas) {
          if (turn.workBoundaryPending || delta.workBoundaryBefore) {
            yield* completeOpenStreamItems(turn, "commentary");
            turn.segmentOrdinal += 1;
            turn.workBoundaryPending = false;
          }
          const item = yield* streamItemFor(
            turn,
            delta.streamKind === "assistant_text" ? "assistant_message" : "reasoning",
            turn.segmentOrdinal,
          );
          const text =
            !item.text && delta.blockBoundary
              ? delta.delta.slice(delta.blockBoundary.length)
              : delta.delta;
          item.text += text;
          if (item.kind === "reasoning" && item.text.length > 48_000)
            item.text = `…[earlier thinking omitted]\n${item.text.slice(-47_970)}`;
          yield* scheduleStreamFlush(turn, item);
        }
      });

      // Thread streams encode tool input as JSON, which rejects undefined fields.
      const claudeTraceArgs = (trace: NonNullable<ReturnType<typeof parseClaudeCodeToolTrace>>) =>
        trace.toolName === "Bash"
          ? { command: trace.detail ?? "" }
          : trace.detail === undefined
            ? {}
            : { detail: trace.detail };

      // Pi RPC event handling stays untraced, including streaming updates.
      const emitClaudeTrace = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        contentIndex: number,
        trace: NonNullable<ReturnType<typeof parseClaudeCodeToolTrace>>,
      ) {
        let current = turn.claudeTraces.get(contentIndex);
        if (current === undefined) {
          current = {
            toolCallId: `${turn.providerTurn.id}:m${turn.messageOrdinal}:claude-tool:${contentIndex}`,
            toolName: trace.toolName,
            done: false,
          };
          turn.claudeTraces.set(contentIndex, current);
          yield* emitToolItem(turn, { ...current, args: claudeTraceArgs(trace) }, "start");
        }
        if (trace.done && !current.done) {
          current.done = true;
          // The start trace usually comes before Claude has streamed the input.
          yield* emitToolItem(
            turn,
            {
              ...current,
              args: claudeTraceArgs(trace),
              result: { content: [{ type: "text", text: trace.detail ?? "" }] },
            },
            "end",
          );
        }
      });

      // Pi RPC event handling stays untraced, including streaming updates.
      const reconcileAssistantSnapshot = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        message: unknown,
      ) {
        if (recordString(message, "role") !== "assistant") return;
        const content = extractPiAssistantContent(message);
        const reconciled = applyPiAssistantSnapshot(turn.assistantContent, {
          assistant_text: content.text,
          reasoning_text: content.thinking,
          blocks: content.blocks,
        });
        turn.assistantContent = reconciled.state;
        let traceIndex = 0;
        for (const delta of reconciled.deltas) {
          while (
            traceIndex < content.toolTraces.length &&
            (delta.contentIndex ?? Infinity) > content.toolTraces[traceIndex]!.contentIndex
          ) {
            const trace = content.toolTraces[traceIndex++]!;
            yield* emitClaudeTrace(turn, trace.contentIndex, trace);
          }
          yield* appendAssistantDeltas(turn, [delta]);
        }
        for (const trace of content.toolTraces.slice(traceIndex))
          yield* emitClaudeTrace(turn, trace.contentIndex, trace);
      });

      // ── tools ─────────────────────────────────────────────

      // Pi RPC event handling stays untraced, including streaming updates.
      const emitToolItem = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        event: PiRpcRecord,
        phase: "start" | "update" | "end",
      ) {
        const toolCallId = recordString(event, "toolCallId");
        const toolName = recordString(event, "toolName") ?? "tool";
        if (toolCallId === undefined) return;
        if (phase === "start") turn.workBoundaryPending = true;
        if (event["args"] !== undefined) turn.toolArgs.set(toolCallId, event["args"]);
        if (phase === "update") {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const previous = turn.toolUpdatedAt.get(toolCallId);
          if (previous !== undefined && now - previous < 1_000) return;
          turn.toolUpdatedAt.set(toolCallId, now);
        }
        const args = event["args"] ?? turn.toolArgs.get(toolCallId);
        const emittedAt = yield* DateTime.now;
        const startedAt = turn.toolStartedAt.get(toolCallId) ?? emittedAt;
        turn.toolStartedAt.set(toolCallId, startedAt);
        const completed = phase === "end";
        const isError = event["isError"] === true;
        const rawResult = completed ? event["result"] : event["partialResult"];
        const partialText = contentText(recordField(rawResult, "content"));
        const resultRecord =
          phase !== "update"
            ? rawResult
            : {
                content: [
                  {
                    type: "text",
                    text:
                      partialText.length <= 4_000
                        ? partialText
                        : `…[truncated]\n${partialText.slice(-3_986)}`,
                  },
                ],
              };
        if (completed) {
          turn.toolArgs.delete(toolCallId);
          turn.toolUpdatedAt.delete(toolCallId);
        }
        const outputText = contentText(recordField(resultRecord, "content"));
        // A Stop aborts in-flight tools, and pi reports those as error ends.
        // Present them as interrupted (matching the run) rather than failed.
        const status = completed
          ? isError
            ? turn.interrupted
              ? "interrupted"
              : "failed"
            : "completed"
          : "running";
        const base = baseItemFields(turn, toolCallId, startedAt, emittedAt);
        yield* emitItemNode(
          turn,
          toolCallId,
          "tool_call",
          status,
          startedAt,
          completed ? emittedAt : null,
        );
        const shared = {
          ...base,
          status,
          completedAt: completed ? emittedAt : null,
        } as const;
        if (toolName === "bash" || toolName === "Bash" || toolName === "powershell") {
          const exitCode =
            recordNumber(recordField(resultRecord, "structuredContent"), "exit_code") ??
            recordNumber(recordField(resultRecord, "details"), "exitCode");
          yield* emit({
            type: "turn_item.updated",
            driver: DULLI_PROVIDER,
            turnItem: {
              ...shared,
              title: toolName,
              type: "command_execution",
              input: recordString(args, "command") ?? "",
              ...(outputText.length > 0 ? { output: outputText } : {}),
              ...(exitCode === undefined ? {} : { exitCode }),
            },
          });
          return;
        }
        if (toolName === "edit" || toolName === "write") {
          const fileName = recordString(args, "path") ?? recordString(args, "file_path");
          if (fileName !== undefined) {
            // edit reports a unified patch in its result details; write only
            // carries the new content in its args. A failed call keeps its error.
            const diffStr =
              recordString(recordField(resultRecord, "details"), "patch") ??
              (isError && outputText.trim().length > 0 ? outputText : undefined);
            const newStr = toolName === "write" ? recordString(args, "content") : undefined;
            yield* emit({
              type: "turn_item.updated",
              driver: DULLI_PROVIDER,
              turnItem: {
                ...shared,
                title: toolName,
                type: "file_change",
                fileName,
                ...(diffStr === undefined ? {} : { diffStr }),
                ...(newStr === undefined ? {} : { newStr }),
              },
            });
            return;
          }
        }
        const output = piToolOutput(resultRecord, toolName);
        yield* emit({
          type: "turn_item.updated",
          driver: DULLI_PROVIDER,
          turnItem: {
            ...shared,
            title: toolName === "html_show" ? (recordString(args, "title") ?? toolName) : toolName,
            type: "dynamic_tool",
            ...mcpToolPresentation({ toolName }),
            toolName,
            input: args ?? {},
            ...(output === undefined ? {} : { output }),
          },
        });
        if (toolName === "subagent") {
          yield* emitSubagentTasks(turn, toolCallId, rawResult, completed);
        }
      });

      /**
       * Observe the result shape from Pi's official example subagent extension.
       * The extension runs children with --no-session, so these entries are
       * visible in T3's shared subagent UI without inventing a child thread.
       * Unknown or changed result shapes stay ordinary dynamic tool output.
       */
      // Pi RPC event handling stays untraced, including streaming updates.
      const emitSubagentTasks = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        toolCallId: string,
        resultRecord: unknown,
        completed: boolean,
      ) {
        const results = recordField(recordField(resultRecord, "details"), "results");
        if (!Array.isArray(results)) return;
        const emittedAt = yield* DateTime.now;
        const parentNodeId = idAllocator.derive.nodeFromProviderItem({
          driver: DULLI_PROVIDER,
          nativeItemId: toolCallId,
        });
        for (const [index, result] of results.entries()) {
          const agent = recordString(result, "agent");
          const task = recordString(result, "task");
          if (agent === undefined || task === undefined) continue;
          const nativeTaskId = `${toolCallId}:subagent:${recordNumber(result, "step") ?? index}`;
          const subagentId = idAllocator.derive.nodeFromProviderItem({
            driver: DULLI_PROVIDER,
            nativeItemId: nativeTaskId,
          });
          const startedAt = turn.toolStartedAt.get(nativeTaskId) ?? emittedAt;
          turn.toolStartedAt.set(nativeTaskId, startedAt);
          const finished = completed || recordField(result, "finished") === true;
          const stopReason = recordString(result, "stopReason");
          const interrupted = finished && stopReason === "aborted";
          const failed =
            finished &&
            !interrupted &&
            ((recordNumber(result, "exitCode") ?? 0) !== 0 || stopReason === "error");
          const status = interrupted
            ? "interrupted"
            : failed
              ? "failed"
              : finished
                ? "completed"
                : "running";
          const outputText = piSubagentOutput(result);
          const progress =
            !finished && outputText.length > 0 ? { progress: outputText.slice(0, 200) } : {};
          const resultText = finished && outputText.length > 0 ? outputText.slice(0, 10_000) : null;
          yield* emit({
            type: "subagent.updated",
            driver: DULLI_PROVIDER,
            subagent: {
              id: subagentId,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              parentNodeId,
              origin: "provider_native",
              createdBy: "agent",
              driver: DULLI_PROVIDER,
              providerInstanceId: options.instanceId,
              providerThreadId: turn.turnInput.providerThread.id,
              childThreadId: null,
              nativeTaskRef: providerRef(nativeTaskId),
              prompt: task,
              title: agent,
              model: recordString(result, "model") ?? null,
              status,
              ...progress,
              result: resultText,
              startedAt,
              completedAt: finished ? emittedAt : null,
              updatedAt: emittedAt,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: DULLI_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, nativeTaskId, startedAt, emittedAt),
              status,
              title: agent,
              completedAt: finished ? emittedAt : null,
              type: "subagent",
              subagentId,
              origin: "provider_native",
              driver: DULLI_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: null,
              prompt: task,
              ...progress,
              result: resultText,
            },
          });
        }
      });

      // ── extension UI prompts ──────────────────────────────

      /** Closes a card without telling Pi, which already closed the dialog. */
      const closePrompt = Effect.fn("DulliAdapter.closePrompt")(function* (
        pending: PendingPiPrompt,
        resolvedAt: DateTime.Utc,
        status: "resolved" | "cancelled",
      ) {
        if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
        const itemStatus = status === "resolved" ? "completed" : "cancelled";
        pending.runtimeRequest = { ...pending.runtimeRequest, status, resolvedAt };
        yield* emit({
          type: "runtime_request.updated",
          driver: DULLI_PROVIDER,
          threadId: pending.node.threadId,
          runtimeRequest: pending.runtimeRequest,
        });
        yield* emit({
          type: "node.updated",
          driver: DULLI_PROVIDER,
          node: { ...pending.node, status: itemStatus, completedAt: resolvedAt },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: DULLI_PROVIDER,
          turnItem: {
            ...pending.turnItem,
            status: itemStatus,
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
          },
        });
      });

      const cancelPrompt = Effect.fn("DulliAdapter.cancelPrompt")(function* (
        pending: PendingPiPrompt,
        resolvedAt: DateTime.Utc,
      ) {
        yield* connection
          .send({
            type: "extension_ui_response",
            id: pending.nativeRequestId,
            cancelled: true,
          })
          .pipe(Effect.ignore);
        yield* closePrompt(pending, resolvedAt, "cancelled");
      });

      const cancelPendingPrompts = Effect.fn("DulliAdapter.cancelPendingPrompts")(function* (
        resolvedAt: DateTime.Utc,
      ) {
        const pending = Array.from(pendingPrompts.values());
        pendingPrompts.clear();
        yield* Effect.forEach(pending, (prompt) => cancelPrompt(prompt, resolvedAt), {
          discard: true,
        });
      });

      yield* Effect.addFinalizer(() => DateTime.now.pipe(Effect.flatMap(cancelPendingPrompts)));

      // Pi RPC event handling stays untraced, including streaming updates.
      const handleExtensionUiRequest = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const method = recordString(event, "method");
        const nativeRequestId = recordString(event, "id");
        if (method === undefined) return;
        if (
          method === "notify" &&
          recordString(event, "message")?.startsWith("claude-agent-sdk:tool-lifecycle:v1:")
        ) {
          const message = recordString(event, "message")!;
          const decoded = decodeClaudeBridgePayload(
            message.slice("claude-agent-sdk:tool-lifecycle:v1:".length),
          );
          if (Option.isNone(decoded)) return;
          const data = decoded.value;
          const turn = threadState?.activeTurn;
          if (
            turn &&
            recordField(data, "contractVersion") === 1 &&
            recordString(data, "provider") === "claude-agent-sdk" &&
            (recordString(data, "phase") === "start" || recordString(data, "phase") === "end") &&
            typeof recordField(data, "toolCallId") === "string" &&
            typeof recordField(data, "toolName") === "string"
          ) {
            yield* emitToolItem(
              turn,
              data as PiRpcRecord,
              recordString(data, "phase") === "start" ? "start" : "end",
            );
          }
          return;
        }
        if (method === "notify") {
          const message = recordString(event, "message") ?? "";
          for (const bridge of bridges)
            for (const handler of bridge.notify ?? []) {
              if (message.startsWith(handler.prefix)) {
                yield* handler.handle(message.slice(handler.prefix.length), event);
                return;
              }
            }
        }
        if (method === "input" && nativeRequestId !== undefined) {
          const title = recordString(event, "title") ?? "";
          for (const bridge of bridges)
            for (const handler of bridge.input ?? []) {
              if (!title.startsWith(handler.titlePrefix)) continue;
              if (bridgeInputs.size >= 32) {
                yield* connection.send({
                  type: "extension_ui_response",
                  id: nativeRequestId,
                  cancelled: true,
                });
                return;
              }
              bridgeInputs.add(nativeRequestId);
              const timeout = recordNumber(event, "timeout");
              yield* handler.handle(title.slice(handler.titlePrefix.length), event).pipe(
                Effect.timeoutOption(timeout && timeout > 0 ? Math.min(timeout, 25_000) : 25_000),
                Effect.map(Option.getOrElse(() => ({ cancelled: true }))),
                Effect.flatMap((response) =>
                  connection.send({
                    ...response,
                    type: "extension_ui_response",
                    id: nativeRequestId,
                  }),
                ),
                Effect.ensuring(Effect.sync(() => bridgeInputs.delete(nativeRequestId))),
                Effect.ignoreCause({ log: true }),
                Effect.forkIn(scope),
              );
              return;
            }
        }
        if (method === "notify") {
          const message = recordString(event, "message") ?? "";
          if (message) yield* emitNotice(message, recordString(event, "notifyType") ?? "info");
          return;
        }
        if (
          method !== "select" &&
          method !== "confirm" &&
          method !== "input" &&
          method !== "editor"
        ) {
          // Terminal decoration has no matching T3 surface.
          yield* Effect.logDebug("Ignoring pi extension UI update.", { method });
          return;
        }
        if (nativeRequestId === undefined) return;
        if (pendingPrompts.size >= 32) {
          yield* connection.send({
            type: "extension_ui_response",
            id: nativeRequestId,
            cancelled: true,
          });
          return;
        }
        const approvalTitle = recordString(event, "title") ?? "";
        const approvalKey = `${approvalTitle.length}:${approvalTitle}${recordString(event, "message") ?? ""}`;
        if (method === "confirm" && sessionApprovals.has(approvalKey)) {
          yield* connection.send({
            type: "extension_ui_response",
            id: nativeRequestId,
            confirmed: true,
          });
          return;
        }
        const state = threadState;
        const createdAt = yield* DateTime.now;
        const timeout = recordNumber(event, "timeout");
        // Pi treats zero as no timeout and negative durations as immediate expiry.
        const expiresAt =
          timeout === undefined || timeout === 0
            ? null
            : DateTime.toEpochMillis(createdAt) + Math.max(0, timeout);
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: DULLI_PROVIDER,
          nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const title = recordString(event, "title") ?? method;
        const threadId = state?.providerThread.appThreadId ?? input.threadId;
        const providerThreadId = state?.providerThread.id ?? null;
        const providerTurnId = null;
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          humanOnly: true,
          nodeId,
          providerTurnId,
          nativeRequestRef: providerRef(nativeRequestId),
          kind: method === "confirm" ? "command" : "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: method === "confirm" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: null,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          parentItemId: null,
          // Runless startup/session-switch requests are normalized into the
          // thread-level ordinal range by TurnItemPositionStore.
          ordinal: 0,
          status: "waiting" as const,
          title,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const turnItem: OrchestrationV2TurnItem =
          method === "confirm"
            ? {
                ...itemBase,
                type: "approval_request",
                requestId,
                requestKind: piApprovalRequestKind(title),
                prompt: recordString(event, "message") ?? title,
              }
            : {
                ...itemBase,
                type: "user_input_request",
                requestId,
                questions: [piQuestion(nativeRequestId, method, title, event)],
              };
        const pending: PendingPiPrompt = {
          nativeRequestId,
          method,
          questionId: nativeRequestId,
          approvalKey,
          expiresAt,
          expirationFiber: null,
          runtimeRequest,
          node,
          turnItem,
        };
        pendingPrompts.set(String(requestId), pending);
        yield* emit({
          type: "runtime_request.updated",
          driver: DULLI_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: DULLI_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: DULLI_PROVIDER, turnItem });
        if (expiresAt !== null) {
          const now = yield* DateTime.now;
          pending.expirationFiber = yield* Effect.sleep(
            Duration.millis(Math.max(0, expiresAt - DateTime.toEpochMillis(now))),
          ).pipe(
            Effect.andThen(
              Queue.offer(connection.events, {
                type: "t3.ui_request_expired",
                requestId: String(requestId),
                pending,
              }),
            ),
            Effect.asVoid,
            Effect.forkIn(scope),
          );
        }
      });

      // Pi RPC event handling stays untraced, including streaming updates.
      const emitExtensionError = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (turn === null) {
          outOfTurnExtensionErrors.push(event);
          return;
        }
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `extension-error:${turn.nextItemOrdinal}`;
        const extensionName = piExtensionDisplayName(recordString(event, "extensionPath"));
        const extensionEvent = recordString(event, "event");
        const detail = recordString(event, "error")?.trim();
        const message = [
          `${extensionName} failed${extensionEvent === undefined ? "" : ` during ${extensionEvent}`}.`,
          detail === undefined || detail.length === 0 ? undefined : detail.slice(0, 2_000),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n");
        const failure = makeProviderFailure({
          message,
          class: "provider_error",
          retryable: false,
        });
        yield* emitItemNode(turn, nativeItemId, "system", "failed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: DULLI_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "failed",
            title: extensionName,
            completedAt: emittedAt,
            type: "error",
            failure,
          },
        });
      });

      // ── turn lifecycle ────────────────────────────────────

      /** One `get_entries` listing, or null when the request failed or named no leaf. */
      const listSessionEntries = (since: string | null, timeoutMs: number) =>
        opened.shared
          ? Effect.succeed(null)
          : request({ type: "get_entries", ...(since === null ? {} : { since }) }, timeoutMs).pipe(
              Effect.map((data) => {
                const leafId = recordField(data, "leafId");
                const entries = piSessionEntries(recordField(data, "entries"));
                return entries !== null && (typeof leafId === "string" || leafId === null)
                  ? { entries, leafId }
                  : null;
              }),
              Effect.orElseSucceed(() => null),
            );

      /**
       * Walk the leaf’s parentId chain, not append order: get_entries retains abandoned branches.
       * The first user entry anchors fork rollback; the leaf anchors the conversation head.
       * A rewind outside T3 returns surviving user entries so orchestration can drop lost runs.
       * Listing failures degrade to synthetic refs.
       */
      const captureTurnTreeRefs = Effect.fn("DulliAdapter.captureTurnTreeRefs")(function* (
        timeoutMs = PI_REQUEST_TIMEOUT_MS,
      ): Effect.fn.Return<PiTurnTreeRefs | null> {
        const cursorWasStale = leafCursorStale;
        const previousLeaf = lastKnownLeaf;
        const fullListing = cursorWasStale || previousLeaf === null;
        const listing = yield* listSessionEntries(fullListing ? null : previousLeaf, timeoutMs);
        const turnWalk =
          listing === null ? null : walkPiBranch(listing.entries, listing.leafId, previousLeaf);
        const rewound = turnWalk !== null && previousLeaf !== null && !turnWalk.reachedStop;
        // A `since` window ends at the previous leaf; the rewound branch
        // continues past it, so its ancestry needs the whole tree.
        const tree = rewound && !fullListing ? yield* listSessionEntries(null, timeoutMs) : listing;
        if (listing === null || turnWalk === null || tree === null) {
          // The read failed or its ancestry loops. Pi may have advanced past
          // `lastKnownLeaf` meanwhile, so the cursor can no longer be trusted
          // to bound a single turn.
          leafCursorStale = true;
          return null;
        }
        lastKnownLeaf = listing.leafId;
        leafCursorStale = false;
        const turnStartEntryId = turnWalk.userEntryIds.at(-1);
        // Only a branch walked to its root lists every survivor; a partial or
        // cyclic walk would roll back runs that are still in the conversation.
        // A replaced session has a different tree. Only an old leaf still in
        // this tree proves an in-session rewind rather than a session switch.
        const branch =
          rewound && previousLeaf !== null && tree.entries.has(previousLeaf)
            ? walkPiBranch(tree.entries, listing.leafId, null)
            : undefined;
        return {
          // Without a trustworthy cursor, keep the synthetic ref rather than anchoring
          // rollback to an earlier turn; the next turn recovers accuracy. A command or
          // rewind leaving nothing on the active branch needs no fork ref.
          nativeTurnRef: cursorWasStale
            ? undefined
            : turnStartEntryId !== undefined
              ? providerRef(turnStartEntryId)
              : turnWalk.entryCount === 0
                ? null
                : undefined,
          leafId: listing.leafId,
          retainedNativeTurnIds: branch?.reachedStop === true ? branch.userEntryIds : undefined,
        };
      });

      const finalizeTurn = Effect.fn("DulliAdapter.finalizeTurn")(function* (
        state: PiThreadState,
        readUsage = true,
      ) {
        const turn = state.activeTurn;
        if (turn === null) return;
        state.activeTurn = null;
        const interrupted = turn.interrupted || turn.nativeAborted;
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        if (turn.activeCompaction !== null) {
          const status = interrupted ? "cancelled" : turn.failure === null ? "completed" : "failed";
          yield* emitCompaction(turn, turn.activeCompaction, status);
          turn.activeCompaction = null;
        }
        if (turn.activeProviderRetry !== null) {
          if (interrupted) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "interrupted", completedAt);
            turn.activeProviderRetry = null;
          } else if (turn.failure === null) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", completedAt);
            turn.activeProviderRetry = null;
          }
        }

        const treeRefs =
          turn.stopTreeRefs !== undefined ? turn.stopTreeRefs : yield* captureTurnTreeRefs();
        const tokenUsage = readUsage
          ? yield* readTokenUsage(turn.latestCompactionAfterTokens, completedAt)
          : undefined;
        const failure = interrupted ? null : (turn.rejectedPromptFailure ?? turn.failure);
        yield* emit({
          type: "provider_turn.updated",
          driver: DULLI_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            ...(treeRefs === null || treeRefs.nativeTurnRef === undefined
              ? {}
              : { nativeTurnRef: treeRefs.nativeTurnRef }),
            status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
          },
        });
        yield* updateProviderThread(
          state,
          {
            status: "idle",
            ...(treeRefs === null
              ? {}
              : {
                  nativeConversationHeadRef:
                    treeRefs.leafId === null ? null : providerRef(treeRefs.leafId),
                }),
          },
          treeRefs?.retainedNativeTurnIds,
        );
        yield* updateProviderSession(
          failure !== null ? "error" : "ready",
          failure?.message ?? null,
        );
        if (failure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          if (turn.activeProviderRetry !== null) {
            yield* emitProviderRetry(
              turn,
              { ...turn.activeProviderRetry, failure },
              "failed",
              completedAt,
            );
          } else {
            yield* emit({
              type: "turn_item.updated",
              driver: DULLI_PROVIDER,
              turnItem: {
                ...baseItemFields(turn, failureItemId, completedAt, completedAt),
                status: "failed",
                title: null,
                completedAt,
                type: "error",
                failure,
              },
            });
          }
          yield* emit({
            type: "turn.terminal",
            driver: DULLI_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure,
            ...(turn.activeProviderRetry === null
              ? {}
              : {
                  retry: turn.activeProviderRetry.retry,
                  retryStartedAt: turn.activeProviderRetry.startedAt,
                }),
            threadDisposition: "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: DULLI_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            status: interrupted ? "interrupted" : "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        }
      });

      // ── event pump ────────────────────────────────────────

      const scheduleSettleProbe = (
        turn: ActivePiTurn,
        settleAfterAgentActivity = false,
        attempt = 1,
      ) => {
        const providerTurnId = turn.providerTurn.id;
        const settleProbeGeneration = turn.settleProbeGeneration;
        return request({ type: "get_state" }, 2_000).pipe(
          Effect.matchEffect({
            onSuccess: (data) =>
              Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                data,
              }),
            // A failed probe still has to reach the pump. Dropping it would
            // leave a command-only turn active forever, because Pi never emits
            // agent events for one.
            onFailure: () =>
              Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                probeFailed: true,
              }),
          }),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      };

      const stopPendingWake = Effect.fn("DulliAdapter.stopPendingWake")(function* (wake: PiWake) {
        if (pendingWake !== wake || threadState !== wake.state || closed) return;
        pendingWake = null;
        stopRequested = true;
        yield* cancelPendingPrompts(yield* DateTime.now);
        yield* connection.terminate;
      });

      // Pi RPC event handling stays untraced, including streaming updates.
      const handleSessionEvent = Effect.fnUntraced(function* (event: PiRpcRecord) {
        if (!sharedReady) {
          startupEvents.push(event);
          return;
        }
        // Model-selection hooks can await a dialog before startTurn can claim
        // a wake. Keep interactive requests, and a shared chat's terminal
        // closing one, session-scoped until a turn owns them; buffer native
        // output and notifications for that turn.
        const interactiveUiRequest =
          (event["type"] === "extension_ui_request" &&
            ["select", "confirm", "input", "editor"].includes(String(event["method"]))) ||
          event["type"] === "pi_sessions_ui_closed";
        if (
          threadState?.activeTurn === null &&
          pendingWake !== null &&
          !interactiveUiRequest &&
          !String(event["type"]).startsWith("t3.") &&
          event["type"] !== "response"
        ) {
          pendingWake.events.push(event);
          if (event["type"] === "agent_start") yield* updateProviderSession("running", null);
          if (event["type"] === "agent_settled") yield* updateProviderSession("ready", null);
          return;
        }
        for (const bridge of bridges) {
          for (const handler of bridge.events ?? []) {
            if (handler.type === event["type"]) yield* handler.handle(event);
          }
        }
        if (event["type"] === "pi_sessions_state") {
          const model = event["model"];
          const provider = recordString(model, "provider");
          const id = recordString(model, "id");
          if (provider && id) {
            appliedModel = `${provider}/${id}`;
            sessionEntity = {
              ...sessionEntity,
              model: appliedModel,
              updatedAt: yield* DateTime.now,
            };
            yield* emit({
              type: "provider_session.updated",
              driver: DULLI_PROVIDER,
              providerSession: sessionEntity,
            });
          }
          appliedThinking = recordString(event, "thinkingLevel") ?? appliedThinking;
        }
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        switch (event["type"]) {
          case "agent_start": {
            if (
              turn === null &&
              state?.providerThread.appThreadId != null &&
              continuationRequests !== undefined &&
              !closed &&
              !stopRequested
            ) {
              const wake: PiWake = { state, events: [event] };
              pendingWake = wake;
              if (rollbackBarrier !== null) {
                yield* stopPendingWake(wake);
                return;
              }
              yield* updateProviderSession("running", null);
              yield* continuationRequests
                .offer({
                  threadId: state.providerThread.appThreadId,
                  providerThreadId: state.providerThread.id,
                  driver: DULLI_PROVIDER,
                  detail: null,
                  delivery: "adapter_buffered",
                  // Pi supplies the real user/result and assistant events below.
                  notification: null,
                  dispatchIfCurrent: (dispatch) =>
                    sessionEventPermit.withPermits(1)(
                      Effect.suspend(() =>
                        pendingWake === wake && threadState === state && !closed
                          ? dispatch.pipe(
                              Effect.asSome,
                              Effect.tapError(() => stopPendingWake(wake)),
                            )
                          : Effect.succeedNone,
                      ),
                    ),
                  clearIfCurrent: () => sessionEventPermit.withPermits(1)(stopPendingWake(wake)),
                })
                .pipe(Effect.tapError(() => stopPendingWake(wake)));
              return;
            }
            if (turn === null) {
              unsolicitedActivityDetected = true;
              yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
              yield* connection.terminate;
              return;
            }
            turn.sawAgentActivity = true;
            turn.nativeAborted = false;
            turn.settleProbeGeneration += 1;
            return;
          }
          case "message_start": {
            if (turn === null) return;
            const message = event["message"];
            const role = recordString(message, "role");
            const customType = recordString(message, "customType");
            if (
              role === "user" ||
              (role === "custom" && customType === "background-terminal-result")
            ) {
              turn.assistantOrigin = "normal";
              turn.hasPrimaryAnswer = false;
            } else if (
              role === "custom" &&
              (customType === "subagents-result" || customType === "subagents-workflow-result")
            ) {
              turn.assistantOrigin = "async_result";
            }
            if (role === "assistant") {
              yield* completeOpenStreamItems(turn);
              turn.sawAgentActivity = true;
              turn.messageOrdinal += 1;
              turn.segmentOrdinal = 0;
              turn.assistantContent = makePiAssistantContentState();
              turn.claudeTraces.clear();
              turn.workBoundaryPending = false;
              yield* reconcileAssistantSnapshot(turn, message);
            }
            return;
          }
          case "message_update": {
            if (turn === null) return;
            turn.sawAgentActivity = true;
            yield* reportLiveUsage(turn, event["usage"]);
            const delta = event["assistantMessageEvent"];
            const type = recordString(delta, "type");
            const index = recordNumber(delta, "contentIndex");
            if (type === "toolcall_start") turn.workBoundaryPending = true;
            if (
              type === "text_start" ||
              type === "text_delta" ||
              type === "text_end" ||
              type === "thinking_start" ||
              type === "thinking_delta" ||
              type === "thinking_end"
            ) {
              const text = recordString(delta, "content") ?? recordString(delta, "delta") ?? "";
              const trace = type.startsWith("thinking_")
                ? parseClaudeCodeToolTrace(text)
                : undefined;
              const synthetic =
                index !== undefined &&
                (turn.claudeTraces.has(index) ||
                  (trace !== undefined &&
                    !piAssistantBlockHasContent(turn.assistantContent, index)));
              if (synthetic) {
                if (trace && index !== undefined) yield* emitClaudeTrace(turn, index, trace);
              } else {
                const result = applyPiAssistantBlockEvent(turn.assistantContent, {
                  type,
                  ...(index === undefined ? {} : { contentIndex: index }),
                  ...(recordString(delta, "delta") === undefined
                    ? {}
                    : { delta: recordString(delta, "delta")! }),
                  ...(recordString(delta, "content") === undefined
                    ? {}
                    : { content: recordString(delta, "content")! }),
                });
                turn.assistantContent = result.state;
                yield* appendAssistantDeltas(turn, result.deltas);
                if (type.endsWith("_end"))
                  for (const item of turn.streamItems.values()) {
                    if (!item.completed && item.text) yield* emitStreamItem(turn, item, true);
                  }
              }
            }
            yield* reconcileAssistantSnapshot(turn, event["message"]);
            if (type === "done")
              yield* reconcileAssistantSnapshot(turn, recordField(delta, "message"));
            if (type === "error")
              yield* reconcileAssistantSnapshot(turn, recordField(delta, "error"));
            return;
          }
          case "message_end": {
            const message = event["message"];
            if (
              opened.shared &&
              recordString(message, "role") === "user" &&
              ["terminal", "extension"].includes(String(event["piSessionsOrigin"]))
            ) {
              const content = recordField(message, "content");
              const text =
                typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content
                        .filter((block) => recordString(block, "type") === "text")
                        .map((block) => recordString(block, "text") ?? "")
                        .join("\n")
                    : "";
              if (
                !text.trim() &&
                !(
                  Array.isArray(content) &&
                  content.some((block) => recordString(block, "type") === "image")
                )
              )
                return;
              const nativeItemId = `terminal-user:${input.providerSessionId}:${externalUserOrdinal++}`;
              const at = yield* DateTime.now;
              const messageId = idAllocator.derive.messageFromProviderItem({
                driver: DULLI_PROVIDER,
                nativeItemId,
              });
              yield* emit({
                type: "message.updated",
                driver: DULLI_PROVIDER,
                message: {
                  id: messageId,
                  threadId: input.threadId,
                  runId: turn?.turnInput.runId ?? null,
                  nodeId: null,
                  role: "user",
                  text: text || "[Image sent from the terminal]",
                  attachments: [],
                  streaming: false,
                  createdBy: "user",
                  creationSource: "provider",
                  createdAt: at,
                  updatedAt: at,
                },
              });
              yield* emit({
                type: "turn_item.updated",
                driver: DULLI_PROVIDER,
                turnItem: {
                  id: idAllocator.derive.turnItemFromProviderItem({
                    driver: DULLI_PROVIDER,
                    nativeItemId,
                  }),
                  threadId: input.threadId,
                  runId: turn?.turnInput.runId ?? null,
                  nodeId: null,
                  providerThreadId: state?.providerThread.id ?? null,
                  providerTurnId: turn?.providerTurn.id ?? null,
                  nativeItemRef: providerRef(nativeItemId),
                  parentItemId: null,
                  ordinal: turn ? itemOrdinal(turn, nativeItemId) : 0,
                  startedAt: at,
                  updatedAt: at,
                  type: "user_message",
                  status: "completed",
                  title: null,
                  completedAt: at,
                  messageId,
                  text: text || "[Image sent from the terminal]",
                  attachments: [],
                  inputIntent: "turn_start",
                  createdBy: "user",
                  creationSource: "provider",
                },
              });
            }

            if (turn === null || recordString(message, "role") !== "assistant") return;
            yield* reconcileAssistantSnapshot(turn, message);
            const stopReason = recordString(message, "stopReason");
            // Only explicit work boundaries or a late async acknowledgement fold.
            // Unknown/partial replies and an async result supplying the first
            // answer stay unclassified rather than hiding the only answer.
            const hasAssistantText = Array.from(turn.streamItems.values()).some(
              (item) =>
                item.kind === "assistant_message" && !item.completed && item.text.length > 0,
            );
            const phase =
              turn.workBoundaryPending || stopReason === "toolUse" || !hasAssistantText
                ? "commentary"
                : turn.assistantOrigin === "async_result"
                  ? turn.hasPrimaryAnswer
                    ? "commentary"
                    : undefined
                  : stopReason === "stop"
                    ? "final_answer"
                    : undefined;
            yield* completeOpenStreamItems(turn, phase);
            if (phase === "final_answer") turn.hasPrimaryAnswer = true;
            if (recordString(message, "stopReason") === "aborted") turn.nativeAborted = true;
            if (recordString(message, "stopReason") === "error" && turn.failure === null) {
              turn.failure = makeProviderFailure({
                message: recordString(message, "errorMessage") ?? "Pi reported a model error.",
                class: "provider_error",
              });
            }
            return;
          }
          case "agent_end": {
            if (turn === null) return;
            const messages = recordField(event, "messages");
            const last = Array.isArray(messages)
              ? messages
                  .toReversed()
                  .find((message) => recordString(message, "role") === "assistant")
              : undefined;
            const reason = recordString(last, "stopReason");
            if (reason === "aborted") turn.nativeAborted = true;
            if (reason === "error")
              turn.failure = makeProviderFailure({
                message: recordString(last, "errorMessage") ?? "Pi reported a model error.",
                class: "provider_error",
              });
            return;
          }
          case "tool_execution_start":
            if (turn !== null) {
              turn.sawAgentActivity = true;
              yield* emitToolItem(turn, event, "start");
            }
            return;
          case "tool_execution_update":
            if (turn !== null) yield* emitToolItem(turn, event, "update");
            return;
          case "tool_execution_end":
            if (turn !== null) yield* emitToolItem(turn, event, "end");
            return;
          case "compaction_start": {
            if (turn === null) return;
            turn.settleProbeGeneration += 1;
            turn.sawCompaction = true;
            if (turn.activeCompaction !== null) {
              yield* emitCompaction(turn, turn.activeCompaction, "cancelled");
            }
            const startedAt = yield* DateTime.now;
            const compaction = {
              nativeItemId: compactionNativeItemId(turn),
              startedAt,
            } satisfies PiCompactionState;
            turn.activeCompaction = compaction;
            yield* emitCompaction(turn, compaction, "running");
            return;
          }
          case "compaction_end": {
            if (turn === null) return;
            const observedAt = yield* DateTime.now;
            const compaction = turn.activeCompaction ?? {
              nativeItemId: compactionNativeItemId(turn),
              startedAt: observedAt,
            };
            turn.activeCompaction = null;
            const result = event["result"];
            if (result === null || result === undefined) {
              if (event["aborted"] === true) {
                if (turn.rejectedPromptFailure === null) turn.nativeAborted = true;
                yield* emitCompaction(turn, compaction, "cancelled");
                if (turn.settleWhenIdle || !turn.sawAgentActivity) {
                  yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
                }
                return;
              }
              const errorMessage =
                recordString(event, "errorMessage") ?? "Pi context compaction failed.";
              turn.failure = makeProviderFailure({
                message: errorMessage,
                class: "provider_error",
              });
              yield* emitCompaction(turn, compaction, "failed", {
                summary: errorMessage.slice(0, 1_000),
              });
              if (turn.settleWhenIdle || !turn.sawAgentActivity) {
                yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
              }
              return;
            }
            // Overflow may emit a model error before Pi compacts and retries. Clear it only
            // when Pi confirms a retry; non-retrying compaction must preserve exhausted errors.
            if (event["willRetry"] === true) turn.failure = null;
            turn.latestCompactionAfterTokens =
              nonNegativeInteger(result, "estimatedTokensAfter") ?? null;
            const summary = recordString(result, "summary");
            const beforeTokenCount = nonNegativeInteger(result, "tokensBefore");
            const afterTokenCount = nonNegativeInteger(result, "estimatedTokensAfter");
            yield* emitCompaction(turn, compaction, "completed", {
              ...(summary === undefined ? {} : { summary }),
              ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
              ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
            });
            if (turn.settleWhenIdle || !turn.sawAgentActivity) {
              yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
            }
            return;
          }
          case "auto_retry_start": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const maxAttempts = Math.max(
              attempt,
              Math.trunc(recordNumber(event, "maxAttempts") ?? attempt),
            );
            const retryDelayMs = Math.max(0, Math.trunc(recordNumber(event, "delayMs") ?? 0));
            const failure = makeProviderFailure({
              message: recordString(event, "errorMessage") ?? "Pi provider request failed.",
              class: "provider_error",
              retryable: true,
            });
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: { attempt, maxAttempts, retryDelayMs },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies PiProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            yield* emitProviderRetry(turn, providerRetry, "running", emittedAt);
            return;
          }
          case "auto_retry_end": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            if (event["success"] === true) {
              // The retry recovered. Pi emits the erroring `message_end`
              // before retrying, so leaving that failure in place would make
              // `agent_settled` terminalize a successful turn as failed.
              if (turn.activeProviderRetry !== null) {
                const attempt = Math.max(
                  1,
                  Math.trunc(
                    recordNumber(event, "attempt") ?? turn.activeProviderRetry.retry.attempt,
                  ),
                );
                const recoveredRetry = {
                  ...turn.activeProviderRetry,
                  retry: { ...turn.activeProviderRetry.retry, attempt },
                };
                yield* emitProviderRetry(turn, recoveredRetry, "completed", emittedAt);
                turn.activeProviderRetry = null;
              }
              turn.failure = null;
              return;
            }
            const failure = makeProviderFailure({
              message: recordString(event, "finalError") ?? "Pi auto-retry failed.",
              class: "provider_error",
              retryable: false,
            });
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: {
                attempt,
                maxAttempts: current?.retry.maxAttempts ?? attempt,
                retryDelayMs: current?.retry.retryDelayMs ?? null,
              },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies PiProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            turn.failure = failure;
            yield* emitProviderRetry(turn, providerRetry, "failed", emittedAt);
            return;
          }
          case "extension_ui_request":
            yield* handleExtensionUiRequest(event);
            return;
          case "extension_error": {
            yield* emitExtensionError(event);
            return;
          }
          case "agent_settled": {
            if (turn?.interrupted === true) {
              if (state !== null) yield* finalizeTurn(state);
              return;
            }
            if (turn !== null) {
              turn.nativeAborted = turn.nativeAborted || event["aborted"] === true;
              turn.settleWhenIdle = true;
              turn.settleProbeGeneration += 1;
              // A wake can settle while the newly joined user prompt is still
              // expanding. Its acknowledgement opens the idle-probe barrier.
              if (
                turn.adoptedWake &&
                pendingPromptResponses.some(
                  (pending) =>
                    pending.providerTurnId === turn.providerTurn.id &&
                    pending.kind === "turn_start",
                )
              )
                return;
              yield* scheduleSettleProbe(turn, true);
            }
            return;
          }
          case "response": {
            // Correlated responses never reach the pump; an id-less response
            // is the deferred ack of a fire-and-forget prompt/steer/compact.
            const command = recordString(event, "command");
            if (command === "compact") {
              const pendingCompact = pendingCompactResponses.shift();
              const compactTurn =
                pendingCompact?.providerTurnId === turn?.providerTurn.id ? turn : null;
              if (compactTurn !== null) compactTurn.manualCompactInFlight = false;
              if (event["success"] === true) {
                if (
                  pendingCompact?.kind === "turn_start" &&
                  compactTurn !== null &&
                  compactTurn.promptMayBeCommandOnly &&
                  !compactTurn.sawAgentActivity
                ) {
                  yield* scheduleSettleProbe(compactTurn);
                }
                return;
              }
              if (event["success"] !== false) return;
              if (compactTurn === null) return;
              if (compactTurn.activeCompaction !== null) return;
              if (pendingCompact?.kind === "steer") {
                yield* Effect.logWarning("Pi rejected a compact steer.", {
                  errorLength: recordString(event, "error")?.length,
                });
                return;
              }
              if (!compactTurn.sawCompaction) {
                compactTurn.failure = makeProviderFailure({
                  message: recordString(event, "error") ?? "Pi compact failed.",
                  class: "provider_error",
                });
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (!compactTurn.sawAgentActivity) {
                yield* scheduleSettleProbe(compactTurn);
              }
              return;
            }
            const pendingPrompt = command === "prompt" ? pendingPromptResponses.shift() : undefined;
            const responseTurn =
              pendingPrompt?.providerTurnId === turn?.providerTurn.id ? turn : null;
            if (event["success"] === true) {
              // Command-only prompts never emit agent_settled, so probe idleness after success.
              // Requeue the result behind Pi events emitted before get_state replied to keep
              // the check stream-ordered.
              if (
                pendingPrompt?.kind === "turn_start" &&
                responseTurn !== null &&
                ((responseTurn.promptMayBeCommandOnly && !responseTurn.sawAgentActivity) ||
                  (responseTurn.adoptedWake &&
                    (responseTurn.settleWhenIdle || responseTurn.promptMayBeCommandOnly)))
              ) {
                yield* scheduleSettleProbe(responseTurn, responseTurn.adoptedWake);
              }
              return;
            }
            if (event["success"] !== false) return;
            if (command === "steer" || pendingPrompt?.kind === "steer") {
              // A rejected steer only means that one message was refused. The
              // turn it was aimed at is still running on Pi, so terminalizing
              // here would report a failure while output keeps streaming.
              yield* Effect.logWarning("Pi rejected a steer message.", {
                errorLength: recordString(event, "error")?.length,
              });
              return;
            }
            const failedTurn =
              command === "prompt" && pendingPrompt?.kind === "turn_start"
                ? responseTurn
                : command === "parse"
                  ? turn
                  : null;
            if (failedTurn !== null) {
              const failure = makeProviderFailure({
                message: recordString(event, "error") ?? "Pi rejected the prompt.",
                class: "provider_error",
              });
              if (failedTurn.adoptedWake && command === "prompt") {
                failedTurn.rejectedPromptFailure = failure;
                failedTurn.settleWhenIdle = true;
                yield* scheduleSettleProbe(failedTurn, true);
              } else {
                failedTurn.failure = failure;
                if (state !== null) yield* finalizeTurn(state);
              }
            }
            return;
          }
          case "t3.ui_request_expired": {
            const requestId = recordString(event, "requestId");
            if (requestId === undefined) return;
            const pending = pendingPrompts.get(requestId);
            if (pending === undefined || pending !== event["pending"]) return;
            pendingPrompts.delete(requestId);
            yield* cancelPrompt(pending, yield* DateTime.now);
            return;
          }
          case "pi_sessions_ui_closed": {
            // pi-sessions also showed this dialog in the terminal, which answered it
            // first, or it timed out or was aborted there. Pi needs no response.
            const nativeRequestId = recordString(event, "id");
            const entry = Array.from(pendingPrompts).find(
              ([, pending]) => pending.nativeRequestId === nativeRequestId,
            );
            if (entry === undefined) return;
            pendingPrompts.delete(entry[0]);
            yield* closePrompt(
              entry[1],
              yield* DateTime.now,
              recordString(event, "outcome") === "answered" ? "resolved" : "cancelled",
            );
            return;
          }
          case "t3.flush_extension_errors": {
            // Startup extension failures are informational and do not block
            // Pi, so attach them to the next real turn instead of creating a
            // standalone failed run.
            for (const extensionError of outOfTurnExtensionErrors.splice(0)) {
              yield* emitExtensionError(extensionError);
            }
            return;
          }
          case "t3.rollback_barrier": {
            if (rollbackBarrier !== null && event["barrier"] === rollbackBarrier)
              yield* Deferred.succeed(rollbackBarrier, undefined);
            return;
          }
          case "t3.settle_probe": {
            // New work increments the generation before the pump can consume
            // a stale idle snapshot, so only a current snapshot may settle.
            const data = event["data"];
            const probeFailed = event["probeFailed"] === true;
            const settleAfterAgentActivity = event["settleAfterAgentActivity"] === true;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            if (
              turn === null ||
              turn.providerTurn.id !== event["providerTurnId"] ||
              turn.settleProbeGeneration !== event["settleProbeGeneration"] ||
              (!settleAfterAgentActivity && turn.sawAgentActivity) ||
              turn.activeCompaction !== null
            ) {
              return;
            }
            if (probeFailed) {
              if (!settleAfterAgentActivity) {
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (attempt < SETTLE_PROBE_MAX_ATTEMPTS) {
                yield* Effect.sleep(SETTLE_PROBE_RETRY_DELAY).pipe(
                  Effect.andThen(scheduleSettleProbe(turn, true, attempt + 1)),
                  Effect.forkIn(scope),
                );
                return;
              }
              stopRequested = true;
              yield* connection.terminate;
              return;
            }
            if (
              recordField(data, "isStreaming") !== true &&
              recordField(data, "isCompacting") !== true &&
              (recordNumber(data, "pendingMessageCount") ?? 0) === 0
            ) {
              turn.settleWhenIdle = false;
              if (state !== null) yield* finalizeTurn(state);
            }
            return;
          }
          default:
            return;
        }
      });

      yield* Effect.gen(function* () {
        while (true) {
          const queued = yield* Queue.take(connection.events);
          yield* sessionEventPermit.withPermits(1)(
            Effect.suspend(() => {
              const { t3BindingGeneration, ...event } = queued;
              // Frames already queued by a detached host must not mutate the
              // replacement thread after rpc-open.
              return t3BindingGeneration !== undefined && t3BindingGeneration !== binding
                ? Effect.void
                : handleSessionEvent(event);
            }),
          );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              // Transport death finalizes any live turn. Stop-with-restart
              // closes the provider stream cleanly; only an unexpected death
              // is surfaced as an event-stream failure.
              yield* stopBridges;
              const state = threadState;
              if (rollbackBarrier !== null)
                yield* Deferred.fail(
                  rollbackBarrier,
                  protocolError("Pi transport closed during rollback"),
                );
              pendingWake = null;
              const interrupted = state?.activeTurn?.interrupted === true;
              if (state?.activeTurn != null) {
                state.activeTurn.failure = interrupted
                  ? null
                  : makeProviderFailure({
                      cause,
                      message: "Pi process exited unexpectedly.",
                      class: "transport_error",
                    });
                yield* finalizeTurn(state, false);
              } else {
                yield* cancelPendingPrompts(yield* DateTime.now);
              }
              if (unsolicitedActivityDetected) {
                yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
                yield* Queue.end(events);
              } else if (stopRequested) {
                yield* updateProviderSession("stopped", null);
                yield* Queue.end(events);
              } else {
                yield* updateProviderSession(
                  "error",
                  interrupted ? "Pi process was stopped." : "Pi process exited unexpectedly.",
                );
                yield* Queue.fail(
                  events,
                  new ProviderAdapter.ProviderAdapterEventStreamError({
                    driver: DULLI_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
                );
              }
            }),
          ),
        ),
        Effect.forkIn(scope),
      );

      // ── session runtime ───────────────────────────────────

      const registerThread = Effect.fn("DulliAdapter.registerThread")(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        publish = true,
      ) {
        if (rollbackBarrier !== null)
          return yield* protocolError("Cannot register a Pi thread during rollback");
        if (threadState !== null && threadState.activeTurn !== null) {
          return yield* protocolError("Cannot register a Pi thread while a turn is active");
        }
        if (pendingWake !== null) {
          const state = threadState;
          if (
            state !== null &&
            state === pendingWake.state &&
            state.providerThread.appThreadId === threadInput.threadId &&
            (threadInput.existingProviderThread === undefined ||
              threadInput.existingProviderThread.nativeThreadRef?.nativeId ===
                state.providerThread.nativeThreadRef?.nativeId)
          )
            return state.providerThread;
          return yield* protocolError(
            "Cannot switch Pi threads while native work is awaiting a turn",
          );
        }
        const existing = threadInput.existingProviderThread;
        let resumeId = existing?.nativeThreadRef?.nativeId;
        let resumeDropped = false;
        if (resumeId != null) {
          if (!paths.isAbsolute(resumeId))
            return yield* protocolError(
              "Dulli nativeThreadRef must be an absolute Pi session file path",
            );
          const exists = yield* fileSystem.exists(resumeId);
          if (!exists) {
            resumeId = undefined;
            resumeDropped = true;
          }
        }
        // A shared resume is an identity check, not a lifecycle command. Do
        // this on every registration (including retries and daemon imports).
        let sharedState =
          opened.shared && !sharedNeedsOpen ? yield* request({ type: "get_state" }) : undefined;
        const needsNewSession = resumeId == null && registrationAttempted;
        const previousNativeId =
          recordString(sharedState, "sessionFile") ??
          lastNativeThreadId ??
          input.initialNativeThreadId;
        let sameSharedFile = resumeId != null && previousNativeId === resumeId;
        if (opened.shared && resumeId != null && previousNativeId != null && !sameSharedFile) {
          const [actual, expected] = yield* Effect.all([
            fileSystem
              .realPath(previousNativeId)
              .pipe(Effect.orElseSucceed(() => previousNativeId)),
            fileSystem.realPath(resumeId),
          ]);
          sameSharedFile = actual === expected;
        }
        const reopenShared =
          opened.shared &&
          (sharedNeedsOpen || needsNewSession || (resumeId != null && !sameSharedFile));
        if (!opened.shared) registrationAttempted = true;
        if (reopenShared || (!opened.shared && (resumeId != null || needsNewSession))) {
          lastNativeThreadId = resumeId ?? lastNativeThreadId;
          // Even a failed lifecycle operation can change Pi's native session.
          // Never leave the old app binding or model defaults usable afterward.
          threadState = null;
          appliedModel = null;
          appliedThinking = null;
          appliedContext = null;
          appliedFast = null;
          appliedSessionName = null;
          baselineModel = null;
          baselineThinking = null;
          contextWindow = null;
          if (opened.shared) {
            sharedNeedsOpen = true;
            sharedReady = false;
            startupEvents.splice(0);
            binding++;
            yield* opened.connection.terminate;
            // Never fall back to an owned process here: rpc-open is the
            // single-writer arbiter, including a failed/retried registration.
            const next = yield* makePiDaemonConnection(
              { ...spawnOptions, threadId: threadInput.threadId },
              resumeId == null ? {} : { sessionFile: resumeId },
            ).pipe(
              Effect.provideService(Path.Path, paths),
              Effect.provideService(Scope.Scope, daemonScope),
            );
            opened = { ...next, shared: true };
            sharedState = undefined;
            sharedNeedsOpen = false;
            yield* forwardConnection(opened.connection, binding);
          } else {
            const result = yield* lifecycleRequest(
              resumeId != null
                ? { type: "switch_session", sessionPath: resumeId }
                : { type: "new_session" },
            );
            if (recordField(result, "cancelled") === true) {
              return yield* protocolError("A Pi extension cancelled the session switch");
            }
          }
        }
        const stateData = sharedState ?? (yield* request({ type: "get_state" }));
        if (!modelsDiscovered) {
          const modelsData = yield* request({ type: "get_available_models" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const models = recordField(modelsData, "models");
          if (Array.isArray(models)) {
            for (const model of models) rememberModelContextWindow(model);
            modelsDiscovered = true;
          }
        }
        contextWindow = rememberModelContextWindow(recordField(stateData, "model"));
        // Each baseline is captured independently, and only while nothing has
        // been applied yet, so a `get_state` that arrives after our own
        // selection cannot record that selection as Pi's default.
        if (baselineModel === null && appliedModel === null) {
          const stateModel = recordField(stateData, "model");
          const provider = recordString(stateModel, "provider");
          const modelId = recordString(stateModel, "id");
          if (provider !== undefined && modelId !== undefined) {
            baselineModel = { provider, modelId };
          }
        }
        if (baselineThinking === null && appliedThinking === null) {
          baselineThinking = recordString(stateData, "thinkingLevel") ?? null;
        }
        // switch_session accepts a file path, not Pi's display session UUID.
        const nativeId = recordString(stateData, "sessionFile");
        if (nativeId === undefined) {
          return yield* protocolError("get_state returned no persisted sessionFile", stateData);
        }
        if (needsNewSession && nativeId === lastNativeThreadId) {
          return yield* protocolError("Pi did not create a distinct session file");
        }
        if (!paths.isAbsolute(nativeId))
          return yield* protocolError("Pi returned a non-absolute sessionFile");
        if (opened.shared && resumeId != null && nativeId !== resumeId) {
          const [actual, expected] = yield* Effect.all([
            fileSystem.realPath(nativeId),
            fileSystem.realPath(resumeId),
          ]);
          if (actual !== expected)
            return yield* protocolError("Pi daemon opened a different session file");
        }
        lastNativeThreadId = nativeId;
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: providerRef(nativeId),
                ...(needsNewSession ? { nativeConversationHeadRef: null, contextUsage: null } : {}),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: DULLI_PROVIDER,
                  nativeThreadId: nativeId,
                }),
                driver: DULLI_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: providerRef(nativeId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt,
                updatedAt: createdAt,
              };
        threadState = { providerThread, activeTurn: null };
        if (resumeDropped)
          yield* emitNotice(
            "Pi could not find this thread's earlier conversation file, so it started a new one. Earlier messages stay in T3, but Pi will not remember them.",
          );
        if (!bridgesStarted) {
          bridgesStarted = true;
          yield* Effect.forEach(bridges, (bridge) => bridge.onStart?.() ?? Effect.void, {
            discard: true,
          });
        }
        // Baseline the session-tree leaf so the first turn's user entry can
        // be located with a `since` cursor instead of a full entry scan.
        const baselineEntries = opened.shared
          ? undefined
          : yield* request({ type: "get_entries" }).pipe(Effect.orElseSucceed(() => undefined));
        lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
        // A successful full baseline makes the cursor trustworthy again. Only
        // a failed one leaves it stale, so a recovered session does not keep
        // skipping turn refs. An empty tree is a success with no leafId.
        leafCursorStale = baselineEntries === undefined;
        if (publish)
          yield* emit({
            type: "provider_thread.updated",
            driver: DULLI_PROVIDER,
            providerThread,
          });
        if (opened.shared && !sharedReady) {
          yield* sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              sharedReady = true;
              if (!opened.started)
                yield* handleSessionEvent({
                  type: "pi_sessions_state",
                  ...(typeof stateData === "object" && stateData !== null ? stateData : {}),
                });
              for (const event of startupEvents.splice(0)) yield* handleSessionEvent(event);
            }),
          );
          const catalog = yield* request({ type: "get_commands" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const commands = recordField(catalog, "commands");
          for (const name of ["background-terminals-rpc"]) {
            if (
              Array.isArray(commands) &&
              commands.some((command) => recordString(command, "name") === name)
            ) {
              yield* request({ type: "prompt", message: `/${name} {"action":"replay"}` }).pipe(
                Effect.ignore,
              );
            }
          }
        }
        registrationAttempted = true;
        return providerThread;
      });

      const applySelection = Effect.fn("DulliAdapter.applySelection")(function* (
        modelSelection: ModelSelection,
      ) {
        const thinking = getModelSelectionStringOptionValue(modelSelection, "reasoning");
        if (modelSelection.model === PI_INHERIT_MODEL_SLUG) {
          // Returning to "Pi default" after an explicit pick has to replay the
          // captured baseline, otherwise Pi stays on the last model applied.
          if (appliedModel !== null && baselineModel !== null) {
            const restoredModel = yield* request({ type: "set_model", ...baselineModel });
            contextWindow = rememberModelContextWindow(restoredModel);
            appliedModel = null;
            const updatedAt = yield* DateTime.now;
            sessionEntity = { ...sessionEntity, model: PI_INHERIT_MODEL_SLUG, updatedAt };
            yield* emit({
              type: "provider_session.updated",
              driver: DULLI_PROVIDER,
              providerSession: sessionEntity,
            });
          }
          // The "Pi default" model advertises no thinking choices of its own,
          // so an unqualified return also restores Pi's configured level
          // instead of silently keeping the effort a previous pick applied.
          if (
            thinking === undefined &&
            appliedThinking !== null &&
            baselineThinking !== null &&
            appliedThinking !== baselineThinking
          ) {
            yield* request({ type: "set_thinking_level", level: baselineThinking });
            appliedThinking = null;
          }
        } else if (modelSelection.model !== appliedModel) {
          const parsed = parsePiModelSlug(modelSelection.model);
          if (parsed === null) {
            return yield* protocolError(
              `Pi model '${modelSelection.model}' must use provider/model format`,
            );
          }
          const selectedModel = yield* request({
            type: "set_model",
            provider: parsed.provider,
            modelId: parsed.modelId,
          });
          contextWindow = rememberModelContextWindow(selectedModel);
          appliedModel = modelSelection.model;
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, model: modelSelection.model, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: DULLI_PROVIDER,
            providerSession: sessionEntity,
          });
        }
        if (
          thinking !== undefined &&
          thinking !== appliedThinking &&
          PI_THINKING_LEVELS.has(thinking)
        ) {
          yield* request({ type: "set_thinking_level", level: thinking });
          appliedThinking = thinking;
        }
        const context = parsePiContextWindow(
          getModelSelectionStringOptionValue(modelSelection, "contextWindow"),
        );
        const fast = supportsPiCodexFastService(modelSelection.model)
          ? (parsePiFastServiceEnabled(
              getModelSelectionStringOptionValue(modelSelection, "serviceTier"),
            ) ?? false)
          : undefined;
        const contextKey = `${modelSelection.model}\0${context}`;
        const fastKey = `${modelSelection.model}\0${fast}`;
        if (
          (context !== undefined && contextKey !== appliedContext) ||
          (fast !== undefined && fastKey !== appliedFast)
        ) {
          const catalog = yield* request({ type: "get_commands" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const commands = recordField(catalog, "commands");
          const has = (name: string) =>
            Array.isArray(commands) &&
            commands.some((command) => recordString(command, "name") === name);
          if (context !== undefined && contextKey !== appliedContext) {
            if (has("context")) yield* request({ type: "prompt", message: `/context ${context}` });
            else if (context !== "auto")
              yield* emitNotice(
                "Ignoring context-window selection: this Pi profile does not provide /context.",
              );
            appliedContext = contextKey;
          }
          if (fast !== undefined && fastKey !== appliedFast) {
            if (has("fast"))
              yield* request({ type: "prompt", message: `/fast ${fast ? "on" : "off"}` });
            else if (fast)
              yield* emitNotice("Ignoring Codex Fast: this Pi profile does not provide /fast.");
            appliedFast = fastKey;
          }
        }
      });

      const resolvePromptPayload = Effect.fn("DulliAdapter.resolvePromptPayload")(function* (
        text: string,
        attachments: ReadonlyArray<ChatAttachment>,
      ) {
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        const extraLines: Array<string> = [];
        for (const attachment of attachments) {
          const path = host.resolveAttachmentPath(attachment);
          if (path === null) continue;
          if (attachment.mimeType.startsWith("image/")) {
            const bytes = yield* fileSystem.readFile(path);
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          } else {
            extraLines.push(`[Attachment saved at ${path}]`);
          }
        }
        const message = extraLines.length === 0 ? text : `${text}\n\n${extraLines.join("\n")}`;
        return { message, images };
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: DULLI_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        hasPendingBackgroundWork: Effect.sync(
          () =>
            (opened.shared && !closed) ||
            pendingWake !== null ||
            bridges.some((bridge) => bridge.hasPendingBackgroundWork?.()),
        ),
        hasPendingBackgroundWorkForThread: (providerThread) =>
          Effect.sync(
            () =>
              (opened.shared && !closed && threadState?.providerThread.id === providerThread.id) ||
              (pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id) ||
              (threadState?.providerThread.id === providerThread.id &&
                bridges.some((bridge) => bridge.hasPendingBackgroundWork?.())),
          ),
        stopSubagent: (stopInput) => {
          const bridge = bridges.find((candidate) => candidate.stopSubagent !== undefined);
          return (
            bridge?.stopSubagent?.(stopInput) ??
            Effect.fail(
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: DULLI_PROVIDER,
                detail: "The Dulli subagent control extension is not available in this session.",
              }),
            )
          );
        },
        getModelContextWindow: (selection) => {
          if (selection.instanceId !== options.instanceId) return undefined;
          const slug =
            selection.model === PI_INHERIT_MODEL_SLUG
              ? baselineModel === null
                ? undefined
                : `${baselineModel.provider}/${baselineModel.modelId}`
              : selection.model;
          return slug === undefined ? undefined : modelContextWindows.get(slug);
        },
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: DULLI_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: DULLI_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        // The run executor routes a bare `/compact` here instead of startTurn.
        // Pi's start path already turns that text into the RPC compact call.
        compactThread: (turnInput) =>
          runtime.startTurn({
            ...turnInput,
            message: { ...turnInput.message, text: "/compact" },
          }),
        startTurn: Effect.fn("DulliAdapter.startTurn")(
          function* (turnInput) {
            if (rollbackBarrier !== null)
              return yield* protocolError("Cannot start a Pi turn during rollback");
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Pi session has no registered thread");
            }
            if (state.activeTurn !== null) {
              return yield* protocolError(
                `Pi provider thread ${turnInput.providerThread.id} already has an active turn`,
              );
            }
            if (
              state.providerThread.nativeThreadRef?.nativeId !==
              turnInput.providerThread.nativeThreadRef?.nativeId
            ) {
              return yield* protocolError("Pi turn requested for a different native session");
            }
            // The orchestrator adopts a fork under its already-allocated row.
            // Future session updates must retain that authoritative identity.
            const continuation =
              turnInput.message.createdBy === "agent" &&
              turnInput.message.creationSource === "provider";
            if (!continuation) yield* applySelection(turnInput.modelSelection);
            // Mirror the thread title into pi's session name so the session
            // stays identifiable in pi's own /resume listing. Best-effort:
            // naming must never block a turn.
            if (turnInput.appThread.title !== appliedSessionName) {
              yield* request({
                type: "set_session_name",
                name: turnInput.appThread.title,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => (appliedSessionName = turnInput.appThread.title)),
                ),
                Effect.ignore,
              );
            }
            // Resolve attachments before installing activeTurn so failures cannot block later turns.
            // Send orchestration instructions through before_agent_start, not wrapped user text:
            // slash commands must remain at the beginning of the message.
            const compactCommand = continuation
              ? null
              : parsePiCompactCommand(turnInput.message.text);
            if (opened.shared && compactCommand !== null)
              return yield* protocolError(
                "Compact is not available in a chat shared with the terminal. Run /compact in the terminal instead.",
              );
            const payload =
              !continuation && compactCommand === null
                ? yield* resolvePromptPayload(turnInput.message.text, turnInput.message.attachments)
                : null;
            const startedAt = yield* DateTime.now;
            const syntheticNativeTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({
                driver: DULLI_PROVIDER,
                nativeTurnId: syntheticNativeTurnId,
              }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const activeTurn: ActivePiTurn = {
              turnInput,
              providerTurn,
              startedAt,
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              messageOrdinal: 0,
              segmentOrdinal: 0,
              assistantContent: makePiAssistantContentState(),
              workBoundaryPending: false,
              assistantOrigin: "normal",
              hasPrimaryAnswer: false,
              claudeTraces: new Map(),
              toolUpdatedAt: new Map(),
              streamItems: new Map(),
              toolArgs: new Map(),
              toolStartedAt: new Map(),
              interrupted: false,
              nativeAborted: false,
              sawAgentActivity: false,
              adoptedWake: false,
              promptMayBeCommandOnly:
                compactCommand !== null || (payload?.message.trimStart().startsWith("/") ?? false),
              latestCompactionAfterTokens: null,
              lastLiveUsedTokens: null,
              settleProbeGeneration: 0,
              settleWhenIdle: false,
              sawCompaction: false,
              manualCompactInFlight: compactCommand !== null,
              activeCompaction: null,
              activeProviderRetry: null,
              failure: null,
              rejectedPromptFailure: null,
            };
            // Only the install/send/start-event boundary excludes the event
            // pump. Earlier correlated requests must leave the pump free so
            // project trust, login, and session-switch dialogs can be shown
            // and answered instead of deadlocking the caller.
            yield* Effect.gen(function* () {
              if (
                threadState !== state ||
                state.activeTurn !== null ||
                closed ||
                stopRequested ||
                rollbackBarrier !== null ||
                state.providerThread.nativeThreadRef?.nativeId !==
                  turnInput.providerThread.nativeThreadRef?.nativeId
              ) {
                return yield* protocolError("Pi turn ownership changed before it could start");
              }
              const wake = pendingWake?.state === state ? pendingWake : null;
              if (wake !== null && wake.state.providerThread.appThreadId !== turnInput.threadId) {
                return yield* protocolError("Pi native wake belongs to a different app thread");
              }
              pendingWake = null;
              state.providerThread = turnInput.providerThread;
              state.activeTurn = activeTurn;
              activeTurn.adoptedWake = wake !== null && !continuation;
              if (compactCommand !== null) {
                yield* connection.send(compactRpcRecord(compactCommand));
                pendingCompactResponses.push({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                });
              } else if (payload !== null) {
                // Pi may already be streaming before its wake reaches T3.
                // Let Pi atomically queue the prompt or start an idle run.
                yield* connection.send({
                  type: "prompt",
                  message: payload.message,
                  streamingBehavior: "steer",
                  ...(payload.images.length === 0 ? {} : { images: payload.images }),
                });
                pendingPromptResponses.push({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                });
              }
              yield* emit({
                type: "provider_turn.updated",
                driver: DULLI_PROVIDER,
                threadId: turnInput.threadId,
                providerTurn,
              });
              yield* updateProviderThread(state, {
                status: "active",
                firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                lastRunOrdinal: turnInput.runOrdinal,
              });
              yield* updateProviderSession("running", null);
              if (wake !== null) {
                for (const event of wake.events) {
                  if (!continuation && event["type"] === "agent_settled") {
                    activeTurn.nativeAborted = event["aborted"] === true;
                    activeTurn.settleWhenIdle = true;
                    continue;
                  }
                  yield* handleSessionEvent(event);
                }
              } else if (continuation) {
                // A user turn, teardown, or newer binding already took the wake.
                yield* finalizeTurn(state);
              }
              if (outOfTurnExtensionErrors.length > 0) {
                yield* Queue.offer(connection.events, { type: "t3.flush_extension_errors" });
              }
            }).pipe(
              sessionEventPermit.withPermits(1),
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (state.activeTurn === activeTurn) state.activeTurn = null;
                }),
              ),
            );
            // Pi acks `prompt` only after slash-command expansion completes,
            // and extension commands may block on user dialogs indefinitely.
            // Rejections therefore return later as id-less response records
            // handled by the event pump.
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: DULLI_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        ),
        steerTurn: Effect.fn("DulliAdapter.steerTurn")(
          function* (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) {
            const turn = threadState?.activeTurn ?? null;
            if (turn === null || turn.providerTurn.id !== steerInput.providerTurnId) {
              return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
            }
            const compactCommand = parsePiCompactCommand(steerInput.message.text);
            if (opened.shared && compactCommand !== null)
              return yield* protocolError(
                "Compact is not available in a chat shared with the terminal. Run /compact in the terminal instead.",
              );
            const payload =
              compactCommand === null
                ? yield* resolvePromptPayload(
                    steerInput.message.text,
                    steerInput.message.attachments,
                  )
                : null;
            // Prompt/steer atomically queues or starts a run; direct steer can strand input after idle.
            // Send fire-and-forget under the session permit so dialogs cannot block the turn
            // and settlement cannot overtake its check. /compact uses Pi’s aborting compact RPC.
            yield* sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                if (threadState?.activeTurn !== turn) {
                  return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
                }
                if (compactCommand !== null) {
                  turn.manualCompactInFlight = true;
                  yield* connection.send(compactRpcRecord(compactCommand));
                  pendingCompactResponses.push({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                  });
                } else if (payload !== null) {
                  yield* connection.send({
                    type: "prompt",
                    message: payload.message,
                    streamingBehavior: "steer",
                    ...(payload.images.length === 0 ? {} : { images: payload.images }),
                  });
                  pendingPromptResponses.push({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                  });
                }
                turn.settleProbeGeneration += 1;
              }),
            );
          },
          (effect, steerInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: DULLI_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        interruptTurn: Effect.fn("DulliAdapter.interruptTurn")(
          function* (interruptInput) {
            const turn = threadState?.activeTurn ?? null;
            // Stop on a settled turn: Pi runs nothing between prompts, so
            // nothing of that turn is left to stop.
            if (turn === null && interruptInput.requestRuntimeRestart === true) {
              if (pendingWake !== null)
                yield* sessionEventPermit.withPermits(1)(stopPendingWake(pendingWake));
              return;
            }
            if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(`Pi turn ${interruptInput.providerTurnId} is not active`);
            }
            yield* cancelPendingPrompts(yield* DateTime.now);
            turn.interrupted = true;
            if (
              interruptInput.requestRuntimeRestart === true ||
              turn.settleWhenIdle ||
              turn.activeCompaction !== null ||
              turn.manualCompactInFlight
            ) {
              // Pi's generic abort does not cancel manual compaction. Terminate
              // so Stop covers user /compact as well as detached recovery compact.
              stopRequested = true;
              if (interruptInput.requestRuntimeRestart === true && !turn.settleWhenIdle) {
                yield* request({ type: "abort" }, 2_000).pipe(Effect.ignore);
              }
              // Terminating fails every later request, so read the stopped
              // turn's session-tree refs first: rolling back past this turn
              // forks at its user entry. Holding the event permit also lets a
              // finalize that is already reading them finish before the kill.
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (threadState?.activeTurn === turn && turn.stopTreeRefs === undefined) {
                    turn.stopTreeRefs = yield* captureTurnTreeRefs(2_000);
                  }
                  yield* connection.terminate;
                }),
              );
              return;
            }
            yield* request({ type: "abort" }).pipe(
              Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
            );
          },
          (effect, interruptInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: DULLI_PROVIDER,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("DulliAdapter.respondToRuntimeRequest")(
          function* (requestInput) {
            const pending = pendingPrompts.get(String(requestInput.requestId));
            if (pending === undefined) {
              return yield* protocolError(
                `No pending Pi extension request ${requestInput.requestId}`,
              );
            }
            const answeredAt = yield* DateTime.now;
            if (
              pending.expiresAt !== null &&
              DateTime.toEpochMillis(answeredAt) >= pending.expiresAt
            ) {
              pendingPrompts.delete(String(requestInput.requestId));
              yield* cancelPrompt(pending, answeredAt);
              return yield* protocolError(
                `Pi extension request ${requestInput.requestId} has expired`,
              );
            }
            // old/malformed clients may still send free text. Reject it without consuming the card;
            // shared Pi ignores cancelled responses, so silently converting it to cancellation strands the tool.
            const response = piUiResponse(pending, requestInput.decision, requestInput.answers);
            if (
              pending.method === "select" &&
              requestInput.answers?.[pending.questionId] !== undefined &&
              response["cancelled"] === true
            ) {
              return yield* protocolError("Choose one of the listed Pi dialog options.");
            }
            yield* connection.send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              ...response,
            });
            // Dropped only once Pi has the answer, so a failed send leaves the
            // request retryable and still cancellable during teardown.
            pendingPrompts.delete(String(requestInput.requestId));
            if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
            if (pending.method === "confirm" && requestInput.decision === "acceptForSession") {
              sessionApprovals.add(pending.approvalKey);
            }
            const resolvedAt = yield* DateTime.now;
            pending.runtimeRequest = {
              ...pending.runtimeRequest,
              status: response["cancelled"] === true ? "cancelled" : "resolved",
              resolvedAt,
            };
            yield* emit({
              type: "runtime_request.updated",
              driver: DULLI_PROVIDER,
              threadId: pending.node.threadId,
              runtimeRequest: pending.runtimeRequest,
            });
            yield* emit({
              type: "node.updated",
              driver: DULLI_PROVIDER,
              node: {
                ...pending.node,
                status: response["cancelled"] === true ? "cancelled" : "completed",
                completedAt: resolvedAt,
              },
            });
            yield* emit({
              type: "turn_item.updated",
              driver: DULLI_PROVIDER,
              turnItem: {
                ...pending.turnItem,
                status: response["cancelled"] === true ? "cancelled" : "completed",
                completedAt: resolvedAt,
                updatedAt: resolvedAt,
              },
            });
          },
          (effect, requestInput) =>
            effect.pipe(
              sessionEventPermit.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: DULLI_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
        ),
        readThreadSnapshot: Effect.fn("DulliAdapter.readThreadSnapshot")(
          function* (snapshotInput) {
            const state = threadState;
            const boundNativeId = state?.providerThread.nativeThreadRef?.nativeId;
            const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
            if (state === null || wantedNativeId == null || boundNativeId !== wantedNativeId) {
              return yield* protocolError(
                "Pi snapshot requested for a thread this session does not host",
              );
            }
            // get_messages is Pi's active-branch view. get_entries returns the
            // whole session tree, including abandoned branches after /tree or
            // fork, which would leak discarded conversation into handoffs.
            const messagesData = yield* request({ type: "get_messages" });
            const activeMessages = recordField(messagesData, "messages");
            const threadId = state.providerThread.appThreadId ?? input.threadId;
            const messages = (Array.isArray(activeMessages) ? activeMessages : []).flatMap(
              (message, index) => {
                const role = recordString(message, "role");
                if (role !== "user" && role !== "assistant") return [];
                const text = contentText(recordField(message, "content"), "\n\n");
                if (text.length === 0) return [];
                const timestamp = recordNumber(message, "timestamp");
                const at = Option.getOrElse(
                  DateTime.make(timestamp ?? Number.NaN),
                  () => state.providerThread.createdAt,
                );
                return [
                  {
                    id: idAllocator.derive.messageFromProviderItem({
                      driver: DULLI_PROVIDER,
                      // RPC messages do not expose session-tree entry ids. The
                      // active-branch index is stable for the lifetime of this
                      // snapshot and keeps abandoned branch ids out of it.
                      nativeItemId: `${wantedNativeId}:snapshot-message:${index}`,
                    }),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: role as "user" | "assistant",
                    text,
                    attachments: [],
                    streaming: false,
                    createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                    creationSource: "provider" as const,
                    createdAt: at,
                    updatedAt: at,
                  },
                ];
              },
            );
            return {
              providerThread: state.providerThread,
              providerTurns: [],
              messages,
              runtimeRequests: [],
            };
          },
          (effect, snapshotInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: DULLI_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        rollbackThread: Effect.fn("DulliAdapter.rollbackThread")(
          function* (rollbackInput) {
            if (opened.shared)
              return yield* protocolError(
                "Rollback is not available in a chat shared with the terminal.",
              );
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Pi session has no registered thread");
            }
            if (state.providerThread.id !== rollbackInput.providerThread.id) {
              return yield* protocolError(
                "Pi rollback requested for a thread this session does not host",
              );
            }
            if (state.activeTurn !== null) {
              return yield* protocolError("Cannot roll back while a Pi turn is active");
            }
            if (pendingWake !== null) {
              return yield* protocolError("Cannot roll back while native Pi work awaits a turn");
            }
            // `fork(entryId)` re-roots the active branch before that user
            // message, so the rollback boundary is the first user entry of
            // the earliest turn being discarded.
            const forkEntryId = piRollbackForkEntry(rollbackInput);
            if (forkEntryId === null) {
              // Nothing after the target: the conversation is already there.
              return piThreadSnapshot(state.providerThread);
            }
            if (forkEntryId === undefined) {
              return yield* protocolError("Pi rollback target has no captured session-tree entry");
            }
            return yield* Effect.acquireUseRelease(
              sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (
                    rollbackBarrier !== null ||
                    threadState !== state ||
                    state.activeTurn !== null ||
                    pendingWake !== null ||
                    closed ||
                    stopRequested
                  )
                    return yield* protocolError(
                      "Pi rollback ownership changed before its fork could start",
                    );
                  const barrier = yield* Deferred.make<
                    void,
                    ProviderAdapter.ProviderAdapterProtocolError
                  >();
                  rollbackBarrier = barrier;
                  return barrier;
                }),
              ),
              (barrier) =>
                Effect.gen(function* () {
                  const forkData = yield* lifecycleRequest({ type: "fork", entryId: forkEntryId });
                  if (recordField(forkData, "cancelled") === true)
                    return yield* protocolError("A Pi extension cancelled the session fork");
                  const forkState = yield* request({ type: "get_state" }).pipe(
                    Effect.onError(() =>
                      Effect.sync(() => {
                        threadState = null;
                      }),
                    ),
                  );
                  const forkSessionFile = recordString(forkState, "sessionFile");
                  if (forkSessionFile === undefined) {
                    threadState = null;
                    return yield* protocolError("Pi fork did not return a persisted session file");
                  }
                  const entriesData = yield* request({ type: "get_entries" }).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                  const leafId = recordString(entriesData, "leafId") ?? null;
                  // RPC responses bypass the pump. Drain preceding native events
                  // before deciding whether this fork can replace their binding.
                  const queued = yield* Queue.offer(connection.events, {
                    type: "t3.rollback_barrier",
                    barrier,
                  });
                  if (!queued) return yield* protocolError("Pi transport closed during rollback");
                  yield* Deferred.await(barrier);
                  return yield* sessionEventPermit.withPermits(1)(
                    Effect.gen(function* () {
                      if (pendingWake !== null) {
                        yield* stopPendingWake(pendingWake);
                        return yield* protocolError(
                          "Native Pi work started while rollback was changing the session",
                        );
                      }
                      if (
                        threadState !== state ||
                        state.activeTurn !== null ||
                        closed ||
                        stopRequested
                      )
                        return yield* protocolError(
                          "Pi rollback ownership changed during its fork",
                        );
                      lastNativeThreadId = forkSessionFile;
                      appliedModel = null;
                      appliedThinking = null;
                      appliedSessionName = null;
                      lastKnownLeaf = leafId;
                      leafCursorStale = entriesData === undefined;
                      yield* updateProviderThread(state, {
                        nativeThreadRef: providerRef(forkSessionFile),
                        nativeConversationHeadRef: leafId === null ? null : providerRef(leafId),
                      });
                      rollbackBarrier = null;
                      return piThreadSnapshot(state.providerThread);
                    }),
                  );
                }).pipe(Effect.onInterrupt(() => connection.terminate)),
              (barrier) =>
                Effect.sync(() => {
                  if (rollbackBarrier === barrier) rollbackBarrier = null;
                }),
            );
          },
          (effect, rollbackInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver: DULLI_PROVIDER,
                    providerThreadId: rollbackInput.providerThread.id,
                    checkpointId: rollbackInput.target.checkpointId,
                    cause,
                  }),
              ),
            ),
        ),
        forkThread: Effect.fn("DulliAdapter.forkThread")(
          function* (forkInput) {
            if (opened.shared)
              return yield* protocolError(
                "Fork is not available in a chat shared with the terminal.",
              );
            if (threadState?.activeTurn != null) {
              return yield* protocolError("Cannot fork while a Pi turn is active");
            }
            const source = forkInput.sourceProviderThread;
            const sourceFile = source.nativeThreadRef?.nativeId;
            if (sourceFile == null)
              return yield* protocolError("Pi fork source has no session file");
            const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
              (turn) => turn.providerThreadId === source.id,
            );
            const target = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
            if (forkInput.providerTurnId !== undefined && target === undefined) {
              return yield* protocolError("Pi fork target turn is missing");
            }
            const beforeEntry =
              target === undefined
                ? null
                : piRollbackForkEntry({
                    target: { type: "provider_turn", providerTurn: target },
                    providerThreadTurns: sourceTurns,
                  });
            if (beforeEntry === undefined) {
              return yield* protocolError("Pi fork boundary has no captured session-tree entry");
            }
            // CLI --fork uses Pi's own session format and sets the destination
            // cwd. RPC switch_session/clone alone would retain the source cwd.
            // This short-lived process never prompts or runs user extensions.
            const forkLaunch = buildPiRpcLaunch({
              launchArgs: resolvedLaunchArgs.args,
              environment: options.environment,
              mcpSession: undefined,
              extensionPath: undefined,
              disableExtensions: true,
              disableTools: true,
            });
            const nativeId = yield* Effect.scoped(
              Effect.gen(function* () {
                const forkConnection = yield* makePiRpcConnection({
                  command: options.settings.binaryPath || "pi",
                  args: [...forkLaunch.args, "--fork", sourceFile],
                  cwd,
                  env: forkLaunch.env,
                });
                yield* Stream.fromQueue(forkConnection.events).pipe(
                  Stream.runDrain,
                  Effect.ignore,
                  Effect.forkScoped,
                );
                if (beforeEntry !== null) {
                  const result = yield* forkConnection.request({
                    type: "fork",
                    entryId: beforeEntry,
                  });
                  if (recordField(result, "cancelled") === true) {
                    return yield* protocolError("A Pi extension cancelled the session fork");
                  }
                }
                const state = yield* forkConnection.request({ type: "get_state" });
                const file = recordString(state, "sessionFile");
                if (file === undefined || file === sourceFile) {
                  return yield* protocolError("Pi fork did not create a distinct session file");
                }
                return file;
              }),
            ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
            const now = yield* DateTime.now;
            return yield* registerThread(
              {
                threadId: forkInput.targetThreadId,
                modelSelection: forkInput.modelSelection ?? input.modelSelection,
                runtimePolicy: forkInput.runtimePolicy ?? input.runtimePolicy,
                existingProviderThread: {
                  ...source,
                  id: idAllocator.derive.providerThread({
                    driver: DULLI_PROVIDER,
                    nativeThreadId: nativeId,
                  }),
                  appThreadId: forkInput.targetThreadId,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: options.instanceId,
                  ownerNodeId: forkInput.ownerNodeId ?? null,
                  nativeThreadRef: providerRef(nativeId),
                  nativeConversationHeadRef: null,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  pendingBackgroundTasks: [],
                  forkedFrom: {
                    providerThreadId: source.id,
                    ...(forkInput.providerTurnId === undefined
                      ? {}
                      : { providerTurnId: forkInput.providerTurnId }),
                  },
                  createdAt: now,
                  updatedAt: now,
                },
              },
              false,
            );
          },
          (effect, forkInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: DULLI_PROVIDER,
                    providerThreadId: forkInput.sourceProviderThread.id,
                    cause,
                  }),
              ),
            ),
        ),
      };
      return runtime;
    }),
  });
});

interface PiSessionEntry {
  readonly parentId: string | null;
  readonly isUserMessage: boolean;
}

/** Index a `get_entries` listing, rejecting ambiguous ancestry. */
function piSessionEntries(entries: unknown): ReadonlyMap<string, PiSessionEntry> | null {
  const byId = new Map<string, PiSessionEntry>();
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const id = recordString(entry, "id");
    const parentId = recordField(entry, "parentId");
    if (id === undefined || byId.has(id) || (parentId !== null && typeof parentId !== "string"))
      return null;
    byId.set(id, {
      parentId,
      isUserMessage:
        recordField(entry, "type") === "message" &&
        recordString(recordField(entry, "message"), "role") === "user",
    });
  }
  return byId;
}

/**
 * Walk parentId from leafId to stopAt; append order includes abandoned branches.
 * A partial listing not reaching stopAt means the branch diverged. Cycles indicate
 * corruption and return null, which callers treat as a failed listing.
 */
function walkPiBranch(
  entries: ReadonlyMap<string, PiSessionEntry>,
  leafId: string | null,
  stopAt: string | null,
): {
  readonly entryCount: number;
  readonly userEntryIds: ReadonlyArray<string>;
  readonly reachedStop: boolean;
} | null {
  const visited = new Set<string>();
  const userEntryIds: Array<string> = [];
  let current = leafId;
  while (current !== null && current !== stopAt) {
    const entry = entries.get(current);
    if (entry === undefined) break;
    if (visited.has(current)) return null;
    visited.add(current);
    if (entry.isUserMessage) userEntryIds.push(current);
    current = entry.parentId;
  }
  return { entryCount: visited.size, userEntryIds, reachedStop: current === stopAt };
}

/**
 * Rollback forks at the first discarded turn with a ref; refless turns left no branch entry.
 * Return null if nothing is discarded, undefined if the boundary lacks a captured
 * entry ref. Only captureTurnTreeRefs turn-boundary refs are strong.
 */
function piRollbackForkEntry(input: {
  readonly target:
    | { readonly type: "thread_start" }
    | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}): string | null | undefined {
  const boundaryOrdinal =
    input.target.type === "thread_start" ? 0 : input.target.providerTurn.ordinal;
  const ref = input.providerThreadTurns
    .filter((turn) => turn.ordinal > boundaryOrdinal && turn.nativeTurnRef !== null)
    .sort((a, b) => a.ordinal - b.ordinal)[0]?.nativeTurnRef;
  if (ref == null) return null;
  if (ref.strength !== "strong" || ref.nativeId === null) return undefined;
  return ref.nativeId;
}

/**
 * Human-readable output for one subagent-extension task result: the last
 * assistant text from its transcript, or the error/stderr when it failed.
 */
function piSubagentOutput(result: unknown): string {
  const stopReason = recordString(result, "stopReason");
  const failed =
    (recordNumber(result, "exitCode") ?? 0) !== 0 ||
    stopReason === "error" ||
    stopReason === "aborted";
  if (failed) {
    // Falsy fallback, not `??`: an empty `errorMessage` must not suppress a
    // non-empty `stderr`, which is often the only description of the failure.
    const failure = recordString(result, "errorMessage") || recordString(result, "stderr");
    if (failure !== undefined && failure.length > 0) return failure;
  }
  const messages = recordField(result, "messages");
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (recordString(message, "role") !== "assistant") continue;
    const text = contentText(recordField(message, "content"), "\n\n");
    if (text.length > 0) return text;
  }
  return "";
}

function piExtensionDisplayName(extensionPath: string | undefined): string {
  if (extensionPath === undefined) return "Pi extension";
  const normalized = extensionPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return name.length === 0 ? "Pi extension" : name;
}

function piThreadSnapshot(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot {
  return { providerThread, providerTurns: [], messages: [], runtimeRequests: [] };
}

function piQuestion(
  questionId: string,
  method: "select" | "input" | "editor",
  title: string,
  event: PiRpcRecord,
): OrchestrationV2UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({ label: option || "Empty value", description: option, value: option }))
      : method === "editor"
        ? []
        : [
            {
              label: "Submit empty value",
              description: "Send an empty string to the extension.",
              value: "",
            },
          ];
  const question = recordString(event, "message") ?? recordString(event, "placeholder") ?? title;
  return {
    id: questionId,
    header: title,
    question,
    ...(method === "editor" ? { initialAnswer: recordString(event, "prefill") ?? "" } : {}),
    // Pi selects accept only listed values; free text would cancel T3's card but leave shared Pi waiting.
    ...(method === "select" ? { allowCustomAnswer: false } : {}),
    options,
  };
}

function piUiResponse(
  pending: PendingPiPrompt,
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): PiRpcRecord {
  if (pending.method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    return { cancelled: true };
  }
  const rawAnswer = answers?.[pending.questionId];
  // orchestration also accepts single-option array answers. Normalize
  // that valid representation instead of cancelling an already-resolved card.
  const answer = Array.isArray(rawAnswer) && rawAnswer.length === 1 ? rawAnswer[0] : rawAnswer;
  // An empty string is a valid dialog value per the RPC spec (the extension
  // receives ""), distinct from cancelling (the extension receives undefined).
  if (typeof answer === "string") {
    if (
      pending.method === "select" &&
      pending.turnItem.type === "user_input_request" &&
      !pending.turnItem.questions[0]?.options.some((option) => option.value === answer)
    )
      return { cancelled: true };
    return { value: answer };
  }
  return { cancelled: true };
}

// ── driver ────────────────────────────────────────────────────

export type DulliAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

export const DulliAdapterV2Driver: ProviderAdapterDriver<DulliSettings, DulliAdapterV2DriverEnv> = {
  driverKind: PI_DRIVER_KIND,
  configSchema: DulliSettings,
  defaultConfig: (): DulliSettings => DEFAULT_PI_SETTINGS,
  create: Effect.fn("DulliAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<DulliSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      return yield* makeDulliAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        continuationRequests,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: PI_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Pi adapter.",
              cause,
            }),
        ),
      ),
  ),
};
