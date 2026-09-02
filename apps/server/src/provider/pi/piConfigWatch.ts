/**
 * Watch the Pi agent directory for configuration changes that affect model
 * availability and run a refresh callback, so models added to `~/.pi/agent`
 * appear in the picker without waiting for the periodic snapshot refresh.
 *
 * The directory is watched non-recursively: the model/auth/profile files all
 * live at the agent-dir root. Changes inside `extensions/` are not observed
 * here; the periodic refresh still picks those up.
 *
 * @module provider/pi/piConfigWatch
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { watchDirectoryDebounced } from "../../stream/watchDirectoryDebounced.ts";
import { resolvePiAgentDir } from "./piPaths.ts";

/** Files under the Pi agent dir that influence which models are available. */
const PI_MODEL_CONFIG_FILES: ReadonlySet<string> = new Set([
  "models.json",
  "models-store.json",
  "auth.json",
  "profiles.json",
  "settings.json",
]);

// Config edits are typically hand-made in an editor; a longer debounce than
// the settings watchers keeps one save burst from triggering several probes.
const PI_CONFIG_DEBOUNCE = Duration.millis(500);

export function isPiModelConfigPath(paths: Path.Path, eventPath: string): boolean {
  return PI_MODEL_CONFIG_FILES.has(paths.basename(eventPath));
}

export const watchPiModelConfig = Effect.fn("watchPiModelConfig")(function* (options: {
  readonly agentDir?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly onChange: Effect.Effect<void>;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const agentDir = resolvePiAgentDir(paths, options);
  const events = watchDirectoryDebounced(fs, {
    directory: agentDir,
    isRelevantPath: (eventPath) => isPiModelConfigPath(paths, eventPath),
    debounce: PI_CONFIG_DEBOUNCE,
  });
  // A missing agent dir (Pi not installed/configured) fails the watch stream:
  // log and stay dormant rather than failing provider creation.
  yield* Stream.runForEach(events, () =>
    options.onChange.pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped, Effect.asVoid);
});
