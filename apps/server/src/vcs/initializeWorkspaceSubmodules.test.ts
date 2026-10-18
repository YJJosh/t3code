import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { initializeWorkspaceSubmodules } from "./initializeWorkspaceSubmodules.ts";

it.effect("honors clone t3.json submodule policy and explicit overrides", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "workler-submodules-" });
    yield* fileSystem.writeFileString(
      path.join(cwd, ".gitmodules"),
      '[submodule "lib"]\npath = lib\nurl = https://example.test/lib\n',
    );
    yield* fileSystem.writeFileString(path.join(cwd, "t3.json"), '{"worktreeSubmodules":"none"}');
    const commands: Array<ReadonlyArray<string>> = [];
    const disabled: string[] = [];
    const git = {
      execute: (input: GitVcsDriver.ExecuteGitInput) =>
        Effect.sync(() => {
          commands.push(input.args);
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    };
    yield* initializeWorkspaceSubmodules({
      cwd,
      fileSystem,
      path,
      git,
      options: {
        progress: {
          onSubmodulesDisabled: ({ source }) =>
            Effect.sync(() => {
              disabled.push(source);
            }),
        },
      },
    });
    assert.deepEqual(disabled, ["t3.json"]);
    assert.deepEqual(commands, []);
    yield* initializeWorkspaceSubmodules({
      cwd,
      fileSystem,
      path,
      git,
      options: { submodules: "recursive" },
    });
    assert.deepEqual(commands, [["submodule", "update", "--init", "--recursive"]]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("reports submodule failure without failing the claimed workspace", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "workler-submodules-" });
    yield* fileSystem.writeFileString(path.join(cwd, ".gitmodules"), "");
    const completions: boolean[] = [];
    yield* initializeWorkspaceSubmodules({
      cwd,
      fileSystem,
      path,
      git: {
        execute: () =>
          Effect.fail(
            new GitCommandError({ operation: "test", command: "git", cwd, detail: "offline" }),
          ),
      },
      options: {
        submodules: "recursive",
        progress: {
          onSubmodulesFinished: ({ ok }) =>
            Effect.sync(() => {
              completions.push(ok);
            }),
        },
      },
    });
    assert.deepEqual(completions, [false]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
