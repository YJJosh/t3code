import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import { makePiDaemonConnection } from "./PiDaemonConnection.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(
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
const decodeSettings = Schema.decodeSync(PiSettings);
const threadId = ThreadId.make("shared-thread");
const fixture = Effect.fn(function* (openError?: string, panels = true, replay = false) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "pi-share-" });
  const requests = yield* Queue.unbounded<Record<string, unknown>>();
  const closed = yield* Deferred.make<void>();
  const sockets = new Set<NodeNet.Socket>();
  let rpc: NodeNet.Socket | undefined;
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    rpc = socket;
    socket.on("error", () => {});
    socket.on("close", () => {
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
        const respond = (result: unknown) =>
          socket.write(frame({ type: "response", id: request.id, ok: true, result }));
        if (request.type === "hello") respond({ protocol: 1, version: "0.1", pid: 42 });
        if (request.type === "rpc-open") {
          if (openError)
            socket.write(frame({ type: "response", id: request.id, ok: false, error: openError }));
          else
            respond({
              threadId: "daemon-thread",
              sessionId: "session",
              sessionFile: "/sessions/session.jsonl",
              pid: 123,
            });
        }
        if (request.type === "rpc-open" && !openError && replay) {
          socket.write(frame({ type: "rpc-out", message: { type: "agent_start" } }));
          socket.write(
            frame({
              type: "rpc-out",
              message: {
                type: "message_update",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Already working" }],
                },
              },
            }),
          );
        }
        if (request.type === "rpc-in") {
          const command = request.message as Record<string, unknown>;
          if (command.type === "no-reply") continue;
          const data =
            command.type === "get_state"
              ? {
                  sessionId: "session",
                  sessionFile: "/sessions/session.jsonl",
                  model: { provider: "test", id: "model" },
                  thinkingLevel: "low",
                }
              : command.type === "get_commands"
                ? {
                    commands: panels
                      ? [
                          { name: "background-terminals-rpc", source: "extension" },
                          { name: "subagents-rpc", source: "extension" },
                        ]
                      : [],
                  }
                : { disposition: "started" };
          socket.write(
            frame({
              type: "rpc-out",
              message: {
                type: "response",
                id: command.id,
                command: command.type,
                success: true,
                data,
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
  const send = (message: unknown) =>
    Effect.sync(() => {
      rpc!.write(frame(message));
    });
  return {
    home,
    requests,
    closed: Deferred.await(closed),
    send,
    disconnect: Effect.sync(() => rpc!.destroy()),
  };
});
const env = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(env)("shared Pi", (it) => {
  it.effect("opens/resumes interactive Pi, correlates RPC, streams and exits in order", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const messages = yield* Queue.unbounded<unknown>();
      const connection = yield* makePiDaemonConnection({
        threadId,
        binaryPath: "/bin/pi",
        args: ["--mode", "rpc", "--session", "/sessions/session.jsonl"],
        cwd: process.cwd(),
        env: {
          PI_SESSIONS_HOME: f.home,
          PI_SESSIONS_T3_ENVIRONMENT: "env",
          CLAUDE_AGENT_SDK_RPC_BRIDGE: "1",
        },
        onMessage: (message) => Queue.offer(messages, message).pipe(Effect.asVoid),
        onParseFailure: () => Effect.void,
      });
      expect(yield* Queue.take(f.requests)).toMatchObject({ type: "hello", role: "rpc" });
      expect(yield* Queue.take(f.requests)).toMatchObject({
        type: "rpc-open",
        sessionFile: "/sessions/session.jsonl",
        t3: { thread: threadId, environment: "env" },
        launch: { args: ["--session", "/sessions/session.jsonl"] },
      });
      expect(connection.pid).toBe(123);
      expect((yield* connection.request({ type: "get_state" })).success).toBe(true);
      yield* Queue.take(messages);
      yield* f.send({ type: "rpc-out", message: { type: "agent_start" } });
      yield* f.send({ type: "rpc-exit", code: 0, reason: "the thread stopped" });
      expect(yield* Queue.take(messages)).toEqual({ type: "agent_start" });
      expect(yield* connection.awaitExit).toBe(0);
      expect((yield* connection.request({ type: "abort" }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("treats an unexpected socket close as exit", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const connection = yield* makePiDaemonConnection({
        threadId,
        binaryPath: "pi",
        args: ["--mode", "rpc"],
        cwd: process.cwd(),
        env: { PI_SESSIONS_HOME: f.home },
        onMessage: () => Effect.void,
        onParseFailure: () => Effect.void,
      });
      yield* f.disconnect;
      expect(yield* connection.awaitExit).toBe(-1);
    }).pipe(Effect.scoped),
  );

  it.effect("replays an in-progress turn only after the session is initialized", () =>
    Effect.gen(function* () {
      const f = yield* fixture(undefined, false, true);
      const adapter = yield* makePiAdapter(decodeSettings({}), {
        environment: { PI_SESSIONS_HOME: f.home },
      }).pipe(
        Effect.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            spawn: () => Effect.die("unexpected own-RPC spawn"),
          }),
        ),
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const observed: ProviderRuntimeEvent[] = [];
      while (true) {
        const event = yield* Queue.take(events);
        observed.push(event);
        if (event.type === "content.delta") {
          expect(event.payload.delta).toBe("Already working");
          break;
        }
      }
      expect(observed.findIndex((event) => event.type === "session.started")).toBeLessThan(
        observed.findIndex((event) => event.type === "turn.started"),
      );
      yield* f.send({
        type: "rpc-out",
        message: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Already working, now done" }],
            stopReason: "stop",
          },
        },
      });
      yield* f.send({ type: "rpc-out", message: { type: "agent_settled" } });
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.completed") {
          expect(event.payload.state).toBe("completed");
          break;
        }
      }
    }).pipe(Effect.scoped),
  );

  for (const mode of [
    "shared",
    "no-panels",
    "off",
    "unavailable",
    "conflict",
    "failure",
  ] as const) {
    it.effect(`selects transport: ${mode}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          mode === "conflict"
            ? "this Pi session is open elsewhere (held by classic Pi)"
            : mode === "failure"
              ? "Pi did not start in time"
              : undefined,
          mode !== "no-panels",
        );
        let spawns = 0;
        const adapter = yield* makePiAdapter(
          decodeSettings({ shareWithTerminal: mode !== "off" }),
          {
            environmentId: "env",
            environment: { PI_SESSIONS_HOME: mode === "unavailable" ? `${f.home}/absent` : f.home },
          },
        ).pipe(
          Effect.provide(
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
              spawn: () =>
                Effect.sync(() => {
                  spawns++;
                }).pipe(Effect.andThen(Effect.die("fake own-RPC spawn"))),
            }),
          ),
        );
        const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const result = yield* adapter
          .startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" })
          .pipe(Effect.exit);
        if (mode !== "shared" && mode !== "no-panels") {
          expect(result._tag).toBe("Failure");
          expect(spawns).toBe(mode === "conflict" ? 0 : 1);
          return;
        }
        expect(result._tag).toBe("Success");
        expect(spawns).toBe(0);
        expect(yield* Queue.take(f.requests)).toMatchObject({ type: "hello" });
        const open = yield* Queue.take(f.requests);
        const launch = open.launch as { env: Record<string, string> };
        expect(launch.env.CLAUDE_AGENT_SDK_RPC_BRIDGE).toBeUndefined();
        expect(launch.env.PI_SUBAGENTS_RPC_BRIDGE).toBeUndefined();
        const commands = [];
        for (let i = 0; i < (mode === "no-panels" ? 2 : 4); i++)
          commands.push((yield* Queue.take(f.requests)).message);
        if (mode === "no-panels") {
          expect(commands).toEqual([
            expect.objectContaining({ type: "get_state" }),
            expect.objectContaining({ type: "get_commands" }),
          ]);
          yield* adapter.stopSession(threadId);
          yield* f.closed;
          return;
        }
        expect(commands).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "get_state" }),
            expect.objectContaining({
              type: "prompt",
              message: '/background-terminals-rpc {"action":"replay"}',
            }),
            expect.objectContaining({
              type: "prompt",
              message: '/subagents-rpc {"action":"replay"}',
            }),
          ]),
        );
        yield* adapter.sendTurn({
          threadId,
          input: "from T3",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "test/selected",
            options: [{ id: "reasoning", value: "high" }],
          },
        });
        yield* adapter.interruptTurn(threadId);
        const sent = [];
        for (let i = 0; i < 4; i++) sent.push((yield* Queue.take(f.requests)).message);
        expect(sent).toEqual([
          expect.objectContaining({ type: "set_model", provider: "test", modelId: "selected" }),
          expect.objectContaining({ type: "set_thinking_level", level: "high" }),
          expect.objectContaining({ type: "prompt", message: "from T3" }),
          expect.objectContaining({ type: "abort" }),
        ]);
        yield* f.send({ type: "rpc-out", message: { type: "agent_settled" } });
        for (const origin of ["terminal", "extension", "rpc"]) {
          yield* f.send({ type: "rpc-out", message: { type: "agent_start" } });
          yield* f.send({
            type: "rpc-out",
            message: {
              type: "message_start",
              piSessionsOrigin: origin,
              message: { role: "user", content: origin },
            },
          });
          yield* f.send({
            type: "rpc-out",
            message: {
              type: "message_end",
              piSessionsOrigin: origin,
              message: { role: "user", content: origin },
            },
          });
          yield* f.send({ type: "rpc-out", message: { type: "agent_settled" } });
        }
        yield* f.send({ type: "rpc-out", message: { type: "agent_start" } });
        yield* f.send({
          type: "rpc-out",
          message: {
            type: "message_end",
            piSessionsOrigin: "terminal",
            message: {
              role: "user",
              content: [{ type: "image", data: "AA", mimeType: "image/png" }],
            },
          },
        });
        yield* f.send({ type: "rpc-out", message: { type: "agent_settled" } });
        yield* f.send({
          type: "rpc-out",
          message: {
            type: "pi_sessions_ui_prompt",
            phase: "start",
            kind: "select",
            title: "Choose profile",
          },
        });
        yield* f.send({
          type: "rpc-out",
          message: { type: "pi_sessions_ui_prompt", phase: "end" },
        });
        yield* f.send({
          type: "rpc-out",
          message: {
            type: "pi_sessions_state",
            model: { provider: "test", id: "new" },
            thinkingLevel: "high",
          },
        });
        yield* f.send({ type: "rpc-exit", code: 0 });
        const observed: ProviderRuntimeEvent[] = [];
        while (true) {
          const event = yield* Queue.take(events);
          observed.push(event);
          if (event.type === "session.exited") break;
        }
        expect(
          observed
            .filter(
              (event) =>
                event.type === "item.completed" && event.payload.itemType === "user_message",
            )
            .map((event) => event.payload),
        ).toEqual([
          { itemType: "user_message", data: { text: "terminal", external: true } },
          { itemType: "user_message", data: { text: "extension", external: true } },
          {
            itemType: "user_message",
            data: { text: "[Image sent from Pi; view it in the terminal]", external: true },
          },
        ]);
        expect(observed.filter((event) => event.type === "turn.started")).toHaveLength(5);
        expect(
          observed.find((event) => event.type === "user-input.requested")?.payload,
        ).toMatchObject({ responseMode: "terminal" });
        expect(observed.filter((event) => event.type === "user-input.resolved")).toHaveLength(1);
        expect(
          observed.filter((event) => event.type === "thread.metadata.updated").at(-1)?.payload,
        ).toMatchObject({
          modelSelection: { model: "test/new", options: [{ id: "reasoning", value: "high" }] },
        });
      }).pipe(Effect.scoped),
    );
  }
});
