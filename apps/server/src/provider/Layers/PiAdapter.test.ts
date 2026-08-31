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
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { parseJsonlLine, serializeJsonlLine } from "../pi/piJsonl.ts";
import {
  type PiTaskBridgeEvent,
  PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX,
} from "../pi/piRpcProtocol.ts";
import { makePiAdapter, projectPiTaskBridgeEvent, splitPiModelSlug } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const encodeBackgroundTerminalEvent = Schema.encodeSync(
  Schema.fromJsonString(PiBackgroundTerminalEventSchema),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly written: ReadonlyArray<Record<string, unknown>>;
  readonly pushFrame: (frame: unknown) => Effect.Effect<void>;
}

const makeFakePi = Effect.fn("makeFakePi")(function* (
  options: {
    readonly subagentsCommand?: boolean;
    readonly backgroundTerminalsCommand?: boolean;
  } = {},
) {
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const args: string[] = [];
  const env: Record<string, string> = {};
  const written: Array<Record<string, unknown>> = [];

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
          const response = {
            type: "response",
            id: request.id,
            command: request.type,
            success: true,
            ...(request.type === "get_state"
              ? { data: { sessionId: "pi-session-test" } }
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
                      ],
                    },
                  }
                : {}),
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
          const frames = [
            response,
            ...(backgroundControl === null
              ? []
              : [
                  {
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
                  },
                ]),
          ];
          return Effect.forEach(
            frames,
            (frame) => Queue.offer(stdout, encoder.encode(serializeJsonlLine(frame))),
            { discard: true },
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
    pushFrame: (frame) =>
      Queue.offer(stdout, encoder.encode(serializeJsonlLine(frame))).pipe(Effect.asVoid),
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

  it.effect("sends task controls through the advertised Pi extension command", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
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
          }),
        }),
      ],
    );
    expect(projectPiTaskBridgeEvent({ ...base, kind: "needs_input" } as PiTaskBridgeEvent)).toEqual(
      [
        expect.objectContaining({
          type: "task.updated",
          payload: expect.objectContaining({ status: "waiting" }),
        }),
      ],
    );
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
  });
});
