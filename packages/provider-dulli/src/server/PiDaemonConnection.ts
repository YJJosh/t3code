import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { connectPiSessions, piSessionsHome, piSessionsSocketPath } from "./PiSessionsSocket.ts";
import { isPiSessionsDaemonMissing, startPiSessionsDaemon } from "./PiSessionsStart.ts";
import {
  PiRpcError,
  PiRpcTimeoutError,
  type PiRpcConnection,
  type PiRpcSpawnOptions,
  type PiRpcRecord,
} from "./rpc.ts";

const skipped = new Map<string, number>();
export const piDaemonSkipKey = (input: PiRpcSpawnOptions, path: Path.Path) =>
  `${piSessionsHome(input.env, path)}\0${input.command}`;
export const isPiDaemonSkipped = (key: string) =>
  Effect.map(Clock.currentTimeMillis, (now) => (skipped.get(key) ?? 0) > now);
export const skipPiDaemon = (key: string) =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    skipped.set(key, now + 10 * 60_000);
  });
const isRecord = (value: unknown): value is PiRpcRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Native framed RPC. Closing or terminating only detaches; the terminal owns Pi. */
export const makePiDaemonConnection = Effect.fn("PiDaemonConnection.make")(function* (
  input: PiRpcSpawnOptions & {
    readonly threadId: string;
    /** Arguments that stay in front of Pi's own, such as a scope wrapper, kept across /reloadx. */
    readonly commandPrefix?: ReadonlyArray<string>;
  },
  options: { readonly attach?: boolean; readonly sessionFile?: string } = {},
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const socketPath = piSessionsSocketPath(input.env, path, platform);
  const transport = yield* connectPiSessions(socketPath, "rpc").pipe(
    Effect.catchIf(
      (cause) => !options.attach && isPiSessionsDaemonMissing(cause),
      (cause) =>
        startPiSessionsDaemon(input.env, path, platform).pipe(
          Effect.flatMap((started) =>
            started ? connectPiSessions(socketPath, "rpc") : Effect.fail(cause),
          ),
        ),
    ),
    Effect.mapError((cause) => new PiRpcError({ operation: "daemon-connect", cause })),
  );
  const env = Object.fromEntries(
    Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const key of [
    "CLAUDE_AGENT_SDK_RPC_BRIDGE",
    "PI_SUBAGENTS_RPC_BRIDGE",
    "PI_BACKGROUND_TERMINALS_RPC_BRIDGE",
    "PI_BACKGROUND_THREADS_RPC_BRIDGE",
  ])
    delete env[key];
  const args = [...input.args];
  const mode = args.indexOf("--mode");
  if (mode >= 0) args.splice(mode, 2);
  const resume = args.indexOf("--session");
  const session = options.sessionFile ?? (resume >= 0 ? args[resume + 1] : undefined);
  if (options.sessionFile && resume < 0) args.push("--session", options.sessionFile);
  const opened = yield* transport
    .request(
      {
        type: "rpc-open",
        ...(options.attach ? { attach: true } : {}),
        ...(session
          ? path.isAbsolute(session)
            ? { sessionFile: session }
            : { sessionId: session }
          : {}),
        launch: {
          command: [input.command, ...(input.commandPrefix ?? [])],
          args,
          cwd: input.cwd,
          env,
        },
        t3: {
          thread: input.threadId,
          ...(env.PI_SESSIONS_T3_ENVIRONMENT
            ? { environment: env.PI_SESSIONS_T3_ENVIRONMENT }
            : {}),
        },
        // T3 answers the shared chat's select/confirm dialogs and clears a card on
        // `pi_sessions_ui_closed`. Older pi-sessions ignore it and keep the terminal notice.
        features: ["ui-dialogs"],
      },
      65_000,
    )
    .pipe(
      Effect.mapError(
        (cause) => new PiRpcError({ operation: "daemon-open", detail: cause.detail, cause }),
      ),
    );
  if (!isRecord(opened) || typeof opened.pid !== "number" || typeof opened.sessionId !== "string")
    return yield* new PiRpcError({
      operation: "daemon-open",
      detail: "Invalid Pi sessions rpc-open response",
    });
  const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
  const exited = yield* Deferred.make<number, PiRpcError>();
  const pending = new Map<
    string,
    { command: string; waiter: Deferred.Deferred<unknown, PiRpcError> }
  >();
  let sequence = 0;
  let failure: PiRpcError | undefined;
  const fail = Effect.fn("PiDaemonConnection.fail")(function* (error: PiRpcError, code = -1) {
    if (failure) return;
    failure = error;
    for (const { waiter } of pending.values()) yield* Deferred.fail(waiter, error);
    pending.clear();
    yield* Deferred.succeed(exited, code);
    yield* Queue.fail(events, error);
  });
  yield* Effect.gen(function* () {
    while (true) {
      const frame = yield* Queue.take(transport.events);
      if (frame.type === "rpc-exit" || frame.type === "transport.closed") {
        yield* fail(
          new PiRpcError({ operation: "daemon-exit" }),
          typeof frame.code === "number" ? frame.code : -1,
        );
        return;
      }
      if (frame.type !== "rpc-out" || !isRecord(frame.message)) continue;
      const message = frame.message;
      if (message.type === "response" && typeof message.id === "string") {
        const entry = pending.get(message.id);
        if (entry) {
          const { waiter, command } = entry;
          pending.delete(message.id);
          yield* message.success === true
            ? Deferred.succeed(waiter, message.data)
            : Deferred.fail(
                waiter,
                new PiRpcError({
                  operation: "daemon-request",
                  detail: `${command}: ${String(message.error ?? "Pi rejected the command")}`,
                  cause: message.error,
                }),
              );
          continue;
        }
      }
      yield* Queue.offer(events, message);
    }
  }).pipe(Effect.forkScoped);
  const send: PiRpcConnection["send"] = (message) =>
    Effect.suspend(() =>
      failure
        ? Effect.fail(failure)
        : transport
            .send({ type: "rpc-in", message })
            .pipe(Effect.mapError((cause) => new PiRpcError({ operation: "daemon-send", cause }))),
    );
  const request: PiRpcConnection["request"] = Effect.fn("PiDaemonConnection.request")(function* (
    record,
    timeoutMs = 30_000,
  ) {
    const id = `t3-${input.threadId}-${++sequence}`;
    const waiter = yield* Deferred.make<unknown, PiRpcError>();
    pending.set(id, { command: String(record.type), waiter });
    return yield* send({ ...record, id }).pipe(
      Effect.andThen(Deferred.await(waiter)),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(new PiRpcTimeoutError({ operation: String(record.type), timeoutMs })),
      }),
      Effect.ensuring(Effect.sync(() => pending.delete(id))),
    );
  });
  return {
    connection: {
      send,
      request,
      events,
      exited: Deferred.await(exited),
      terminate: transport.close.pipe(
        Effect.andThen(fail(new PiRpcError({ operation: "detach" }))),
      ),
    } satisfies PiRpcConnection,
    started: opened.started === true,
  };
});
