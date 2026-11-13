import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProfilesCommandRunner from "./ProfilesCommandRunner.ts";

it.effect("bounds command output and reports missing npx without running a shell command", () =>
  Effect.gen(function* () {
    let missing = false;
    const spawner = ChildProcessSpawner.make((command) => {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (ChildProcess.isStandardCommand(command)) {
        assert.equal(command.options.stdin, "ignore");
        assert.equal(command.options.env?.DISABLE_TELEMETRY, "1");
        assert.equal(command.options.env?.DO_NOT_TRACK, "1");
        assert.equal(command.options.env?.PATH, "/host/bin");
      }
      return missing
        ? Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.SystemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
              }),
            ),
          )
        : Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode("x".repeat(100_000))),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
    });
    yield* Effect.gen(function* () {
      const runner = yield* ProfilesCommandRunner.ProfilesCommandRunner;
      assert.equal(
        (yield* runner.run({
          command: "npx",
          args: ["-y", "skills@1", "update", "-p", "-y"],
          cwd: "/tmp",
        })).length,
        64 * 1024,
      );
      missing = true;
      const error = yield* runner.run({ command: "npx", args: [], cwd: "/tmp" }).pipe(Effect.flip);
      assert.equal(error.reason, "unavailable");
      assert.include(error.message, "npm and npx");
    }).pipe(
      Effect.provide(
        ProfilesCommandRunner.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
      Effect.provideService(HostProcess.Environment, { PATH: "/host/bin" }),
    );
  }),
);
