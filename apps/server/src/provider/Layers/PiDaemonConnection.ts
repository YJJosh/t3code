import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { connectPiSessions, piSessionsSocketPath } from "../PiSessionsSocket.ts";
import type { PiRpcConnection, PiRpcConnectionInput, PiRpcResponse } from "./PiRpcConnection.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Same RPC contract as stdio, but scope close only detaches T3 from the shared Pi. */
export const makePiDaemonConnection = Effect.fn(function* (input: PiRpcConnectionInput) {
  const error = (detail: string, cause?: unknown) =>
    new ProviderAdapterProcessError({ provider: "pi", threadId: input.threadId, detail, cause });
  const path = yield* Path.Path;
  const transport = yield* connectPiSessions(
    piSessionsSocketPath(input.env, path, yield* HostProcessPlatform),
    "rpc",
  ).pipe(Effect.mapError((cause) => error(cause.detail, cause)));
  const env = Object.fromEntries(
    Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.CLAUDE_AGENT_SDK_RPC_BRIDGE;
  delete env.PI_SUBAGENTS_RPC_BRIDGE;
  delete env.PI_BACKGROUND_TERMINALS_RPC_BRIDGE;
  delete env.PI_BACKGROUND_THREADS_RPC_BRIDGE;
  const args = [...input.args];
  const mode = args.indexOf("--mode");
  if (mode >= 0) args.splice(mode, 2);
  const resume = args.indexOf("--session");
  const session = resume >= 0 ? args[resume + 1] : undefined;
  const opened = yield* transport
    .request(
      {
        type: "rpc-open",
        ...(session
          ? path.isAbsolute(session)
            ? { sessionFile: session }
            : { sessionId: session }
          : {}),
        launch: { command: [input.binaryPath], args, cwd: input.cwd, env },
        t3: {
          thread: input.threadId,
          ...(input.env.PI_SESSIONS_T3_ENVIRONMENT
            ? { environment: input.env.PI_SESSIONS_T3_ENVIRONMENT }
            : {}),
        },
      },
      65_000,
    )
    .pipe(Effect.mapError((cause) => error(cause.detail, cause)));
  if (!isRecord(opened) || typeof opened.pid !== "number" || typeof opened.sessionId !== "string")
    return yield* error("Invalid Pi sessions rpc-open response.");
  const exited = yield* Deferred.make<number>();
  const pending = new Map<string, Deferred.Deferred<PiRpcResponse, ProviderAdapterProcessError>>();
  let sequence = 0;
  let exitError: ProviderAdapterProcessError | undefined;
  yield* Effect.gen(function* () {
    while (true) {
      const frame = yield* Queue.take(transport.events);
      if (frame.type === "rpc-exit" || frame.type === "transport.closed") {
        exitError = error(
          typeof frame.reason === "string" ? frame.reason : "Pi sessions connection closed.",
        );
        for (const waiter of pending.values()) yield* Deferred.fail(waiter, exitError);
        pending.clear();
        yield* Deferred.succeed(exited, typeof frame.code === "number" ? frame.code : -1);
        return;
      }
      if (frame.type !== "rpc-out") continue;
      const message = frame.message;
      if (
        isRecord(message) &&
        message.type === "response" &&
        typeof message.id === "string" &&
        typeof message.command === "string" &&
        typeof message.success === "boolean"
      ) {
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          yield* Deferred.succeed(waiter, message as unknown as PiRpcResponse);
        }
      }
      yield* input.onMessage(message);
    }
  }).pipe(Effect.forkScoped);
  const send: PiRpcConnection["send"] = (message) =>
    Effect.suspend(() =>
      exitError
        ? Effect.fail(exitError)
        : transport
            .send({ type: "rpc-in", message })
            .pipe(Effect.mapError((cause) => error(cause.detail, cause))),
    );
  const request: PiRpcConnection["request"] = (command, waitForDialog = false) =>
    Effect.gen(function* () {
      const id = `t3-${input.threadId}-${++sequence}`;
      const waiter = yield* Deferred.make<PiRpcResponse, ProviderAdapterProcessError>();
      pending.set(id, waiter);
      const result = yield* send({ ...command, id }).pipe(
        Effect.andThen(Deferred.await(waiter)),
        waitForDialog ? Effect.map(Option.some) : Effect.timeoutOption("30 seconds"),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
      if (Option.isNone(result))
        return yield* error(`Timed out waiting for Pi RPC '${command.type}' response.`);
      return result.value;
    });
  const connection: PiRpcConnection = {
    send,
    request,
    awaitExit: Deferred.await(exited),
    pid: opened.pid,
  };
  // false when T3 joined a Pi that was already running (for example in a terminal).
  return { connection, started: opened.started === true };
});
