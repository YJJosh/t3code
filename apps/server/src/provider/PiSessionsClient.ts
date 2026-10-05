import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ThreadInfo = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  sessionFile: Schema.optional(Schema.NonEmptyString),
  cwd: Schema.NonEmptyString,
  agentDir: Schema.optional(Schema.NonEmptyString),
  title: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  status: Schema.Literals(["new", "running", "waiting", "done", "interrupted"]),
  owner: Schema.Literals(["daemon", "foreground", "t3"]),
  t3: Schema.optional(
    Schema.Struct({ thread: Schema.String, environment: Schema.optional(Schema.String) }),
  ),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  settledAt: Schema.optional(Schema.Finite),
  live: Schema.Boolean,
  attached: Schema.Int,
});
export type PiSessionInfo = typeof ThreadInfo.Type;
const decodeThread = Schema.decodeUnknownOption(ThreadInfo);
const Response = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.Int,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
});
const decodeResponse = Schema.decodeUnknownOption(Response);
const decodeHello = Schema.decodeUnknownOption(
  Schema.Struct({ protocol: Schema.Literal(1), version: Schema.String, pid: Schema.Int }),
);
const MAX_FRAME = 16 * 1024 * 1024;

export class PiSessionsClient extends Context.Service<
  PiSessionsClient,
  {
    /** No autostart. An unavailable or incompatible daemon is indistinguishable from no extension. */
    readonly list: Effect.Effect<ReadonlyArray<PiSessionInfo> | null>;
  }
>()("t3/provider/PiSessionsClient") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const list = Effect.gen(function* () {
    const home = environment.PI_SESSIONS_HOME || path.join(NodeOS.homedir(), ".pi", "pi-sessions");
    const socketPath =
      platform === "win32"
        ? `\\\\.\\pipe\\pi-sessions-${NodeCrypto.createHash("sha256").update(`${NodeOS.userInfo().username}\0${home}`).digest("hex").slice(0, 16)}`
        : path.join(home, "daemon.sock");
    const connected = yield* Deferred.make<boolean>();
    const hello = yield* Deferred.make<unknown>();
    const listed = yield* Deferred.make<unknown>();
    let waitingFor = 0;
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = NodeNet.createConnection(socketPath);
        let buffer = Buffer.alloc(0);
        function fail() {
          Deferred.doneUnsafe(connected, Effect.succeed(false));
          Deferred.doneUnsafe(hello, Effect.succeed(null));
          Deferred.doneUnsafe(listed, Effect.succeed(null));
          socket.destroy();
        }
        socket.on("connect", () => Deferred.doneUnsafe(connected, Effect.succeed(true)));
        socket.on("error", fail);
        socket.on("close", fail);
        socket.on("data", (chunk) => {
          buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
          while (!socket.destroyed && buffer.length >= 4) {
            const length = buffer.readUInt32BE(0);
            if (length === 0 || length > MAX_FRAME) return fail();
            if (buffer.length < length + 4) return;
            const kind = buffer[4];
            const payload = buffer.subarray(5, length + 4);
            buffer = buffer.subarray(length + 4);
            if (kind === 2) continue;
            if (kind !== 1) return fail();
            const json = decodeJson(payload.toString("utf8"));
            if (Option.isNone(json)) return fail();
            const message = json.value;
            if (
              typeof message !== "object" ||
              message === null ||
              !("type" in message) ||
              typeof message.type !== "string"
            )
              return fail();
            if (message.type !== "response") continue;
            const response = decodeResponse(message);
            if (Option.isNone(response)) return fail();
            if (response.value.id !== waitingFor) continue;
            const target =
              response.value.id === 1 ? hello : response.value.id === 2 ? listed : undefined;
            if (target)
              Deferred.doneUnsafe(
                target,
                Effect.succeed(response.value.ok ? response.value.result : null),
              );
          }
        });
        return socket;
      }),
      (socket) =>
        Effect.sync(() => {
          socket.destroy();
        }),
    );
    const send = (id: number, message: object) =>
      Effect.sync(() => {
        waitingFor = id;
        const payload = Buffer.from(encodeJson({ ...message, id }));
        const frame = Buffer.alloc(5 + payload.length);
        frame.writeUInt32BE(payload.length + 1);
        frame[4] = 1;
        payload.copy(frame, 5);
        socket.write(frame);
      });
    const connection = yield* Deferred.await(connected).pipe(Effect.timeoutOption("1 second"));
    if (Option.isNone(connection) || !connection.value) return null;
    yield* send(1, { type: "hello", protocol: 1, role: "control", pid: process.pid });
    const handshake = yield* Deferred.await(hello).pipe(Effect.timeoutOption("3 seconds"));
    if (Option.isNone(handshake) || Option.isNone(decodeHello(handshake.value))) return null;
    yield* send(2, { type: "list", includeSettled: true });
    const response = yield* Deferred.await(listed).pipe(Effect.timeoutOption("3 seconds"));
    if (Option.isNone(response) || !Array.isArray(response.value)) return null;
    return response.value.flatMap((entry: unknown) => {
      const decoded = decodeThread(entry);
      return Option.isSome(decoded) ? [decoded.value] : [];
    });
  }).pipe(Effect.scoped);
  return PiSessionsClient.of({ list });
});

export const layer = Layer.effect(PiSessionsClient, make);
