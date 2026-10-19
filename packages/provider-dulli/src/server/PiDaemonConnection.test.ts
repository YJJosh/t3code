import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  ProjectId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Layer from "effect/Layer";
import { makeDulliAdapterV2 } from "./adapter.ts";
import { DulliBridgeRegistry } from "./bridges.ts";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  makePiDaemonConnection,
  piDaemonSkipKey,
  skipPiDaemon,
  isPiDaemonSkipped,
} from "./PiDaemonConnection.ts";
import type { PiRpcRecord } from "./rpc.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const frame = (message: unknown) => {
  const payload = Buffer.from(encode(message));
  const result = Buffer.alloc(payload.length + 5);
  result.writeUInt32BE(payload.length + 1);
  result[4] = 1;
  payload.copy(result, 5);
  return result;
};
const fixture = Effect.fn(function* (
  openError?: string,
  startup: PiRpcRecord = { type: "agent_start" },
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "pi-share-" });
  yield* fs.writeFileString(`${home}/native.jsonl`, "");
  const rejections = new Map<string, string>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const closed = yield* Deferred.make<void>();
  const sockets = new Set<NodeNet.Socket>();
  let rpc: NodeNet.Socket | undefined;
  let created = 0;
  const writers = new Map<string, NodeNet.Socket>();
  let maxWriters = 0;
  const server = NodeNet.createServer((socket) => {
    rpc = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    let sessionFile = "";
    socket.on("close", () => {
      if (writers.get(sessionFile) === socket) writers.delete(sessionFile);
      sockets.delete(socket);
      Deferred.doneUnsafe(closed, Effect.void);
    });
    let buffer = Buffer.alloc(0);
    socket.on("data", (bytes) => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
        const length = buffer.readUInt32BE(0);
        const request = decode(buffer.subarray(5, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        Queue.offerUnsafe(requests, request);
        if (request.type === "hello")
          socket.write(
            frame({
              type: "response",
              id: request.id,
              ok: true,
              result: { protocol: 1, version: "test", pid: 42 },
            }),
          );
        if (request.type === "rpc-open") {
          sessionFile =
            typeof request.sessionFile === "string"
              ? request.sessionFile
              : `${home}/${created++ === 0 ? "native" : `native-${created}`}.jsonl`;
          if (request.sessionFile === `${home}/native.jsonl` && created === 0) created = 1;
          const error =
            openError ?? (writers.has(sessionFile) ? "Session is open elsewhere" : undefined);
          if (!error) {
            writers.set(sessionFile, socket);
            maxWriters = Math.max(maxWriters, writers.size);
          }
          socket.write(
            frame({
              type: "response",
              id: request.id,
              ok: !error,
              ...(error ? { error } : { result: { pid: 43, sessionId: "native", started: false } }),
            }),
          );
          if (!error) socket.write(frame({ type: "rpc-out", message: startup }));
        }
        if (request.type === "rpc-in") {
          const message = request.message as PiRpcRecord;
          const command = String(message.type);
          // Independent copy of the terminal host's public command surface.
          // Unsupported RPC must fail, not silently mimic standalone Pi.
          const supported = [
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
          ];
          if (command === "extension_ui_response") continue;
          const error =
            rejections.get(command) ??
            (supported.includes(command)
              ? undefined
              : `Unknown command: ${command} (not available in a chat shared with the terminal)`);
          rejections.delete(command);
          socket.write(
            frame({
              type: "rpc-out",
              message: {
                type: "response",
                id: message.id,
                command,
                success: !error,
                ...(error
                  ? { error }
                  : {
                      data:
                        command === "get_state"
                          ? { sessionFile }
                          : command === "get_messages"
                            ? { messages: [{ role: "user", content: "Native history" }] }
                            : {},
                    }),
              },
            }),
          );
        }
      }
    });
  });
  yield* Effect.addFinalizer(() =>
    Effect.callback<void>((resume) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resume(Effect.void));
    }),
  );
  yield* Effect.callback<void>((resume) => {
    server.listen(`${home}/daemon.sock`, () => resume(Effect.void));
  });
  const input = {
    command: "pi",
    args: ["--mode", "rpc", "--profile", "coder"],
    cwd: home,
    threadId: "t3-thread",
    env: {
      PI_SESSIONS_HOME: home,
      PI_SESSIONS_T3_ENVIRONMENT: "env",
      PI_SUBAGENTS_RPC_BRIDGE: "1",
      PI_BACKGROUND_TERMINALS_RPC_BRIDGE: "1",
      CLAUDE_AGENT_SDK_RPC_BRIDGE: "1",
    },
  };
  return {
    home,
    input,
    requests,
    closed,
    maxWriters: () => maxWriters,
    rejectNext: (command: string, error: string) =>
      Effect.sync(() => rejections.set(command, error)),
    push: (message: PiRpcRecord) => Effect.sync(() => rpc!.write(frame(message))),
  };
});

it.layer(NodeServices.layer)("PiDaemonConnection", (it) => {
  it.effect(
    "attaches with native file identity, replays in order, correlates data, detaches without kill",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const opened = yield* makePiDaemonConnection(f.input, {
            attach: true,
            sessionFile: `${f.home}/native.jsonl`,
          });
          expect(opened.started).toBe(false);
          expect((yield* Queue.take(f.requests)).type).toBe("hello");
          const request = yield* Queue.take(f.requests);
          expect(request).toMatchObject({
            type: "rpc-open",
            attach: true,
            sessionFile: `${f.home}/native.jsonl`,
            t3: { thread: "t3-thread", environment: "env" },
          });
          const launch = request.launch as { args: string[]; env: Record<string, string> };
          expect(launch.args).not.toContain("--mode");
          expect(launch.env).not.toHaveProperty("PI_SUBAGENTS_RPC_BRIDGE");
          expect(launch.env).not.toHaveProperty("CLAUDE_AGENT_SDK_RPC_BRIDGE");
          expect(yield* Queue.take(opened.connection.events)).toEqual({ type: "agent_start" });
          expect(yield* opened.connection.request({ type: "get_state" })).toEqual({
            sessionFile: `${f.home}/native.jsonl`,
          });
          expect((yield* Queue.take(f.requests)).type).toBe("rpc-in");
          yield* opened.connection.terminate;
          yield* Deferred.await(f.closed);
          expect(yield* Queue.size(f.requests)).toBe(0);
        }).pipe(Effect.scoped);
      }).pipe(Effect.scoped),
  );
  it.effect("reports daemon open-elsewhere as an error, never starts another writer", () =>
    Effect.gen(function* () {
      const f = yield* fixture("Session is open elsewhere");
      const exit = yield* Effect.flip(makePiDaemonConnection(f.input));
      expect(exit.operation).toBe("daemon-open");
      expect(exit.detail).toContain("open elsewhere");
    }).pipe(Effect.scoped),
  );
  it.effect("fails RPC rejections and marks the queue closed on session exit", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { connection } = yield* makePiDaemonConnection(f.input);
      for (const command of [
        "new_session",
        "switch_session",
        "get_entries",
        "get_session_stats",
        "compact",
        "fork",
      ]) {
        const error = yield* Effect.flip(connection.request({ type: command }).pipe(Effect.asVoid));
        expect(error).toMatchObject({
          _tag: "PiRpcError",
          detail: `${command}: Unknown command: ${command} (not available in a chat shared with the terminal)`,
        });
        expect(error.message).toContain(`Unknown command: ${command}`);
      }
      yield* f.push({ type: "rpc-exit", code: 4 });
      expect(yield* connection.exited).toBe(4);
      expect((yield* Effect.flip(connection.send({ type: "get_state" }))).operation).toBe(
        "daemon-exit",
      );
    }).pipe(Effect.scoped),
  );
  it.effect("suppresses only one home/binary for ten minutes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const f = yield* fixture();
      const key = piDaemonSkipKey(f.input, path);
      expect(yield* isPiDaemonSkipped(key)).toBe(false);
      yield* skipPiDaemon(key);
      expect(yield* isPiDaemonSkipped(key)).toBe(true);
      expect(
        yield* isPiDaemonSkipped(piDaemonSkipKey({ ...f.input, command: "other" }, path)),
      ).toBe(false);
      yield* TestClock.adjust("10 minutes");
      expect(yield* isPiDaemonSkipped(key)).toBe(false);
    }).pipe(Effect.scoped),
  );
});

const adapterLayers = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
it.layer(adapterLayers)("Dulli shared adapter", (it) => {
  it.effect(
    "opens a shared session, buffers startup state and leaves terminal model untouched on attach",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(undefined, {
          type: "pi_sessions_state",
          model: { provider: "native", id: "terminal" },
          thinkingLevel: "high",
        });
        const seen: PiRpcRecord[] = [];
        const stopReasons: string[] = [];
        const adapter = yield* makeDulliAdapterV2({
          instanceId: ProviderInstanceId.make("dulli"),
          settings: {
            enabled: true,
            binaryPath: "pi",
            profile: "coder",
            agentDir: f.home,
            piSessions: true,
            shareWithTerminal: true,
            customModels: [],
          },
          environment: f.input.env,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("must not spawn an owned process")),
          ),
          Effect.provideService(DulliBridgeRegistry, [
            () =>
              Effect.succeed({
                onStop: (reason) =>
                  Effect.sync(() => {
                    stopReasons.push(reason);
                  }),
                events: [
                  {
                    type: "pi_sessions_state",
                    handle: (event) =>
                      Effect.sync(() => {
                        seen.push(event);
                      }),
                  },
                ],
              }),
          ]),
        );
        const selection = { instanceId: ProviderInstanceId.make("dulli"), model: "t3/model" };
        const runtimePolicy = {
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          cwd: f.home,
        };
        yield* Effect.gen(function* () {
          const runtime = yield* adapter.openSession({
            threadId: ThreadId.make("shared"),
            providerSessionId: ProviderSessionId.make("shared-session"),
            modelSelection: selection,
            runtimePolicy,
            attachOnly: true,
            initialNativeThreadId: `${f.home}/native.jsonl`,
          });
          expect(seen).toHaveLength(0);
          yield* f.rejectNext("get_state", "Pi is not ready yet");
          const failed = yield* Effect.flip(
            runtime.ensureThread({
              threadId: ThreadId.make("shared"),
              modelSelection: selection,
              runtimePolicy,
            }),
          );
          expect(String(failed.cause)).toContain("get_state: Pi is not ready yet");
          const thread = yield* runtime.ensureThread({
            threadId: ThreadId.make("shared"),
            modelSelection: selection,
            runtimePolicy,
          });
          expect(thread.nativeThreadRef?.nativeId).toBe(`${f.home}/native.jsonl`);
          expect(seen).toContainEqual({
            type: "pi_sessions_state",
            model: { provider: "native", id: "terminal" },
            thinkingLevel: "high",
          });
          // PiSessionsSync attaches/resumes first; ProviderTurnStart resumes
          // the same runtime again. Neither operation changes native history.
          for (let i = 0; i < 2; i++) {
            const resumed = yield* runtime.resumeThread({ providerThread: thread });
            expect(resumed.nativeThreadRef).toEqual(thread.nativeThreadRef);
          }
          const snapshot = yield* runtime.readThreadSnapshot({ providerThread: thread });
          expect(snapshot.messages[0]?.text).toBe("Native history");
          expect(yield* runtime.hasPendingBackgroundWork!).toBe(true);
        }).pipe(Effect.scoped);
        yield* Deferred.await(f.closed);
        expect(stopReasons).toEqual(["detached"]);
        expect(f.maxWriters()).toBe(1);
        const requests = yield* Queue.takeAll(f.requests);
        expect(requests.filter((request) => request.type === "rpc-open")).toHaveLength(1);
        const commands = requests
          .filter((request) => request.type === "rpc-in")
          .map((request) => (request.message as PiRpcRecord).type);
        for (const command of ["switch_session", "new_session", "get_entries", "get_session_stats"])
          expect(commands).not.toContain(command);
        expect(
          requests
            .filter((request) => request.type === "rpc-in")
            .map((request) => (request.message as PiRpcRecord).type),
        ).not.toContain("set_model");
        expect(
          requests
            .filter((request) => request.type === "rpc-in")
            .map((request) => (request.message as PiRpcRecord).type),
        ).not.toContain("abort");
      }).pipe(Effect.scoped),
  );
  it.effect.each([false, true])(
    "completes then resumes a later shared run (daemon attach: %s), without echoing terminal prompts",
    (attachOnly) =>
      Effect.gen(function* () {
        const f = yield* fixture(undefined, {
          type: "pi_sessions_state",
          model: { provider: "native", id: "terminal" },
        });
        const instanceId = ProviderInstanceId.make("dulli");
        const threadId = ThreadId.make("shared-live");
        const selection = { instanceId, model: "native/terminal" };
        const runtimePolicy = {
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          cwd: f.home,
        };
        const adapter = yield* makeDulliAdapterV2({
          instanceId,
          settings: {
            enabled: true,
            binaryPath: "pi",
            profile: "coder",
            agentDir: f.home,
            piSessions: true,
            shareWithTerminal: true,
            customModels: [],
          },
          environment: f.input.env,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("must not spawn")),
          ),
        );
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("live-session"),
          modelSelection: selection,
          runtimePolicy,
          ...(attachOnly
            ? { attachOnly: true, initialNativeThreadId: `${f.home}/native.jsonl` }
            : {}),
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: selection,
          runtimePolicy,
        });
        yield* f.push({
          type: "rpc-out",
          message: {
            type: "message_end",
            piSessionsOrigin: "terminal",
            message: { role: "user", content: "/terminal-only-command" },
          },
        });
        while (true) {
          const event = yield* Queue.take(events);
          if (event.type !== "message.updated") continue;
          expect(event.message).toMatchObject({
            role: "user",
            runId: null,
            text: "/terminal-only-command",
          });
          break;
        }
        const now = yield* DateTime.now;
        const turnInput: ProviderAdapter.ProviderAdapterV2TurnInput = {
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project"),
            title: "Shared",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: instanceId,
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt"),
          rootNodeId: NodeId.make("root"),
          providerThread,
          message: {
            messageId: MessageId.make("t3-message"),
            text: "T3 prompt",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: selection,
          runtimePolicy,
        };
        expect(runtime.providerSession.capabilities.threads).toMatchObject({
          canRollbackThread: false,
          canForkThread: false,
          canForkFromTurn: false,
        });
        expect((yield* adapter.getCapabilities()).threads.canRollbackThread).toBe(false);
        const compactError = yield* Effect.flip(runtime.compactThread!(turnInput));
        expect(String(compactError.cause)).toContain("Run /compact in the terminal instead");
        yield* f.rejectNext("set_model", "Model not found: native/missing");
        const modelError = yield* Effect.flip(
          runtime.startTurn({
            ...turnInput,
            modelSelection: { ...selection, model: "native/missing" },
          }),
        );
        expect(String(modelError.cause)).toContain("set_model: Model not found: native/missing");
        // Rejected model/compact requests must not leave an active turn or
        // pretend the model changed. A normal run can still start afterward.
        expect(runtime.providerSession.model).toBe("native/terminal");
        yield* runtime.startTurn(turnInput);
        yield* f.push({
          type: "rpc-out",
          message: {
            type: "message_end",
            piSessionsOrigin: "terminal",
            message: { role: "user", content: "Terminal follow-up" },
          },
        });
        yield* f.push({ type: "rpc-out", message: { type: "agent_settled" } });
        const observed: ProviderAdapter.ProviderAdapterV2Event[] = [];
        while (true) {
          const event = yield* Queue.take(events);
          observed.push(event);
          if (event.type === "turn.terminal") break;
        }
        expect(observed).toContainEqual(
          expect.objectContaining({
            type: "message.updated",
            message: expect.objectContaining({
              role: "user",
              text: "Terminal follow-up",
              creationSource: "provider",
            }),
          }),
        );
        expect(observed.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        const resumed = yield* runtime.resumeThread({ providerThread });
        yield* runtime.startTurn({
          ...turnInput,
          providerThread: resumed,
          runId: RunId.make("run-2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("attempt-2"),
        });
        yield* f.push({ type: "rpc-out", message: { type: "agent_settled", aborted: true } });
        while (true) {
          const event = yield* Queue.take(events);
          if (event.type !== "turn.terminal") continue;
          expect(event.status).toBe("interrupted");
          break;
        }
        expect(f.maxWriters()).toBe(1);
        const requests = yield* Queue.takeAll(f.requests);
        expect(requests.filter((request) => request.type === "rpc-open")).toHaveLength(1);
        const commands = requests
          .filter((request) => request.type === "rpc-in")
          .map((request) => (request.message as PiRpcRecord).type);
        for (const command of ["switch_session", "new_session", "get_entries", "get_session_stats"])
          expect(commands).not.toContain(command);
        const prompts = requests.filter(
          (request) =>
            request.type === "rpc-in" && (request.message as PiRpcRecord).type === "prompt",
        );
        expect(prompts).toHaveLength(2);
      }).pipe(Effect.scoped),
  );
  it.effect("detaches and rpc-opens a different file or new chat without another writer", () =>
    Effect.gen(function* () {
      const f = yield* fixture(undefined, { type: "pi_sessions_state" });
      const instanceId = ProviderInstanceId.make("dulli");
      const threadId = ThreadId.make("rebind");
      const selection = { instanceId, model: "default" };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: f.home,
      };
      const adapter = yield* makeDulliAdapterV2({
        instanceId,
        settings: {
          enabled: true,
          binaryPath: "pi",
          profile: "coder",
          agentDir: f.home,
          piSessions: true,
          shareWithTerminal: true,
          customModels: [],
        },
        environment: f.input.env,
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("must not spawn another writer")),
        ),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("rebind"),
        modelSelection: selection,
        runtimePolicy,
        initialNativeThreadId: `${f.home}/native.jsonl`,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const original = yield* runtime.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy,
      });
      const fs = yield* FileSystem.FileSystem;
      const otherFile = `${f.home}/other.jsonl`;
      yield* fs.writeFileString(otherFile, "");
      const different = yield* runtime.resumeThread({
        providerThread: {
          ...original,
          nativeThreadRef: { ...original.nativeThreadRef!, nativeId: otherFile },
        },
      });
      expect(different.nativeThreadRef?.nativeId).toBe(otherFile);
      const fresh = yield* runtime.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy,
      });
      expect(fresh.nativeThreadRef?.nativeId).not.toBe(otherFile);
      expect(fresh.nativeThreadRef?.nativeId).not.toBe(original.nativeThreadRef?.nativeId);
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread: fresh });
      expect(snapshot.messages[0]?.text).toBe("Native history");
      // Draining through the snapshot proves the replacement event pump works.
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "provider_thread.updated" && event.providerThread.id === fresh.id) break;
      }
      expect(f.maxWriters()).toBe(1);
      const requests = yield* Queue.takeAll(f.requests);
      const opens = requests.filter((request) => request.type === "rpc-open");
      expect(opens).toHaveLength(3);
      expect(opens[1]?.sessionFile).toBe(otherFile);
      expect(opens[2]).not.toHaveProperty("sessionFile");
      const commands = requests
        .filter((request) => request.type === "rpc-in")
        .map((request) => (request.message as PiRpcRecord).type);
      expect(commands).not.toContain("switch_session");
      expect(commands).not.toContain("new_session");
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    { error: "Session is open elsewhere", expectedSpawns: 0 },
    { error: "ordinary failure", expectedSpawns: 1 },
    { error: "Pi did not start in time", expectedSpawns: 1 },
  ])("uses the owned fallback only when safe: $error", ({ error, expectedSpawns }) =>
    Effect.gen(function* () {
      const f = yield* fixture(error);
      let spawns = 0;
      const adapter = yield* makeDulliAdapterV2({
        instanceId: ProviderInstanceId.make("dulli"),
        settings: {
          enabled: true,
          binaryPath: "pi",
          profile: "coder",
          agentDir: f.home,
          piSessions: true,
          shareWithTerminal: true,
          customModels: [],
        },
        environment: f.input.env,
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              spawns++;
            }).pipe(Effect.andThen(Effect.die("fake owned spawn reached"))),
          ),
        ),
      );
      const open = adapter.openSession({
        threadId: ThreadId.make("shared"),
        providerSessionId: ProviderSessionId.make("shared-session"),
        modelSelection: { instanceId: ProviderInstanceId.make("dulli"), model: "t3/model" },
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: f.home },
      });
      yield* Effect.exit(open.pipe(Effect.scoped));
      expect(spawns).toBe(expectedSpawns);
      if (error.includes("did not start in time")) {
        yield* Effect.exit(open.pipe(Effect.scoped));
        expect(spawns).toBe(2);
        const requests = yield* Queue.takeAll(f.requests);
        expect(requests.filter((request) => request.type === "rpc-open")).toHaveLength(1);
      }
    }).pipe(Effect.scoped),
  );
});
