/** Read-only helpers deliberately do not load chat profiles, skills or extensions. */
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { DulliSettings } from "../settings.ts";
import { resolvePiAgentDir } from "./piPaths.ts";
import { parsePiModelSlug } from "./rpc.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

export const makePiTextGeneration = Effect.fn("makeDulliTextGeneration")(function* (
  settings: DulliSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const paths = yield* Path.Path;
  const env = {
    ...environment,
    PI_CODING_AGENT_DIR: resolvePiAgentDir(paths, { agentDir: settings.agentDir, environment }),
  };
  const run: TextGenerationOperations.Runner = Effect.fn("DulliTextGeneration.run")(
    function* (request) {
      const model = request.modelSelection.model.trim();
      if (parsePiModelSlug(model) === null) {
        return yield* new TextGenerationError({
          operation: request.operation,
          detail: "Dulli text generation requires an explicit provider/model selection.",
        });
      }
      const binary = settings.binaryPath || "pi";
      const spawn = yield* resolveSpawnCommand(
        binary,
        [
          "--print",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--model",
          model,
          request.prompt,
        ],
        { env },
      );
      const result = yield* spawnAndCollect(
        binary,
        ChildProcess.make(spawn.command, spawn.args, {
          cwd: request.cwd,
          env,
          extendEnv: false,
          shell: spawn.shell,
        }),
      );
      if (result.code !== 0 || !result.stdout.trim()) {
        return yield* new TextGenerationError({
          operation: request.operation,
          detail:
            result.code !== 0
              ? `Pi text generation exited with code ${result.code}.`
              : "Pi returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(
        request,
        "Dulli",
        result.stdout.trim(),
      );
    },
    (effect, request) =>
      effect.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOrElse({
          duration: 180_000,
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation: request.operation,
                detail: "Dulli text generation timed out.",
              }),
            ),
        }),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "Dulli text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );
  return TextGenerationOperations.fromRunner(
    "DulliTextGeneration",
    TextGenerationOperations.withoutInvestigation("Dulli", run),
  );
});
