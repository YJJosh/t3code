import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  PiBackgroundTerminalEvent as PiBackgroundTerminalEventSchema,
  type PiBackgroundTerminalEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { PiSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { parseJsonlLine, serializeJsonlLine } from "../pi/piJsonl.ts";
import {
  type PiTaskBridgeEvent,
  PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX,
  PI_SUBAGENTS_RPC_EVENT_PREFIX,
} from "../pi/piRpcProtocol.ts";
import { makePiAdapter, projectPiTaskBridgeEvent, splitPiModelSlug } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const encodeBackgroundTerminalEvent = Schema.encodeSync(
  Schema.fromJsonString(PiBackgroundTerminalEventSchema),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeTaskControlRequest {
  readonly action: "steer" | "reply" | "kill";
  readonly requestId: string;
  readonly runId: string;
}

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly written: ReadonlyArray<Record<string, unknown>>;
  readonly taskControlRequests: Queue.Dequeue<FakeTaskControlRequest>;
  readonly pushFrame: (frame: unknown) => Effect.Effect<void>;
}

const makeFakePi = Effect.fn("makeFakePi")(function* (
  options: {
    readonly subagentsCommand?: boolean;
    readonly backgroundTerminalsCommand?: boolean;
    readonly commands?: ReadonlyArray<{
      readonly name: string;
      readonly source?: "extension" | "prompt" | "skill";
    }>;
    readonly extensionCommand?: {
      readonly name: string;
      readonly infoMessage?: string;
      readonly startsAgent?: boolean;
    };
    readonly taskControl?: {
      readonly acknowledgment?: "success" | "failure";
      readonly result?: "success" | "failure" | "none";
      readonly order?: "before-acknowledgment" | "after-acknowledgment";
    };
  } = {},
) {
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const taskControlRequests = yield* Queue.unbounded<FakeTaskControlRequest>();
  const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const args: string[] = [];
  const env: Record<string, string> = {};
  const written: Array<Record<string, unknown>> = [];
  let isStreaming = false;

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand") {
        args.push(...command.args);
        Object.assign(env, command.options.env);
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(true),
        kill: () => Deferred.succeed(exit, 0 as ChildProcessSpawner.ExitCode).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const parsed = parseJsonlLine(decoder.decode(chunk).trim());
          if (!parsed || typeof parsed !== "object") return Effect.void;
          const request = parsed as Record<string, unknown>;
          written.push(request);
          if (typeof request.id !== "string" || typeof request.type !== "string") {
            return Effect.void;
          }
          const taskControlMessage =
            request.type === "prompt" &&
            typeof request.message === "string" &&
            request.message.startsWith("/subagents-rpc ")
              ? request.message.slice("/subagents-rpc ".length)
              : null;
          const taskControlPayload =
            taskControlMessage === null
              ? null
              : (JSON.parse(taskControlMessage) as Record<string, unknown>);
          const taskControl: FakeTaskControlRequest | null =
            taskControlPayload !== null &&
            (taskControlPayload.action === "steer" ||
              taskControlPayload.action === "reply" ||
              taskControlPayload.action === "kill")
              ? {
                  action: taskControlPayload.action,
                  requestId: String(taskControlPayload.request_id),
                  runId: String(taskControlPayload.run_id),
                }
              : null;
          const promptRejected =
            taskControl !== null && options.taskControl?.acknowledgment === "failure";
          const extensionCommand = options.extensionCommand;
          const extensionPrefix = extensionCommand ? `/${extensionCommand.name}` : undefined;
          const runsExtensionCommand =
            request.type === "prompt" &&
            typeof request.message === "string" &&
            extensionPrefix !== undefined &&
            (request.message === extensionPrefix ||
              request.message.startsWith(`${extensionPrefix} `));
          if (runsExtensionCommand && extensionCommand?.startsAgent) isStreaming = true;
          const response = {
            type: "response",
            id: request.id,
            command: request.type,
            success: !promptRejected,
            ...(promptRejected
              ? { error: "Pi rejected the subagent RPC command." }
              : request.type === "get_state"
                ? {
                    data: {
                      sessionId: "pi-session-test",
                      isStreaming,
                      isCompacting: false,
                      pendingMessageCount: 0,
                    },
                  }
                : request.type === "get_commands"
                  ? {
                      data: {
                        commands: [
                          ...(options.subagentsCommand === false
                            ? []
                            : [{ name: "subagents-rpc", source: "extension" }]),
                          ...(options.backgroundTerminalsCommand === false
                            ? []
                            : [{ name: "background-terminals-rpc", source: "extension" }]),
                          ...(options.commands ?? []),
                        ],
                      },
                    }
                  : {}),
          };
          const taskControlResult =
            taskControl === null || promptRejected || options.taskControl?.result === "none"
              ? null
              : {
                  type: "extension_ui_request",
                  id: `control-${taskControl.requestId}`,
                  method: "notify",
                  message: `${PI_SUBAGENTS_RPC_EVENT_PREFIX}${JSON.stringify({
                    contractVersion: 1,
                    managerId: "manager-control",
                    sequence: 1,
                    timestamp: "2026-01-01T00:00:00.000Z",
                    kind: "control_result",
                    runId: taskControl.runId,
                    control: {
                      requestId: taskControl.requestId,
                      action: taskControl.action,
                      success: options.taskControl?.result !== "failure",
                      ...(options.taskControl?.result === "failure"
                        ? { error: "The child is no longer waiting for input." }
                        : {}),
                    },
                  })}`,
                };
          const backgroundControlMessage =
            request.type === "prompt" &&
            typeof request.message === "string" &&
            request.message.startsWith("/background-terminals-rpc ")
              ? request.message
              : null;
          const backgroundRequestId =
            backgroundControlMessage?.match(/"request_id":"([^"]+)"/)?.[1];
          const backgroundControl =
            backgroundControlMessage !== null && backgroundRequestId !== undefined
              ? {
                  action: backgroundControlMessage.includes('"action":"kill"')
                    ? ("kill" as const)
                    : ("replay" as const),
                  request_id: backgroundRequestId,
                }
              : null;
          const backgroundControlResult =
            backgroundControl === null
              ? null
              : {
                  type: "extension_ui_request",
                  id: `control-${backgroundControl.request_id}`,
                  method: "notify",
                  message: `${PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX}${encodeBackgroundTerminalEvent(
                    {
                      contractVersion: 1,
                      managerId: "manager-1",
                      sequence: 2,
                      timestamp: "2026-01-01T00:00:01.000Z",
                      kind: "control_result",
                      control: {
                        requestId: backgroundControl.request_id,
                        action: backgroundControl.action,
                        success: true,
                      },
                    },
                  )}`,
                };
          const extensionFrames =
            runsExtensionCommand && extensionCommand
              ? [
                  ...(extensionCommand.infoMessage
                    ? [
                        {
                          type: "extension_ui_request",
                          id: `info-${extensionCommand.name}`,
                          method: "notify",
                          notifyType: "info",
                          message: extensionCommand.infoMessage,
                        },
                      ]
                    : []),
                  ...(extensionCommand.startsAgent ? [{ type: "agent_start" }] : []),
                ]
              : [];
          const frames = [
            ...(taskControlResult !== null && options.taskControl?.order === "before-acknowledgment"
              ? [taskControlResult]
              : []),
            ...extensionFrames,
            response,
            ...(taskControlResult !== null && options.taskControl?.order !== "before-acknowledgment"
              ? [taskControlResult]
              : []),
            ...(backgroundControlResult === null ? [] : [backgroundControlResult]),
          ];
          return (
            taskControl === null
              ? Effect.void
              : Queue.offer(taskControlRequests, taskControl).pipe(Effect.asVoid)
          ).pipe(
            Effect.andThen(
              Effect.forEach(
                frames,
                (frame) => Queue.offer(stdout, encoder.encode(serializeJsonlLine(frame))),
                { discard: true },
              ),
            ),
          );
        }),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  return {
    spawner,
    args,
    env,
    written,
    taskControlRequests,
    pushFrame: (frame) =>
      Effect.sync(() => {
        if (typeof frame === "object" && frame !== null && "type" in frame) {
          if (frame.type === "agent_start") isStreaming = true;
          if (frame.type === "agent_settled") isStreaming = false;
        }
      }).pipe(
        Effect.andThen(Queue.offer(stdout, encoder.encode(serializeJsonlLine(frame)))),
        Effect.asVoid,
      ),
  } satisfies FakePi;
});

const TestEnv = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const INSTANCE = ProviderInstanceId.make("pi-1");
const THREAD = ThreadId.make("11111111-1111-4111-8111-111111111111");
const settings = decodePiSettings({});

const takeThroughType = (
  events: Queue.Dequeue<ProviderRuntimeEvent>,
  type: ProviderRuntimeEvent["type"],
  seen: ReadonlyArray<ProviderRuntimeEvent> = [],
): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> =>
  Queue.take(events).pipe(
    Effect.flatMap((event) => {
      const next = [...seen, event];
      return event.type === type ? Effect.succeed(next) : takeThroughType(events, type, next);
    }),
  );

describe("Pi adapter", () => {
  it("splits provider/model slugs and rejects malformed ones", () => {
    expect(splitPiModelSlug("anthropic/claude-sonnet-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    expect(splitPiModelSlug("noslash")).toBeUndefined();
    expect(splitPiModelSlug("/leading")).toBeUndefined();
    expect(splitPiModelSlug("trailing/")).toBeUndefined();
  });

  it.effect("keeps a long-lived turn open until agent_settled", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const nativeFrames: unknown[] = [];
      const adapter = yield* makePiAdapter(settings, {
        instanceId: INSTANCE,
        environment: { HOME: "/tmp/pi-home" },
        nativeEventLogger: {
          filePath: "/tmp/native.log",
          write: (event) => Effect.sync(() => nativeFrames.push(event)),
          close: () => Effect.void,
        },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      expect(adapter.capabilities).toEqual({
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
      });
      expect(adapter.compaction).toEqual({ type: "slash-command", command: "/compact" });
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );

      const modelSelection: ModelSelection = {
        instanceId: INSTANCE,
        model: "anthropic/claude-sonnet-5",
        options: [
          { id: "profile", value: "research" },
          { id: "reasoning", value: "high" },
        ],
      };
      const session = yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection,
      });
      expect(session.providerInstanceId).toBe(INSTANCE);
      expect(session.resumeCursor).toEqual({ piSessionId: "pi-session-test" });
      expect(fake.args).toEqual([
        "--mode",
        "rpc",
        "--approve",
        "--profile",
        "research",
        "--model",
        "anthropic/claude-sonnet-5",
        "--thinking",
        "high",
      ]);
      expect(fake.env.PI_SUBAGENTS_RPC_BRIDGE).toBe("1");
      expect(fake.env.PI_BACKGROUND_TERMINALS_RPC_BRIDGE).toBe("1");

      yield* Queue.takeAll(events);
      yield* adapter.sendTurn({ threadId: THREAD, input: "Implement it", modelSelection });
      yield* takeThroughType(events, "turn.started");

      yield* fake.pushFrame({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Inspecting the repository",
        },
      });
      const throughReasoning = yield* takeThroughType(events, "content.delta");
      expect(throughReasoning.at(-1)).toEqual(
        expect.objectContaining({
          type: "content.delta",
          payload: {
            streamKind: "reasoning_text",
            delta: "Inspecting the repository",
            contentIndex: 0,
          },
        }),
      );

      yield* fake.pushFrame({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "First pass",
        },
      });
      const throughText = yield* takeThroughType(events, "content.delta");
      expect(throughText.at(-1)).toEqual(
        expect.objectContaining({
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "First pass", contentIndex: 1 },
        }),
      );

      yield* fake.pushFrame({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "first pass" }] }],
      });
      // This frame is an event-driven barrier proving agent_end was processed.
      yield* fake.pushFrame({
        type: "tool_execution_start",
        toolCallId: "continued-work",
        toolName: "bash",
        args: { command: "git status" },
      });
      const beforeSettlement = yield* takeThroughType(events, "item.started");
      expect(beforeSettlement.some((event) => event.type === "turn.completed")).toBe(false);

      yield* fake.pushFrame({ type: "agent_settled" });
      const throughSettlement = yield* takeThroughType(events, "turn.completed");
      const completed = throughSettlement.find((event) => event.type === "turn.completed");
      expect(completed?.payload.state).toBe("completed");
      expect(nativeFrames).toContainEqual(expect.objectContaining({ type: "agent_settled" }));
      expect(fake.written.filter((command) => command.type === "prompt")).toHaveLength(1);
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("assembles indexed blocks and resets content state between assistant messages", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* Queue.takeAll(events);
      yield* adapter.sendTurn({ threadId: THREAD, input: "Build the invoice" });
      yield* takeThroughType(events, "turn.started");

      const indexedEvents = [
        { type: "thinking_delta", contentIndex: 0, delta: "Plan" },
        { type: "text_delta", contentIndex: 1, delta: "Now I’ll verify the command." },
        { type: "thinking_delta", contentIndex: 2, delta: "Verify" },
        { type: "text_delta", contentIndex: 3, delta: "# Invoice Summary" },
      ] as const;
      const streamed: ProviderRuntimeEvent[] = [];
      for (const assistantMessageEvent of indexedEvents) {
        yield* fake.pushFrame({ type: "message_update", assistantMessageEvent });
        streamed.push(...(yield* takeThroughType(events, "content.delta")));
      }
      expect(
        streamed.filter((event) => event.type === "content.delta").map((event) => event.payload),
      ).toEqual([
        { streamKind: "reasoning_text", contentIndex: 0, delta: "Plan" },
        {
          streamKind: "assistant_text",
          contentIndex: 1,
          delta: "Now I’ll verify the command.",
        },
        { streamKind: "reasoning_text", contentIndex: 2, delta: "\n\nVerify" },
        {
          streamKind: "assistant_text",
          contentIndex: 3,
          delta: "\n\n# Invoice Summary",
        },
      ]);

      yield* fake.pushFrame({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Plan" },
            { type: "text", text: "Now I’ll verify the command." },
            { type: "thinking", thinking: "Verify" },
            { type: "text", text: "# Invoice Summary" },
          ],
        },
      });
      const firstCompletion = yield* takeThroughType(events, "item.completed");
      expect(firstCompletion.some((event) => event.type === "content.delta")).toBe(false);
      const firstItemId = firstCompletion.find((event) => event.type === "item.completed")?.itemId;

      yield* fake.pushFrame({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Legacy cumulative" }],
        },
      });
      const legacyStart = yield* takeThroughType(events, "content.delta");
      expect(legacyStart.at(-1)).toEqual(
        expect.objectContaining({
          payload: { streamKind: "assistant_text", delta: "Legacy cumulative" },
        }),
      );
      yield* fake.pushFrame({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Legacy cumulative snapshot" }],
        },
      });
      const legacyExtension = yield* takeThroughType(events, "content.delta");
      expect(legacyExtension.at(-1)).toEqual(
        expect.objectContaining({
          payload: { streamKind: "assistant_text", delta: " snapshot" },
        }),
      );
      yield* fake.pushFrame({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: " plus delta",
        },
      });
      const mixedDelta = yield* takeThroughType(events, "content.delta");
      expect(mixedDelta.at(-1)).toEqual(
        expect.objectContaining({
          payload: {
            streamKind: "assistant_text",
            contentIndex: 0,
            delta: " plus delta",
          },
        }),
      );
      yield* fake.pushFrame({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Legacy cumulative snapshot plus delta" }],
        },
      });
      const secondCompletion = yield* takeThroughType(events, "item.completed");
      expect(secondCompletion.some((event) => event.type === "content.delta")).toBe(false);
      expect(secondCompletion.find((event) => event.type === "item.completed")?.itemId).not.toBe(
        firstItemId,
      );

      yield* fake.pushFrame({ type: "agent_settled" });
      yield* takeThroughType(events, "turn.completed");
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("settles an idle extension command and surfaces only its scoped info", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({
        commands: [{ name: "ps", source: "extension" }],
        extensionCommand: { name: "ps", infoMessage: "No subagents are running." },
      });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* Queue.takeAll(events);

      yield* fake.pushFrame({
        type: "extension_ui_request",
        id: "startup-info",
        method: "notify",
        notifyType: "info",
        message: "Profile manager loaded.",
      });
      yield* fake.pushFrame({
        type: "extension_ui_request",
        id: "startup-barrier",
        method: "notify",
        notifyType: "warning",
        message: "startup barrier",
      });
      const startupEvents = yield* takeThroughType(events, "runtime.warning");
      expect(startupEvents.some((event) => event.type === "content.delta")).toBe(false);

      yield* adapter.sendTurn({ threadId: THREAD, input: "/ps" });
      const commandEvents = yield* takeThroughType(events, "turn.completed");

      expect(commandEvents.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(commandEvents).toContainEqual(
        expect.objectContaining({
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "No subagents are running." },
        }),
      );
      expect(commandEvents.at(-1)).toEqual(
        expect.objectContaining({ type: "turn.completed", payload: { state: "completed" } }),
      );
      expect(fake.written).toContainEqual(
        expect.objectContaining({ type: "prompt", message: "/ps" }),
      );
      expect(fake.written.some((command) => command.type === "steer")).toBe(false);
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("keeps an agent-starting extension command open until true settlement", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({
        commands: [{ name: "profile", source: "extension" }],
        extensionCommand: { name: "profile", startsAgent: true },
      });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* Queue.takeAll(events);

      yield* adapter.sendTurn({ threadId: THREAD, input: "/profile run research" });
      yield* fake.pushFrame({
        type: "extension_ui_request",
        id: "agent-started-barrier",
        method: "notify",
        notifyType: "warning",
        message: "agent started barrier",
      });
      const beforeSettlement = yield* takeThroughType(events, "runtime.warning");
      expect(beforeSettlement.some((event) => event.type === "turn.completed")).toBe(false);

      yield* fake.pushFrame({ type: "agent_settled" });
      const throughSettlement = yield* takeThroughType(events, "turn.completed");
      expect(throughSettlement.at(-1)).toEqual(
        expect.objectContaining({
          type: "turn.completed",
          payload: expect.objectContaining({ state: "completed" }),
        }),
      );
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("prompts extension commands during an active model turn without settling it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({
        commands: [{ name: "ps", source: "extension" }],
        extensionCommand: { name: "ps", infoMessage: "One subagent is running." },
      });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* Queue.takeAll(events);

      const active = yield* adapter.sendTurn({ threadId: THREAD, input: "Implement it" });
      yield* takeThroughType(events, "turn.started");
      yield* adapter.sendTurn({ threadId: THREAD, input: "/ps" });
      yield* fake.pushFrame({
        type: "extension_ui_request",
        id: "active-command-barrier",
        method: "notify",
        notifyType: "warning",
        message: "active command barrier",
      });
      const commandEvents = yield* takeThroughType(events, "runtime.warning");

      expect(commandEvents.some((event) => event.type === "turn.started")).toBe(false);
      expect(commandEvents.some((event) => event.type === "turn.completed")).toBe(false);
      expect(commandEvents).toContainEqual(
        expect.objectContaining({
          type: "content.delta",
          turnId: active.turnId,
          payload: { streamKind: "assistant_text", delta: "One subagent is running." },
        }),
      );
      expect(fake.written).toContainEqual(
        expect.objectContaining({ type: "prompt", message: "/ps" }),
      );

      yield* fake.pushFrame({ type: "agent_settled" });
      const throughSettlement = yield* takeThroughType(events, "turn.completed");
      expect(throughSettlement.at(-1)).toEqual(expect.objectContaining({ turnId: active.turnId }));
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect(
    "leaves normal prompts, templates, skills, and legacy commands on the normal path",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi({
          commands: [
            { name: "review", source: "prompt" },
            { name: "skill:inspect", source: "skill" },
            { name: "legacy" },
          ],
        });
        const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
        );
        const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
        yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
          Effect.forkScoped,
        );
        yield* adapter.startSession({
          threadId: THREAD,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* Queue.takeAll(events);

        yield* adapter.sendTurn({ threadId: THREAD, input: "Implement it" });
        yield* takeThroughType(events, "turn.started");
        yield* adapter.sendTurn({ threadId: THREAD, input: "Adjust the implementation" });
        expect(fake.written.at(-1)).toEqual(
          expect.objectContaining({ type: "steer", message: "Adjust the implementation" }),
        );
        yield* fake.pushFrame({ type: "agent_settled" });
        yield* takeThroughType(events, "turn.completed");

        for (const command of ["/review focused", "/skill:inspect src", "/legacy"]) {
          yield* adapter.sendTurn({ threadId: THREAD, input: command });
          yield* takeThroughType(events, "turn.started");
          yield* fake.pushFrame({
            type: "extension_ui_request",
            id: `barrier-${command}`,
            method: "notify",
            notifyType: "warning",
            message: `${command} barrier`,
          });
          const beforeSettlement = yield* takeThroughType(events, "runtime.warning");
          expect(beforeSettlement.some((event) => event.type === "turn.completed")).toBe(false);
          expect(fake.written).toContainEqual(
            expect.objectContaining({ type: "prompt", message: command }),
          );
          yield* fake.pushFrame({ type: "agent_settled" });
          yield* takeThroughType(events, "turn.completed");
        }
      }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("awaits task control results that arrive after prompt acknowledgment", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({
        taskControl: { order: "after-acknowledgment" },
      });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      expect(adapter.controlTask).toBeDefined();
      yield* adapter.controlTask!({
        threadId: THREAD,
        taskId: "rmre1dz89-9",
        action: "reply",
        message: "Use the upstream lifecycle",
      });

      const control = fake.written.find(
        (command) =>
          command.type === "prompt" &&
          typeof command.message === "string" &&
          command.message.startsWith("/subagents-rpc "),
      );
      expect(control?.message).toContain('"action":"reply"');
      expect(control?.message).toContain('"run_id":"rmre1dz89-9"');
      expect(control?.message).toContain('"message":"Use the upstream lifecycle"');
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("awaits task control results that arrive before prompt acknowledgment", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({
        taskControl: { order: "before-acknowledgment" },
      });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.controlTask!({
        threadId: THREAD,
        taskId: "run-result-first",
        action: "stop",
        reason: "No longer needed",
      });

      expect(yield* Queue.take(fake.taskControlRequests)).toMatchObject({
        action: "kill",
        runId: "run-result-first",
      });
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("returns the Pi task control rejection as a typed request error", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({ taskControl: { result: "failure" } });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* adapter.controlTask!({
        threadId: THREAD,
        taskId: "run-rejected",
        action: "reply",
        message: "Continue",
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ProviderAdapterRequestError",
        method: "subagents-rpc",
        detail: "The child is no longer waiting for input.",
      });
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("returns prompt rejection as a typed request error", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({
        taskControl: { acknowledgment: "failure" },
      });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* adapter.controlTask!({
        threadId: THREAD,
        taskId: "run-command-rejected",
        action: "steer",
        message: "Change direction",
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ProviderAdapterRequestError",
        method: "prompt",
        detail: "Pi rejected the subagent RPC command.",
      });
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("times out when Pi acknowledges a task control without reporting a result", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({ taskControl: { result: "none" } });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const control = yield* adapter.controlTask!({
        threadId: THREAD,
        taskId: "run-missing-result",
        action: "reply",
        message: "Continue",
      }).pipe(Effect.forkChild);
      yield* Queue.take(fake.taskControlRequests);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("13 seconds");

      expect(yield* Fiber.join(control).pipe(Effect.flip)).toMatchObject({
        _tag: "ProviderAdapterRequestError",
        method: "subagents-rpc",
        detail: "Timed out waiting for the Pi task control result.",
      });
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("fails and clears pending task controls when their Pi session stops", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({ taskControl: { result: "none" } });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const control = yield* adapter.controlTask!({
        threadId: THREAD,
        taskId: "run-stopped",
        action: "stop",
      }).pipe(Effect.forkChild);
      yield* Queue.take(fake.taskControlRequests);
      yield* fake.pushFrame({
        type: "extension_ui_request",
        id: "control-stop-barrier",
        method: "notify",
        notifyType: "warning",
        message: "task control acknowledgment processed",
      });
      yield* takeThroughType(events, "runtime.warning");
      yield* adapter.stopSession(THREAD);

      expect(yield* Fiber.join(control).pipe(Effect.flip)).toMatchObject({
        _tag: "ProviderAdapterRequestError",
        method: "subagents-rpc",
        detail: "The Pi session stopped before the task control completed.",
      });
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("streams and controls background terminals through the advertised Pi extension", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<{
        readonly threadId: ThreadId;
        readonly event: PiBackgroundTerminalEvent;
      }>();
      yield* Stream.runForEach(adapter.backgroundTerminals!.streamEvents, (event) =>
        Queue.offer(events, event),
      ).pipe(Effect.forkScoped);

      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const terminal = {
        id: "bt-1",
        command: "vp run dev",
        title: "Dev server",
        cwd: process.cwd(),
        pid: 4243,
        status: "running",
        createdAt: 1,
        stdout: { text: "ready\n", totalBytes: 6, truncatedBytes: 0 },
        stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
      } as const;
      yield* fake.pushFrame({
        type: "extension_ui_request",
        id: "background-notice",
        method: "notify",
        message: `${PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX}${encodeBackgroundTerminalEvent({
          contractVersion: 1,
          managerId: "manager-1",
          sequence: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          kind: "snapshot",
          snapshot: { terminals: [terminal], replay: true },
        })}`,
      });
      let snapshot = yield* Queue.take(events);
      while (snapshot.event.managerId !== "manager-1") {
        snapshot = yield* Queue.take(events);
      }
      expect(snapshot.threadId).toBe(THREAD);
      expect(snapshot.event.kind).toBe("snapshot");
      expect(snapshot.event.managerId).toBe("manager-1");

      yield* adapter.backgroundTerminals!.control({
        threadId: THREAD,
        action: "kill",
        terminalId: "bt-1",
        managerId: "manager-1",
        requestId: "kill-1",
      });
      const control = fake.written.find(
        (command) =>
          command.type === "prompt" &&
          typeof command.message === "string" &&
          command.message.startsWith("/background-terminals-rpc "),
      );
      expect(control?.message).toContain('"action":"kill"');
      expect(control?.message).toContain('"terminal_id":"bt-1"');
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("does not forward task controls when the Pi extension is unavailable", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({ subagentsCommand: false });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      expect(adapter.controlTask).toBeDefined();
      const error = yield* adapter.controlTask!({
        threadId: THREAD,
        taskId: "rmre1dz89-9",
        action: "stop",
      }).pipe(Effect.flip);

      expect(error?._tag).toBe("ProviderAdapterValidationError");
      expect(fake.written.some((command) => command.type === "get_commands")).toBe(true);
      expect(fake.written.some((command) => command.type === "prompt")).toBe(false);
    }).pipe(Effect.provide(TestEnv)),
  );

  it.effect("normalizes child deltas into cumulative live transcript events", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      yield* adapter.startSession({
        threadId: THREAD,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* Queue.takeAll(events);

      const view = {
        runId: "run-live",
        task: "Inspect transcript projection",
        state: "running",
        model: "openai-codex/gpt-5.6-sol",
        activeMs: 100,
      };
      const pushBridge = (event: Record<string, unknown>) =>
        fake.pushFrame({
          type: "extension_ui_request",
          id: `request-${String(event.sequence)}`,
          method: "notify",
          notifyType: "info",
          message: `${PI_SUBAGENTS_RPC_EVENT_PREFIX}${JSON.stringify(event)}`,
        });

      yield* pushBridge({
        contractVersion: 1,
        managerId: "manager-live",
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        kind: "run_created",
        runId: "run-live",
        view,
      });
      yield* takeThroughType(events, "task.started");

      yield* pushBridge({
        contractVersion: 1,
        managerId: "manager-live",
        sequence: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        kind: "child_message",
        runId: "run-live",
        view,
        activity: {
          type: "message_update",
          liveOnly: true,
          data: { assistantMessageEvent: { type: "thinking_delta", delta: "Inspecting" } },
        },
      });
      yield* takeThroughType(events, "task.progress");

      yield* pushBridge({
        contractVersion: 1,
        managerId: "manager-live",
        sequence: 3,
        timestamp: "2026-01-01T00:00:01.050Z",
        kind: "child_message",
        runId: "run-live",
        view,
        activity: {
          type: "message_update",
          liveOnly: true,
          data: { assistantMessageEvent: { type: "text_delta", delta: "Buffered " } },
        },
      });
      yield* pushBridge({
        contractVersion: 1,
        managerId: "manager-live",
        sequence: 4,
        timestamp: "2026-01-01T00:00:01.200Z",
        kind: "child_message",
        runId: "run-live",
        view,
        activity: {
          type: "message_update",
          liveOnly: true,
          data: { assistantMessageEvent: { type: "text_delta", delta: "found the path" } },
        },
      });
      const throughText = yield* takeThroughType(events, "task.progress");
      const progress = throughText.at(-1);
      expect(progress).toEqual(
        expect.objectContaining({
          type: "task.progress",
          payload: expect.objectContaining({
            taskId: "run-live",
            transcriptEvent: expect.objectContaining({
              activity: expect.objectContaining({
                type: "message_update",
                liveOnly: true,
                data: expect.objectContaining({
                  message: {
                    role: "assistant",
                    content: [
                      { type: "thinking", thinking: "Inspecting" },
                      { type: "text", text: "Buffered found the path" },
                    ],
                  },
                }),
              }),
            }),
          }),
        }),
      );
    }).pipe(Effect.provide(TestEnv)),
  );

  it("replays durable child transcript events from Pi snapshots", () => {
    const view = {
      runId: "run-replay",
      task: "Replay the child conversation",
      state: "done",
      model: "openai-codex/gpt-5.6-sol",
      activeMs: 500,
      result: { result: { summary: "Replay complete" } },
    };
    const replay = projectPiTaskBridgeEvent({
      contractVersion: 1,
      managerId: "manager-replay",
      sequence: 20,
      timestamp: "2026-01-01T00:01:00.000Z",
      kind: "snapshot",
      snapshot: {
        runs: [view],
        events: [
          {
            contractVersion: 1,
            managerId: "manager-replay",
            sequence: 7,
            timestamp: "2026-01-01T00:00:07.000Z",
            kind: "child_message",
            runId: "run-replay",
            view,
            activity: {
              type: "message_end",
              data: {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Persisted answer" }],
                },
              },
            },
            replay: true,
          },
        ],
        replay: true,
      },
    } as PiTaskBridgeEvent);

    expect(replay.map((event) => event.type)).toEqual([
      "task.started",
      "task.progress",
      "task.completed",
    ]);
    expect(replay[1]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          taskId: "run-replay",
          transcriptEvent: expect.objectContaining({
            managerId: "manager-replay",
            sequence: 7,
            activity: expect.objectContaining({ type: "message_end" }),
          }),
        }),
      }),
    );
  });

  it("projects optional Pi workflow notifications into canonical task lifecycles", () => {
    const base = {
      contractVersion: 1,
      managerId: "manager-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      runId: "run-1",
      view: {
        runId: "run-1",
        task: "Review adapter boundaries",
        state: "running",
        model: "anthropic/claude-sonnet-5",
        activeMs: 250,
        usageSoFar: { input: 10, output: 5, cacheRead: 2, total: 17, turns: 1 },
        workflow: { runId: "workflow-1", name: "review", label: "Reviewer", phase: "Audit" },
      },
    } as const;

    expect(projectPiTaskBridgeEvent({ ...base, kind: "run_created" } as PiTaskBridgeEvent)).toEqual(
      [
        expect.objectContaining({
          type: "task.started",
          payload: expect.objectContaining({
            taskId: "run-1",
            taskType: "pi-subagent",
            agentKind: "agent",
            title: "Reviewer",
            workflowName: "review",
            parentAgentId: "workflow-1",
            phaseTitle: "Audit",
          }),
        }),
      ],
    );
    const waiting = projectPiTaskBridgeEvent({
      ...base,
      kind: "needs_input",
    } as PiTaskBridgeEvent);
    expect(waiting).toEqual([
      expect.objectContaining({
        type: "task.updated",
        payload: expect.objectContaining({ status: "waiting" }),
      }),
    ]);
    expect(waiting[0]?.payload).not.toHaveProperty("description");
    expect(
      projectPiTaskBridgeEvent({
        ...base,
        kind: "run_running",
        view: { ...base.view, progressNote: "Running the focused adapter tests" },
      } as PiTaskBridgeEvent),
    ).toEqual([
      expect.objectContaining({
        type: "task.updated",
        payload: expect.objectContaining({
          status: "running",
          description: "Running the focused adapter tests",
        }),
      }),
    ]);
    expect(
      projectPiTaskBridgeEvent({
        ...base,
        sequence: 2,
        kind: "child_message",
        activity: {
          type: "message_end",
          data: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "The adapter is bounded." }],
            },
          },
        },
      } as PiTaskBridgeEvent),
    ).toEqual([
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({
          taskId: "run-1",
          transcriptEvent: expect.objectContaining({
            managerId: "manager-1",
            sequence: 2,
            activity: expect.objectContaining({ type: "message_end" }),
          }),
        }),
      }),
    ]);
    expect(
      projectPiTaskBridgeEvent({
        ...base,
        kind: "terminal",
        view: { ...base.view, state: "done" },
      } as PiTaskBridgeEvent),
    ).toEqual([
      expect.objectContaining({
        type: "task.completed",
        payload: expect.objectContaining({
          status: "completed",
          typedUsage: expect.objectContaining({ totalTokens: 17, durationMs: 250 }),
        }),
      }),
    ]);
    expect(
      projectPiTaskBridgeEvent({
        ...base,
        kind: "killed",
        view: {
          ...base.view,
          state: "failed",
          result: { reason: "Stopped by the manager" },
        },
      } as PiTaskBridgeEvent),
    ).toEqual([
      expect.objectContaining({
        type: "task.completed",
        payload: expect.objectContaining({
          status: "failed",
          summary: "Stopped by the manager",
        }),
      }),
    ]);
  });
});
