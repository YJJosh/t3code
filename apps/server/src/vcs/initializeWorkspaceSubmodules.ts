import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { resolveProjectFileBackedSetting } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as GitVcsDriver from "./GitVcsDriver.ts";

/** Apply the native worktree submodule policy to independent Workler clones too. */
export const initializeWorkspaceSubmodules = Effect.fn("initializeWorkspaceSubmodules")(
  function* (input: {
    readonly cwd: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly git: Pick<GitVcsDriver.GitVcsDriver["Service"], "execute">;
    readonly options?: GitVcsDriver.CreateWorktreeOptions | undefined;
  }) {
    const { cwd, fileSystem, path, git, options } = input;
    const hasSubmodules = yield* fileSystem
      .exists(path.join(cwd, ".gitmodules"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasSubmodules) return;
    const mode = resolveProjectFileBackedSetting(
      "worktreeSubmodules",
      options?.submodules ?? null,
      options?.submodules != null
        ? null
        : yield* fileSystem.readFileString(path.join(cwd, T3_PROJECT_FILE_NAME)).pipe(
            Effect.map(parseT3ProjectFile),
            Effect.orElseSucceed(() => null),
          ),
    );
    const progress = options?.progress;
    if (mode.value === "none") {
      yield* (
        progress?.onSubmodulesDisabled?.({
          source: mode.source === "t3.json" ? "t3.json" : "settings",
        }) ?? Effect.void
      );
      return;
    }
    yield* progress?.onSubmodulesStarted?.() ?? Effect.void;
    const onLine = progress?.onSubmoduleLine;
    yield* git
      .execute({
        operation: "WorklerWorkspace.updateSubmodules",
        cwd,
        args:
          mode.value === "recursive"
            ? ["submodule", "update", "--init", "--recursive"]
            : ["submodule", "update", "--init"],
        ...(onLine
          ? { env: { LC_ALL: "C" }, progress: { onStdoutLine: onLine, onStderrLine: onLine } }
          : {}),
      })
      .pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.logWarning("workspace submodule checkout failed; submodule paths are empty", {
              cwd,
              cause,
            }).pipe(
              Effect.andThen(
                progress?.onSubmodulesFinished?.({ ok: false, detail: cause.message }) ??
                  Effect.void,
              ),
            ),
          onSuccess: () =>
            progress?.onSubmodulesFinished?.({ ok: true, detail: null }) ?? Effect.void,
        }),
      );
  },
);
