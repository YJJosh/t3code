import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { isCommandMissingCause } from "@t3tools/provider-core/server/snapshotProbe";
import { ProfilesError } from "@t3tools/contracts";

export class ProfilesCommandRunner extends Context.Service<
  ProfilesCommandRunner,
  {
    readonly run: (input: {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }) => Effect.Effect<string, ProfilesError>;
  }
>()("t3/profiles/ProfilesCommandRunner") {}

const isProfilesError = Schema.is(ProfilesError);

const make = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = Effect.fn("ProfilesCommandRunner.run")(
    function* (input: {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }) {
      const env = { ...environment, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" };
      const spawn = yield* resolveSpawnCommand(input.command, input.args, { env });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawn.command, spawn.args, {
          cwd: input.cwd,
          env,
          shell: spawn.shell,
          stdin: "ignore",
          killSignal: "SIGKILL",
        }),
      );
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const collect = (stream: typeof child.stdout) =>
        Stream.runForEach(stream, (chunk) =>
          Effect.sync(() => {
            const remaining = 64 * 1024 - bytes;
            if (remaining > 0) {
              chunks.push(chunk.subarray(0, remaining));
              bytes += Math.min(chunk.length, remaining);
            }
          }),
        );
      const [code] = yield* Effect.all(
        [child.exitCode, collect(child.stdout), collect(child.stderr)],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* new ProfilesError({
          reason: "command",
          message: "The skills command failed.",
        });
      return Buffer.concat(chunks).toString("utf8");
    },
    Effect.scoped,
    Effect.timeout("2 minutes"),
    Effect.mapError((cause) =>
      isProfilesError(cause)
        ? cause
        : new ProfilesError({
            reason: isCommandMissingCause(cause) ? "unavailable" : "command",
            message: isCommandMissingCause(cause)
              ? "Skills commands require Node.js with npm and npx on the host PATH."
              : "The skills command could not finish within its two-minute limit.",
          }),
    ),
  );
  return ProfilesCommandRunner.of({ run });
});
export const layer = Layer.effect(ProfilesCommandRunner, make);
