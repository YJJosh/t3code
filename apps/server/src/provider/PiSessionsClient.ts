import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { connectPiSessions, piSessionsHome, piSessionsSocketPath } from "./PiSessionsSocket.ts";

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
    Schema.Struct({ thread: Schema.NonEmptyString, environment: Schema.optional(Schema.String) }),
  ),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  settledAt: Schema.optional(Schema.Finite),
  settleRev: Schema.optional(Schema.Finite),
  live: Schema.Boolean,
  attached: Schema.Int,
});
export type PiSessionInfo = typeof ThreadInfo.Type;
const decodeThread = Schema.decodeUnknownOption(ThreadInfo);
export class PiSessionsClient extends Context.Service<
  PiSessionsClient,
  {
    readonly watch: (
      onThreads: (threads: ReadonlyArray<PiSessionInfo>) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly link: (input: {
      sessionId: string;
      t3: { thread: string; environment: string };
    }) => Effect.Effect<void>;
    /** No autostart. An unavailable or incompatible daemon is indistinguishable from no extension. */
    readonly list: Effect.Effect<ReadonlyArray<PiSessionInfo> | null>;
    /** Conflicts, unsupported requests and timeouts leave reconciliation for the next round. */
    readonly settle: (input: {
      readonly sessionId: string;
      readonly settled: boolean;
      readonly ifRev: number;
    }) => Effect.Effect<PiSessionInfo | null>;
  }
>()("t3/provider/PiSessionsClient") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const socketPath = piSessionsSocketPath(environment, path, platform);
  let active: AwaitedConnection | undefined;
  const request = (message: object) =>
    Effect.gen(function* () {
      const connection = active ?? (yield* connectPiSessions(socketPath, "control"));
      return yield* connection.request(message);
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => null),
    );
  const decodeList = (response: unknown) =>
    Array.isArray(response)
      ? response.flatMap((entry: unknown) => {
          const decoded = decodeThread(entry);
          return Option.isSome(decoded) ? [decoded.value] : [];
        })
      : null;
  const list = request({ type: "list", includeSettled: true }).pipe(Effect.map(decodeList));
  const settle: PiSessionsClient["Service"]["settle"] = (input) =>
    request({ type: "settle", ...input }).pipe(
      Effect.map((response) => {
        const decoded = decodeThread(response);
        return Option.isSome(decoded) &&
          decoded.value.sessionId === input.sessionId &&
          decoded.value.settleRev !== undefined &&
          (decoded.value.settledAt !== undefined) === input.settled
          ? decoded.value
          : null;
      }),
    );
  const link: PiSessionsClient["Service"]["link"] = (input) =>
    request({ type: "link", ...input }).pipe(Effect.asVoid);
  const watch: PiSessionsClient["Service"]["watch"] = (onThreads) =>
    Effect.gen(function* () {
      let delay = 250;
      while (true) {
        yield* Effect.gen(function* () {
          const wake = yield* Queue.sliding<void>(1);
          // Re-resolve after each disconnect: the package may create its home while
          // we are watching an ancestor. Subsequent attempts watch the actual home.
          let directory = piSessionsHome(environment, path);
          while (
            !(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => true))) &&
            path.dirname(directory) !== directory
          )
            directory = path.dirname(directory);
          yield* fs.watch(directory).pipe(
            Stream.runForEach(() => Queue.offer(wake, undefined)),
            Effect.ignore,
            Effect.forkScoped,
          );
          yield* Effect.gen(function* () {
            const connection = yield* connectPiSessions(socketPath, "control");
            active = connection;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (active === connection) active = undefined;
              }),
            );
            const initial = decodeList(yield* connection.request({ type: "watch-threads" }));
            if (initial === null) return;
            delay = 250;
            yield* onThreads(initial);
            while (true) {
              const event = yield* Queue.take(connection.events);
              if (event.type === "transport.closed") return;
              if (event.type !== "threads") continue;
              const threads = decodeList(event.threads);
              if (threads) yield* onThreads(threads);
            }
          }).pipe(Effect.scoped, Effect.ignore);
          // Only retry a lost socket; never refresh a connected daemon's list.
          yield* Queue.take(wake).pipe(Effect.raceFirst(Effect.sleep(delay)));
        }).pipe(Effect.scoped);
        delay = Math.min(delay * 2, 30_000);
      }
    });
  return PiSessionsClient.of({ list, settle, link, watch });
});
type AwaitedConnection = Effect.Success<ReturnType<typeof connectPiSessions>>;
export const layer = Layer.effect(PiSessionsClient, make);
