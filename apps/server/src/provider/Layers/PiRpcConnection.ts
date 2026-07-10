/**
 * PiRpcConnection — the long-lived `pi --mode rpc` subprocess transport.
 *
 * One connection == one Pi subprocess == one T3 thread/session. The process
 * lifetime is bound to the scope passed in `create`: when that scope closes,
 * the child is SIGTERM→SIGKILL'd and every reader/writer fiber is interrupted.
 *
 * Framing is strict LF-delimited JSONL (see `../pi/piJsonl.ts`) — we
 * deliberately do NOT use Node readline because Pi permits U+2028/U+2029 inside
 * JSON string payloads.
 *
 * @module provider/Layers/PiRpcConnection
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { ProviderAdapterProcessError } from "../Errors.ts";
import type { ThreadId } from "@t3tools/contracts";
import {
  createLfJsonlDecoder,
  JsonlParseFailure,
  parseJsonlLine,
  serializeJsonlLine,
} from "../pi/piJsonl.ts";
import type { PiExtensionUiResponse, PiRpcCommand } from "../pi/piRpcProtocol.ts";

export interface PiRpcResponse {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface PiRpcConnection {
  /** Send a command or extension-UI response as a single LF-framed JSONL line. */
  readonly send: (
    message: PiRpcCommand | PiExtensionUiResponse,
  ) => Effect.Effect<void, ProviderAdapterProcessError>;
  /** Send a correlated command and wait for its matching Pi response. */
  readonly request: (
    command: PiRpcCommand,
  ) => Effect.Effect<PiRpcResponse, ProviderAdapterProcessError>;
  /** Resolves with the process exit code (or -1 if it could not be observed). */
  readonly awaitExit: Effect.Effect<number>;
  readonly pid: number;
}

export interface PiRpcConnectionInput {
  readonly threadId: ThreadId;
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Called for each successfully parsed JSONL frame from stdout. */
  readonly onMessage: (message: unknown) => Effect.Effect<void>;
  /** Called with the raw line when a frame fails to parse as JSON. */
  readonly onParseFailure: (line: string) => Effect.Effect<void>;
}

const PROVIDER = "pi";
const encoder = new TextEncoder();

/**
 * Spawn the Pi RPC subprocess and wire its stdio. Must be run inside a
 * `Scope`; the process is torn down when that scope closes.
 */
export const makePiRpcConnection = (
  input: PiRpcConnectionInput,
): Effect.Effect<
  PiRpcConnection,
  ProviderAdapterProcessError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, [...input.args], {
      env: input.env,
    });

    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.cwd,
          env: input.env,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Failed to spawn Pi RPC process: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

    // Best-effort termination on scope close (kill also fires from the spawn
    // Command finalizer, but this guarantees the group is gone promptly).
    yield* Scope.addFinalizer(
      scope,
      child.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" }).pipe(Effect.ignore),
    );

    // stdin: a bounded-lifetime queue fed to the stdin sink by a scoped fiber.
    const stdinQueue = yield* Queue.unbounded<Uint8Array>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(stdinQueue));
    yield* Stream.fromQueue(stdinQueue).pipe(
      Stream.run(child.stdin),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    // stdout: strict LF JSONL decoding → correlated response settlement and
    // per-frame dispatch. Responses still reach onMessage for observability.
    const decoder = createLfJsonlDecoder();
    const pending = new Map<
      string,
      Deferred.Deferred<PiRpcResponse, ProviderAdapterProcessError>
    >();
    let requestSequence = 0;
    const handleMessage = (message: unknown) =>
      Effect.gen(function* () {
        if (
          message !== null &&
          typeof message === "object" &&
          (message as Record<string, unknown>).type === "response" &&
          typeof (message as Record<string, unknown>).id === "string"
        ) {
          const response = message as unknown as PiRpcResponse;
          const deferred = pending.get(response.id!);
          if (deferred) {
            pending.delete(response.id!);
            yield* Deferred.succeed(deferred, response).pipe(Effect.ignore);
          }
        }
        yield* input.onMessage(message);
      });
    const handleLine = (line: string) =>
      Effect.suspend(() => {
        const parsed = parseJsonlLine(line);
        if (parsed === undefined) return Effect.void;
        if (parsed === JsonlParseFailure) return input.onParseFailure(line);
        return handleMessage(parsed);
      });

    yield* child.stdout.pipe(
      Stream.runForEach((chunk) =>
        Effect.forEach(decoder.push(chunk), handleLine, { discard: true }),
      ),
      Effect.andThen(Effect.forEach(decoder.flush(), handleLine, { discard: true })),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    // stderr: retained (capped) for diagnostics on unexpected exit.
    const stderrRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.update(stderrRef, (current) => `${current}${chunk}`.slice(-8_192)),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    const send: PiRpcConnection["send"] = (message) =>
      Queue.offer(stdinQueue, encoder.encode(serializeJsonlLine(message))).pipe(
        Effect.asVoid,
        Effect.catchCause(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Failed to write to Pi RPC stdin.",
              cause,
            }),
        ),
      );

    const request: PiRpcConnection["request"] = (command) =>
      Effect.gen(function* () {
        const id = `t3-${input.threadId}-${++requestSequence}`;
        const deferred = yield* Deferred.make<PiRpcResponse, ProviderAdapterProcessError>();
        pending.set(id, deferred);
        const result = yield* send({ ...command, id } as PiRpcCommand).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOption("30 seconds"),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
        if (Option.isNone(result)) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: `Timed out waiting for Pi RPC '${command.type}' response.`,
          });
        }
        return result.value;
      });

    const awaitExit = child.exitCode.pipe(
      Effect.map(Number),
      Effect.orElseSucceed(() => -1),
    );

    return { send, request, awaitExit, pid: Number(child.pid) } satisfies PiRpcConnection;
  });
