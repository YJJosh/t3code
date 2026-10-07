import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { buildPiRpcEnv } from "../provider/pi/piRpcProtocol.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

it.layer(NodeServices.layer)("Pi text generation", (it) => {
  it.effect(
    "does not add conversation identity or change the text-generation arguments/environment",
    () =>
      Effect.gen(function* () {
        const settings = decodePiSettings({});
        const environment = { HOME: "/tmp/pi-home", KEEP_ME: "unchanged" };
        const path = yield* Path.Path;
        const expectedEnv = buildPiRpcEnv(path, settings, environment);
        const launches: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            if (command._tag === "StandardCommand")
              launches.push({ args: command.args, env: command.options.env });
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(42),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode('{"title":"Generated title"}')),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const result = yield* Effect.gen(function* () {
          const generator = yield* makePiTextGeneration(settings, environment);
          return yield* generator.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this work",
            modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "provider/model" },
          });
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        expect(result).toEqual({ title: "Generated title" });
        expect(launches).toHaveLength(1);
        expect(launches[0]?.env).toEqual(expectedEnv);
        expect(launches[0]?.env).not.toHaveProperty("PI_SESSIONS_T3_THREAD");
        expect(launches[0]?.env).not.toHaveProperty("PI_SESSIONS_T3_ENVIRONMENT");
        expect(launches[0]?.args.slice(0, -1)).toEqual([
          "--print",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--model",
          "provider/model",
        ]);
      }).pipe(Effect.scoped),
  );
});
