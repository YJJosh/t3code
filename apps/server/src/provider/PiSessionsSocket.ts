import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import type * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

class PiSessionsSocketError extends Schema.TaggedError<PiSessionsSocketError>()(
  "PiSessionsSocketError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

export function piSessionsHome(env: NodeJS.ProcessEnv, path: Path.Path) {
  return env.PI_SESSIONS_HOME || path.join(NodeOS.homedir(), ".pi", "pi-sessions");
}
export function piSessionsSocketPath(
  env: NodeJS.ProcessEnv,
  path: Path.Path,
  platform: NodeJS.Platform,
) {
  const home = piSessionsHome(env, path);
  return platform === "win32"
    ? `\\\\.\\pipe\\pi-sessions-${NodeCrypto.createHash("sha256").update(`${NodeOS.userInfo().username}\0${home}`).digest("hex").slice(0, 16)}`
    : path.join(home, "daemon.sock");
}
const isSocketError = Schema.is(PiSessionsSocketError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const MAX_FRAME = 16 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Scoped local connection. Disconnecting never kills the daemon's Pi. */
export const connectPiSessions = Effect.fn(function* (socketPath: string, role: "control" | "rpc") {
  const connected = yield* Deferred.make<void, PiSessionsSocketError>();
  const events = yield* Queue.unbounded<Record<string, unknown>>();
  const pending = new Map<number, Deferred.Deferred<unknown, PiSessionsSocketError>>();
  let sequence = 0;
  let failure: PiSessionsSocketError | undefined;
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = NodeNet.createConnection(socketPath);
      let buffer = Buffer.alloc(0);
      const fail = (cause?: unknown) => {
        if (failure) return;
        Queue.offerUnsafe(events, { type: "transport.closed" });
        failure = new PiSessionsSocketError({ detail: "Pi sessions connection closed.", cause });
        Deferred.doneUnsafe(connected, Effect.fail(failure));
        for (const waiter of pending.values()) Deferred.doneUnsafe(waiter, Effect.fail(failure));
        pending.clear();
        socket.destroy();
      };
      socket.on("connect", () => Deferred.doneUnsafe(connected, Effect.void));
      socket.on("error", fail);
      socket.on("close", () => fail());
      socket.on("data", (chunk) => {
        try {
          buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
          while (buffer.length >= 4) {
            const length = buffer.readUInt32BE(0);
            if (length < 1 || length > MAX_FRAME)
              throw new Error("Invalid Pi sessions frame length");
            if (buffer.length < length + 4) return;
            const kind = buffer[4];
            const payload = buffer.subarray(5, length + 4);
            buffer = buffer.subarray(length + 4);
            if (kind === 2) continue;
            if (kind !== 1) throw new Error("Invalid Pi sessions frame kind");
            const message: unknown = decodeJson(payload.toString("utf8"));
            if (!isRecord(message) || typeof message.type !== "string")
              throw new Error("Invalid Pi sessions message");
            if (message.type === "response") {
              if (typeof message.id !== "number" || typeof message.ok !== "boolean")
                throw new Error("Invalid Pi sessions response");
              const waiter = pending.get(message.id);
              if (waiter) {
                pending.delete(message.id);
                Deferred.doneUnsafe(
                  waiter,
                  message.ok
                    ? Effect.succeed(message.result)
                    : Effect.fail(
                        new PiSessionsSocketError({
                          detail:
                            typeof message.error === "string"
                              ? message.error
                              : "Pi sessions request rejected.",
                        }),
                      ),
                );
              }
            } else Queue.offerUnsafe(events, message);
          }
        } catch (cause) {
          fail(cause);
        }
      });
      return socket;
    }),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      }),
  );
  const send = (message: object) =>
    Effect.try({
      try: () => {
        if (failure) throw failure;
        const payload = Buffer.from(encodeJson(message));
        if (payload.length + 1 > MAX_FRAME) throw new Error("Pi sessions frame too large");
        const frame = Buffer.allocUnsafe(payload.length + 5);
        frame.writeUInt32BE(payload.length + 1);
        frame[4] = 1;
        payload.copy(frame, 5);
        socket.write(frame);
      },
      catch: (cause) =>
        isSocketError(cause)
          ? cause
          : new PiSessionsSocketError({ detail: "Failed to write to Pi sessions.", cause }),
    });
  const request = (message: object, timeoutMs = 3_000) =>
    Effect.gen(function* () {
      const id = ++sequence;
      const waiter = yield* Deferred.make<unknown, PiSessionsSocketError>();
      pending.set(id, waiter);
      const response = yield* send({ ...message, id }).pipe(
        Effect.andThen(Deferred.await(waiter)),
        Effect.timeoutOption(timeoutMs),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
      if (Option.isNone(response))
        return yield* new PiSessionsSocketError({ detail: "Pi sessions request timed out." });
      return response.value;
    });
  const ready = yield* Deferred.await(connected).pipe(Effect.timeoutOption("1 second"));
  if (Option.isNone(ready))
    return yield* new PiSessionsSocketError({ detail: "Pi sessions connection timed out." });
  const hello = yield* request({ type: "hello", protocol: 1, role, pid: process.pid });
  if (
    !isRecord(hello) ||
    hello.protocol !== 1 ||
    typeof hello.version !== "string" ||
    typeof hello.pid !== "number"
  )
    return yield* new PiSessionsSocketError({ detail: "Incompatible Pi sessions daemon." });
  return { send, request, events };
});
