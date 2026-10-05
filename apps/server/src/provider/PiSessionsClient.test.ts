import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as PiSessionsClient from "./PiSessionsClient.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      id: Schema.Int,
      includeSettled: Schema.optional(Schema.Boolean),
      protocol: Schema.optional(Schema.Int),
      role: Schema.optional(Schema.String),
      sessionId: Schema.optional(Schema.String),
      settled: Schema.optional(Schema.Boolean),
      ifRev: Schema.optional(Schema.Finite),
    }),
  ),
);
const frame = (value: unknown, kind = 1) => {
  const payload = Buffer.from(encode(value));
  const bytes = Buffer.alloc(payload.length + 5);
  bytes.writeUInt32BE(payload.length + 1);
  bytes[4] = kind;
  payload.copy(bytes, 5);
  return bytes;
};
const hello = {
  type: "response",
  id: 1,
  ok: true,
  result: { protocol: 1, version: "0.1", pid: 42 },
};
const record = {
  sessionId: "session",
  cwd: "/project",
  status: "done",
  owner: "foreground",
  createdAt: 1,
  updatedAt: 2,
  live: false,
  attached: 0,
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "pi-sessions-" });
  const client = yield* PiSessionsClient.PiSessionsClient.pipe(
    Effect.provide(PiSessionsClient.layer),
    Effect.provideService(HostProcessEnvironment, { PI_SESSIONS_HOME: home }),
  );
  return { home, client };
});
const daemon = Effect.fn(function* (
  home: string,
  respond: (request: ReturnType<typeof decode>, socket: NodeNet.Socket) => void,
) {
  const requests = yield* Queue.unbounded<ReturnType<typeof decode>>();
  const closed = yield* Deferred.make<void>();
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      Deferred.doneUnsafe(closed, Effect.void);
    });
    let pending = Buffer.alloc(0);
    socket.on("data", (bytes) => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
        const length = pending.readUInt32BE(0);
        const request = decode(pending.subarray(5, 4 + length).toString());
        pending = pending.subarray(4 + length);
        Queue.offerUnsafe(requests, request);
        respond(request, socket);
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
  return { requests, closed };
});

it.layer(NodeServices.layer)("PiSessionsClient", (it) => {
  it.effect(
    "handles fragmented/coalesced frames, raw data, notifications, and malformed list entries",
    () =>
      Effect.gen(function* () {
        const { home, client } = yield* fixture;
        const server = yield* daemon(home, (request, socket) => {
          if (request.type === "hello") {
            const bytes = frame(hello);
            socket.write(bytes.subarray(0, 2), () =>
              socket.write(bytes.subarray(2, 7), () => socket.write(bytes.subarray(7))),
            );
          } else
            socket.write(
              Buffer.concat([
                frame("terminal", 2),
                frame({ type: "summary" }),
                frame({
                  type: "response",
                  id: 2,
                  ok: true,
                  result: [
                    record,
                    { ...record, live: "no" },
                    { ...record, sessionId: "second", extra: true },
                  ],
                }),
              ]),
            );
        });
        expect(yield* client.list).toEqual([record, { ...record, sessionId: "second" }]);
        expect(yield* Queue.take(server.requests)).toMatchObject({
          type: "hello",
          id: 1,
          protocol: 1,
          role: "control",
        });
        expect(yield* Queue.take(server.requests)).toMatchObject({
          type: "list",
          id: 2,
          includeSettled: true,
        });
        yield* Deferred.await(server.closed);
      }).pipe(Effect.scoped),
  );

  for (const mode of ["zero", "oversized", "json", "mismatch", "error", "bad-list"] as const) {
    it.effect(`treats ${mode} as no compatible daemon`, () =>
      Effect.gen(function* () {
        const { home, client } = yield* fixture;
        yield* daemon(home, (request, socket) => {
          if (mode === "bad-list")
            socket.write(
              frame(request.id === 1 ? hello : { type: "response", id: 2, ok: true, result: {} }),
            );
          else if (mode === "zero" || mode === "oversized") {
            const header = Buffer.alloc(4);
            header.writeUInt32BE(mode === "zero" ? 0 : 16 * 1024 * 1024 + 1);
            socket.write(header);
          } else if (mode === "json") socket.write(Buffer.from([0, 0, 0, 2, 1, 123]));
          else
            socket.write(
              frame(
                mode === "error"
                  ? { type: "response", id: 1, ok: false, error: "protocol mismatch" }
                  : { ...hello, result: { protocol: 2, version: "0.2", pid: 1 } },
              ),
            );
        });
        expect(yield* client.list).toBeNull();
      }).pipe(Effect.scoped),
    );
  }

  it.effect("retries an absent daemon on the next refresh", () =>
    Effect.gen(function* () {
      const { home, client } = yield* fixture;
      expect(yield* client.list).toBeNull();
      yield* daemon(home, (request, socket) =>
        socket.write(
          frame(request.id === 1 ? hello : { type: "response", id: 2, ok: true, result: [] }),
        ),
      );
      expect(yield* client.list).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("times out a stalled handshake and closes the socket", () =>
    Effect.gen(function* () {
      const { home, client } = yield* fixture;
      const server = yield* daemon(home, () => {});
      const fiber = yield* client.list.pipe(Effect.forkScoped);
      yield* Queue.take(server.requests);
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(fiber)).toBeNull();
      yield* Deferred.await(server.closed);
    }).pipe(Effect.scoped),
  );

  it.effect("times out a stalled list after a compatible handshake", () =>
    Effect.gen(function* () {
      const { home, client } = yield* fixture;
      const server = yield* daemon(home, (request, socket) => {
        if (request.type === "hello") socket.write(frame(hello));
      });
      const fiber = yield* client.list.pipe(Effect.forkScoped);
      yield* Queue.take(server.requests);
      expect((yield* Queue.take(server.requests)).type).toBe("list");
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(fiber)).toBeNull();
      yield* Deferred.await(server.closed);
    }).pipe(Effect.scoped),
  );

  for (const mode of ["success", "conflict", "timeout"] as const) {
    it.effect(`settle request: ${mode}`, () =>
      Effect.gen(function* () {
        const { home, client } = yield* fixture;
        const updated = { ...record, settledAt: 3, settleRev: 7 };
        const server = yield* daemon(home, (request, socket) => {
          if (request.type === "hello") socket.write(frame(hello));
          else if (mode !== "timeout")
            socket.write(
              frame(
                mode === "success"
                  ? { type: "response", id: 2, ok: true, result: updated }
                  : {
                      type: "response",
                      id: 2,
                      ok: false,
                      error: "settle conflict: the thread changed (revision 7)",
                    },
              ),
            );
        });
        const fiber = yield* client
          .settle({ sessionId: "session", settled: true, ifRev: 6 })
          .pipe(Effect.forkScoped);
        yield* Queue.take(server.requests);
        expect(yield* Queue.take(server.requests)).toEqual({
          type: "settle",
          id: 2,
          sessionId: "session",
          settled: true,
          ifRev: 6,
        });
        if (mode === "timeout") yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(fiber)).toEqual(mode === "success" ? updated : null);
        yield* Deferred.await(server.closed);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("cancellation closes an in-flight request", () =>
    Effect.gen(function* () {
      const { home, client } = yield* fixture;
      const server = yield* daemon(home, () => {});
      const fiber = yield* client.list.pipe(Effect.forkScoped);
      yield* Queue.take(server.requests);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(server.closed);
    }).pipe(Effect.scoped),
  );
});
