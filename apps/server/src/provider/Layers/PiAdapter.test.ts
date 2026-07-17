import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type PiBackgroundTerminalEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { PiSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { parseJsonlLine, serializeJsonlLine } from "../pi/piJsonl.ts";
import {
  PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX,
  PI_SUBAGENTS_RPC_EVENT_PREFIX,
} from "../pi/piRpcProtocol.ts";
import { makePiAdapter, splitPiModelSlug } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeUnknownJsonStringSync = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Captured {
  command?: string | undefined;
  args?: ReadonlyArray<string> | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
}

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly captured: Captured;
  readonly written: ReadonlyArray<Record<string, unknown>>;
  readonly pushFrame: (frame: unknown) => Effect.Effect<void>;
  /** Blocks until a stdin command matching `predicate` is written. */
  readonly takeStdinUntil: (
    predicate: (command: Record<string, unknown>) => boolean,
  ) => Effect.Effect<Record<string, unknown>>;
  readonly killed: Effect.Effect<boolean>;
}

const makeFakePi = Effect.fn("makeFakePi")(function* (input?: {
  readonly subagentsCommand?: boolean;
  readonly backgroundTerminalsCommand?: boolean;
  readonly backgroundTerminalControlSuccess?: boolean;
  readonly backgroundTerminalStartupEvent?: boolean;
  readonly contextCommand?: boolean;
  readonly fastCommand?: boolean;
}) {
  const stdoutQueue = yield* Queue.unbounded<Uint8Array>();
  const stdinQueue = yield* Queue.unbounded<Record<string, unknown>>();
  const killedRef = yield* Ref.make(false);
  const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const captured: Captured = {};
  const written: Array<Record<string, unknown>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand") {
        captured.command = command.command;
        captured.args = command.args;
        captured.cwd = command.options.cwd as string | undefined;
        captured.env = command.options.env as Record<string, string> | undefined;
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(true),
        kill: () => Ref.set(killedRef, true),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const line = decoder.decode(chunk).trim();
          if (line.length === 0) return Effect.void;
          const parsed = parseJsonlLine(line);
          if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
            return Effect.void;
          }
          const command = parsed as Record<string, unknown>;
          return Effect.gen(function* () {
            written.push(command);
            yield* Queue.offer(stdinQueue, command);
            if (typeof command.id !== "string" || typeof command.type !== "string") return;
            if (command.type === "get_state" && input?.backgroundTerminalStartupEvent === true) {
              const encodedStartupEvent = encodeUnknownJsonStringSync({
                contractVersion: 1,
                managerId: "pi-background-terminals:startup",
                sequence: 1,
                timestamp: "2026-07-09T12:00:00.000Z",
                kind: "snapshot",
                snapshot: {
                  replay: true,
                  terminals: [
                    {
                      id: "bt-1",
                      command: "pnpm dev",
                      title: "startup terminal",
                      cwd: "/workspace",
                      pid: 123,
                      status: "running",
                      createdAt: 1_752_067_200_000,
                      stdout: { text: "ready", totalBytes: 5, truncatedBytes: 0 },
                      stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
                    },
                  ],
                },
              });
              yield* Queue.offer(
                stdoutQueue,
                encoder.encode(
                  serializeJsonlLine({
                    type: "extension_ui_request",
                    id: "background-terminal-startup",
                    method: "notify",
                    message: `${PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX}${encodedStartupEvent}`,
                    notifyType: "info",
                  }),
                ),
              );
            }
            yield* Queue.offer(
              stdoutQueue,
              encoder.encode(
                serializeJsonlLine({
                  id: command.id,
                  type: "response",
                  command: command.type,
                  success: true,
                  ...(command.type === "get_state"
                    ? { data: { sessionId: "pi-session-test" } }
                    : command.type === "get_commands"
                      ? {
                          data: {
                            commands: [
                              ...(input?.subagentsCommand === false
                                ? []
                                : [{ name: "subagents-rpc", source: "extension" }]),
                              ...(input?.backgroundTerminalsCommand === false
                                ? []
                                : [{ name: "background-terminals-rpc", source: "extension" }]),
                              ...(input?.contextCommand === true
                                ? [{ name: "context", source: "extension" }]
                                : []),
                              ...(input?.fastCommand === true
                                ? [{ name: "fast", source: "extension" }]
                                : []),
                            ],
                          },
                        }
                      : {}),
                }),
              ),
            );
            if (
              command.type === "prompt" &&
              typeof command.message === "string" &&
              command.message.startsWith("/background-terminals-rpc ")
            ) {
              const control = decodeUnknownJsonString(
                command.message.slice("/background-terminals-rpc ".length),
              ) as { readonly action: "replay" | "kill"; readonly request_id: string };
              const success = input?.backgroundTerminalControlSuccess !== false;
              const encodedControlEvent = encodeUnknownJsonStringSync({
                contractVersion: 1,
                managerId: "pi-background-terminals:test",
                sequence: written.length,
                timestamp: "2026-07-09T12:00:02.000Z",
                kind: "control_result",
                control: {
                  action: control.action,
                  requestId: control.request_id,
                  success,
                  ...(success ? {} : { error: "simulated control rejection" }),
                },
              });
              yield* Queue.offer(
                stdoutQueue,
                encoder.encode(
                  serializeJsonlLine({
                    type: "extension_ui_request",
                    id: `background-terminal-control-${written.length}`,
                    method: "notify",
                    message: `${PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX}${encodedControlEvent}`,
                    notifyType: "info",
                  }),
                ),
              );
            }
          });
        }),
        stdout: Stream.fromQueue(stdoutQueue),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const takeStdinUntil = (
    predicate: (command: Record<string, unknown>) => boolean,
  ): Effect.Effect<Record<string, unknown>> =>
    Queue.take(stdinQueue).pipe(
      Effect.flatMap((command) =>
        predicate(command) ? Effect.succeed(command) : takeStdinUntil(predicate),
      ),
    );

  return {
    spawner,
    captured,
    written,
    pushFrame: (frame: unknown) =>
      Queue.offer(stdoutQueue, encoder.encode(`${JSON.stringify(frame)}\n`)).pipe(Effect.asVoid),
    takeStdinUntil,
    killed: Ref.get(killedRef),
  } satisfies FakePi;
});

const TestEnv = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const INSTANCE = ProviderInstanceId.make("pi-1");
const settings = decodePiSettings({});

const takeEventOfType = (
  events: Queue.Dequeue<ProviderRuntimeEvent>,
  type: ProviderRuntimeEvent["type"],
): Effect.Effect<ProviderRuntimeEvent> =>
  Queue.take(events).pipe(
    Effect.flatMap((event) =>
      event.type === type ? Effect.succeed(event) : takeEventOfType(events, type),
    ),
  );

describe("splitPiModelSlug", () => {
  it("splits provider/model slugs and rejects malformed ones", () => {
    expect(splitPiModelSlug("anthropic/claude-sonnet-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    expect(splitPiModelSlug("noslash")).toBeUndefined();
    expect(splitPiModelSlug("/leading")).toBeUndefined();
    expect(splitPiModelSlug("trailing/")).toBeUndefined();
  });
});

describe("makePiAdapter", () => {
  it.effect("spawns `pi --mode rpc` with the right args, cwd and env, and maps a turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, {
        instanceId: INSTANCE,
        environment: { HOME: "/tmp/home" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));

      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );

      const threadId = ThreadId.make("11111111-1111-4111-8111-111111111111");
      const cwd = process.cwd();
      const modelSelection: ModelSelection = {
        instanceId: INSTANCE,
        model: "anthropic/claude-sonnet-5",
        options: [
          { id: "reasoning", value: "high" },
          { id: "profile", value: "research" },
        ],
      };

      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access", modelSelection });

      expect(fake.captured.command).toBe("pi");
      expect(fake.captured.args).toEqual([
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
      expect(fake.captured.cwd).toBe(cwd);
      expect(fake.captured.env?.HOME).toBe("/tmp/home");
      expect(fake.captured.env?.PI_CODING_AGENT_DIR).toBeUndefined();
      expect(fake.captured.env?.PI_SUBAGENTS_RPC_BRIDGE).toBe("1");
      expect(fake.written).toContainEqual(
        expect.objectContaining({
          type: "set_model",
          provider: "anthropic",
          modelId: "claude-sonnet-5",
        }),
      );

      expect((yield* Queue.take(events)).type).toBe("session.started");
      expect((yield* Queue.take(events)).type).toBe("session.state.changed");
      const threadStarted = yield* Queue.take(events);
      expect(threadStarted.type).toBe("thread.started");
      expect(
        threadStarted.type === "thread.started" && threadStarted.payload.providerThreadId,
      ).toBe("pi-session-test");

      const turn = yield* adapter.sendTurn({ threadId, input: "Hello Pi" });
      expect((yield* Queue.take(events)).type).toBe("turn.started");

      const prompt = yield* fake.takeStdinUntil((c) => c.type === "prompt");
      expect(prompt.message).toBe("Hello Pi");

      yield* fake.pushFrame({ type: "agent_start" });
      yield* fake.pushFrame({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      });
      yield* fake.pushFrame({ type: "agent_end", willRetry: false });

      expect((yield* Queue.take(events)).type).toBe("item.started");
      const delta = yield* Queue.take(events);
      expect(delta.type).toBe("content.delta");
      expect(delta.type === "content.delta" && delta.payload.delta).toBe("Hi there");

      const completed = yield* takeEventOfType(events, "turn.completed");
      expect(completed.type === "turn.completed" && completed.payload.state).toBe("completed");
      expect(completed.turnId).toBe(turn.turnId);
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("synchronizes Pi context and Codex Fast service before the user prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({ contextCommand: true, fastCommand: true });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const threadId = ThreadId.make("88888888-8888-4888-8888-888888888888");
      const fastSelection: ModelSelection = {
        instanceId: INSTANCE,
        model: "openai-codex/gpt-5.6-sol",
        options: [
          { id: "reasoning", value: "off" },
          { id: "contextWindow", value: "372k" },
          { id: "serviceTier", value: "priority" },
        ],
      };

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: fastSelection,
      });
      const enabled = yield* fake.takeStdinUntil(
        (command) => command.type === "prompt" && command.message === "/fast on",
      );
      expect(enabled.message).toBe("/fast on");
      const modelIndex = fake.written.findIndex((command) => command.type === "set_model");
      const thinkingIndex = fake.written.findIndex(
        (command) => command.type === "set_thinking_level" && command.level === "off",
      );
      const contextIndex = fake.written.findIndex(
        (command) => command.type === "prompt" && command.message === "/context 372k",
      );
      const fastIndex = fake.written.findIndex(
        (command) => command.type === "prompt" && command.message === "/fast on",
      );
      expect(modelIndex).toBeGreaterThanOrEqual(0);
      expect(thinkingIndex).toBeGreaterThan(modelIndex);
      expect(contextIndex).toBeGreaterThan(thinkingIndex);
      expect(fastIndex).toBeGreaterThan(contextIndex);

      yield* adapter.sendTurn({
        threadId,
        input: "Use the standard tier now",
        modelSelection: {
          ...fastSelection,
          options: [
            { id: "reasoning", value: "off" },
            { id: "contextWindow", value: "auto" },
            { id: "serviceTier", value: "default" },
          ],
        },
      });
      const disabled = yield* fake.takeStdinUntil(
        (command) => command.type === "prompt" && command.message === "/fast off",
      );
      expect(disabled.message).toBe("/fast off");
      const resetContextIndex = fake.written.findIndex(
        (command) => command.type === "prompt" && command.message === "/context auto",
      );
      const disableFastIndex = fake.written.findIndex(
        (command) => command.type === "prompt" && command.message === "/fast off",
      );
      expect(resetContextIndex).toBeGreaterThan(fastIndex);
      expect(disableFastIndex).toBeGreaterThan(resetContextIndex);
      const userPrompt = yield* fake.takeStdinUntil(
        (command) => command.type === "prompt" && command.message === "Use the standard tier now",
      );
      expect(userPrompt.message).toBe("Use the standard tier now");
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("drops stale profile options when the live Pi profile lacks their commands", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      const threadId = ThreadId.make("77777777-7777-4777-8777-777777777777");
      const staleSelection: ModelSelection = {
        instanceId: INSTANCE,
        model: "openai-codex/gpt-5.6-sol",
        options: [
          { id: "reasoning", value: "high" },
          { id: "contextWindow", value: "372k" },
          { id: "serviceTier", value: "priority" },
          { id: "profile", value: "without-effort-commands" },
        ],
      };

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: staleSelection,
      });

      expect(fake.captured.args).toContain("without-effort-commands");
      const contextWarning = yield* takeEventOfType(events, "runtime.warning");
      const fastWarning = yield* takeEventOfType(events, "runtime.warning");
      expect(
        contextWarning.type === "runtime.warning" ? contextWarning.payload.message : "",
      ).toContain("does not provide /context");
      expect(fastWarning.type === "runtime.warning" ? fastWarning.payload.message : "").toContain(
        "does not provide /fast",
      );
      expect(fake.written).not.toContainEqual(
        expect.objectContaining({ type: "prompt", message: "/context 372k" }),
      );
      expect(fake.written).not.toContainEqual(
        expect.objectContaining({ type: "prompt", message: "/fast on" }),
      );

      yield* adapter.sendTurn({
        threadId,
        input: "Continue without profile-specific options",
        modelSelection: staleSelection,
      });
      const prompt = yield* fake.takeStdinUntil(
        (command) =>
          command.type === "prompt" &&
          command.message === "Continue without profile-specific options",
      );
      expect(prompt.message).toBe("Continue without profile-specific options");
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("keeps opposite Fast tiers atomic with concurrent sends", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({ fastCommand: true });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const threadId = ThreadId.make("99999999-9999-4999-8999-999999999999");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: INSTANCE,
          model: "openai-codex/gpt-5.6-sol",
          options: [{ id: "reasoning", value: "high" }],
        },
      });

      const selection = (serviceTier: "priority" | "default"): ModelSelection => ({
        instanceId: INSTANCE,
        model: "openai-codex/gpt-5.5",
        options: [
          { id: "reasoning", value: "high" },
          { id: "serviceTier", value: serviceTier },
        ],
      });
      yield* Effect.all(
        [
          adapter.sendTurn({
            threadId,
            input: "first-fast-prompt",
            modelSelection: selection("priority"),
          }),
          adapter.sendTurn({
            threadId,
            input: "second-standard-steer",
            modelSelection: selection("default"),
          }),
        ],
        { concurrency: "unbounded" },
      );

      const fastOnIndex = fake.written.findIndex(
        (command) => command.type === "prompt" && command.message === "/fast on",
      );
      const firstPromptIndex = fake.written.findIndex(
        (command) => command.type === "prompt" && command.message === "first-fast-prompt",
      );
      const fastOffIndex = fake.written.findIndex(
        (command, index) =>
          index > firstPromptIndex && command.type === "prompt" && command.message === "/fast off",
      );
      const secondPromptIndex = fake.written.findIndex(
        (command) => command.type === "steer" && command.message === "second-standard-steer",
      );
      expect(fastOnIndex).toBeGreaterThanOrEqual(0);
      expect(firstPromptIndex).toBeGreaterThan(fastOnIndex);
      expect(fastOffIndex).toBeGreaterThan(firstPromptIndex);
      expect(secondPromptIndex).toBeGreaterThan(fastOffIndex);
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("interrupt sends abort and completes the turn as cancelled", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      const threadId = ThreadId.make("22222222-2222-4222-8222-222222222222");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      const turn = yield* adapter.sendTurn({ threadId, input: "long task" });
      yield* fake.takeStdinUntil((c) => c.type === "prompt");
      yield* adapter.interruptTurn(threadId, turn.turnId);
      yield* fake.takeStdinUntil((c) => c.type === "abort");

      const completed = yield* takeEventOfType(events, "turn.completed");
      expect(completed.type === "turn.completed" && completed.payload.state).toBe("cancelled");
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("stopSession tears down the process and emits session.exited", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      const threadId = ThreadId.make("33333333-3333-4333-8333-333333333333");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      expect(yield* adapter.hasSession(threadId)).toBe(true);
      yield* adapter.stopSession(threadId);
      expect(yield* adapter.hasSession(threadId)).toBe(false);

      const exited = yield* takeEventOfType(events, "session.exited");
      expect(exited.type === "session.exited" && exited.payload.exitKind).toBe("graceful");
      expect(yield* fake.killed).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("rejects a turn with neither text nor attachments", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const threadId = ThreadId.make("44444444-4444-4444-8444-444444444444");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const error = yield* adapter.sendTurn({ threadId }).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterValidationError");
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("streams structured subagent events and sends direct replay controls", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const received = yield* Queue.unbounded<unknown>();
      yield* Stream.runForEach(adapter.subagents!.streamEvents, (event) =>
        Queue.offer(received, event),
      ).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("66666666-6666-4666-8666-666666666666");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      const envelope = {
        contractVersion: 1,
        managerId: "pi-subagents:test",
        sequence: 1,
        timestamp: "2026-07-09T12:00:00.000Z",
        kind: "control_result",
        control: { action: "replay", success: true, requestId: "replay-1" },
      } as const;
      const encodedEnvelope = yield* encodeUnknownJsonString(envelope);
      yield* fake.pushFrame({
        type: "extension_ui_request",
        id: "subagent-event-1",
        method: "notify",
        message: `${PI_SUBAGENTS_RPC_EVENT_PREFIX}${encodedEnvelope}`,
        notifyType: "info",
      });
      expect(yield* Queue.take(received)).toEqual({ threadId, event: envelope });

      yield* adapter.subagents!.control({
        threadId,
        action: "replay",
        requestId: "replay-2",
      });
      const control = yield* fake.takeStdinUntil(
        (command) =>
          command.type === "prompt" &&
          typeof command.message === "string" &&
          command.message.startsWith("/subagents-rpc "),
      );
      expect(control.message).toContain('"action":"replay"');
      expect(control.message).toContain('"request_id":"replay-2"');
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("never forwards subagent controls as prompts when the extension is unavailable", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({ subagentsCommand: false });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const threadId = ThreadId.make("77777777-7777-4777-8777-777777777777");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      const error = yield* adapter
        .subagents!.control({ threadId, action: "replay", requestId: "replay-missing" })
        .pipe(Effect.flip);

      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("not installed");
      expect(fake.written.some((command) => command.type === "get_commands")).toBe(true);
      expect(fake.written.some((command) => command.type === "prompt")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("publishes the process reset before an extension startup snapshot", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({ backgroundTerminalStartupEvent: true });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const received = yield* Queue.unbounded<{
        readonly threadId: ThreadId;
        readonly event: PiBackgroundTerminalEvent;
      }>();
      yield* Stream.runForEach(adapter.backgroundTerminals!.streamEvents, (event) =>
        Queue.offer(received, event),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      const reset = yield* Queue.take(received);
      const startup = yield* Queue.take(received);
      expect(reset.event).toMatchObject({ kind: "snapshot", snapshot: { terminals: [] } });
      expect(startup.event).toMatchObject({
        managerId: "pi-background-terminals:startup",
        kind: "snapshot",
        snapshot: { terminals: [{ id: "bt-1", title: "startup terminal" }] },
      });
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("streams background-terminal events and sends advertised direct controls", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const received = yield* Queue.unbounded<unknown>();
      yield* Stream.runForEach(adapter.backgroundTerminals!.streamEvents, (event) =>
        Queue.offer(received, event),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("88888888-8888-4888-8888-888888888888");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const reset = (yield* Queue.take(received)) as {
        readonly threadId: ThreadId;
        readonly event: PiBackgroundTerminalEvent;
      };
      expect(reset.threadId).toBe(threadId);
      expect(reset.event).toMatchObject({
        contractVersion: 1,
        sequence: 1,
        kind: "snapshot",
        snapshot: { terminals: [] },
      });
      expect(reset.event.managerId).toMatch(/^pi-session-/);
      const envelope = {
        contractVersion: 1,
        managerId: "pi-background-terminals:test",
        sequence: 1,
        timestamp: "2026-07-09T12:00:00.000Z",
        kind: "control_result",
        control: { action: "replay", success: true, requestId: "replay-1" },
      } as const;
      const encodedEnvelope = yield* encodeUnknownJsonString(envelope);
      yield* fake.pushFrame({
        type: "extension_ui_request",
        id: "terminal-event-1",
        method: "notify",
        message: `${PI_BACKGROUND_TERMINALS_RPC_EVENT_PREFIX}${encodedEnvelope}`,
        notifyType: "info",
      });
      expect(yield* Queue.take(received)).toEqual({ threadId, event: envelope });
      yield* adapter.backgroundTerminals!.control({
        threadId,
        action: "kill",
        terminalId: "bt-1",
        requestId: "kill-1",
      });
      const control = yield* fake.takeStdinUntil(
        (command) =>
          command.type === "prompt" &&
          typeof command.message === "string" &&
          command.message.startsWith("/background-terminals-rpc "),
      );
      expect(control.message).toContain('"action":"kill"');
      expect(control.message).toContain('"terminal_id":"bt-1"');

      yield* adapter.backgroundTerminals!.control({ threadId, action: "replay" });
      yield* fake.takeStdinUntil(
        (command) =>
          command.type === "prompt" &&
          typeof command.message === "string" &&
          command.message.startsWith("/background-terminals-rpc ") &&
          command.message.includes('"action":"replay"'),
      );
      expect(fake.written.filter((command) => command.type === "get_commands")).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("surfaces a rejected background-terminal control result", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi({ backgroundTerminalControlSuccess: false });
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const threadId = ThreadId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      const error = yield* adapter
        .backgroundTerminals!.control({ threadId, action: "replay", requestId: "rejected-control" })
        .pipe(Effect.flip);

      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.message).toContain("simulated control rejection");
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect(
    "never forwards background-terminal control when its extension command is unavailable",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi({ backgroundTerminalsCommand: false });
        const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
        );
        const threadId = ThreadId.make("99999999-9999-4999-8999-999999999999");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const error = yield* adapter
          .backgroundTerminals!.control({ threadId, action: "replay" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ProviderAdapterValidationError");
        expect(fake.written.some((command) => command.type === "prompt")).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );

  it.effect("auto-confirms an extension_ui confirm request in yolo mode", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi();
      const adapter = yield* makePiAdapter(settings, { instanceId: INSTANCE }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      const threadId = ThreadId.make("55555555-5555-4555-8555-555555555555");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "do it" });
      yield* fake.takeStdinUntil((c) => c.type === "prompt");

      yield* fake.pushFrame({
        type: "extension_ui_request",
        id: "ui-1",
        method: "confirm",
        title: "Proceed?",
        message: "sure?",
      });

      const response = yield* fake.takeStdinUntil((c) => c.type === "extension_ui_response");
      expect(response).toMatchObject({ id: "ui-1", confirmed: true });
    }).pipe(Effect.scoped, Effect.provide(TestEnv)),
  );
});
