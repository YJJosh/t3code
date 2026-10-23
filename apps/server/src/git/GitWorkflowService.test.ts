import { assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MultiRepoWorkspaces from "../vcs/MultiRepoWorkspaces.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const noMultiRepoLayer = Layer.mock(MultiRepoWorkspaces.MultiRepoWorkspaces)({
  members: () => Effect.succeed(null),
});

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("sends worktree commands for a multi-repo project to its group workspaces", () => {
    const createWorkspace = vi.fn(() =>
      Effect.succeed({ worktree: { path: "/group/.worktrees/feat", refName: "feat" } }),
    );
    const renameBranch = vi.fn(() => Effect.succeed({ branch: "feature/login" }));
    // The registry would refuse the plain group folder, so it must never be asked.
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(
        Layer.mock(MultiRepoWorkspaces.MultiRepoWorkspaces)({
          members: (cwd) => Effect.succeed(cwd.startsWith("/group") ? ["api", "web"] : null),
          createWorkspace,
          renameBranch,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const created = yield* workflow.createWorktree({
        cwd: "/group",
        refName: "HEAD",
        newRefName: "feat",
        path: null,
      });
      assert.equal(created.worktree.path, "/group/.worktrees/feat");
      yield* workflow.pruneWorktrees({ cwd: "/group" });
      const renamed = yield* workflow.renameBranch({
        cwd: "/group/.worktrees/feat",
        oldBranch: "feat",
        newBranch: "feature/login",
      });
      assert.equal(renamed.branch, "feature/login");
      expect(renameBranch).toHaveBeenCalledWith({
        cwd: "/group/.worktrees/feat",
        members: ["api", "web"],
        oldBranch: "feat",
        newBranch: "feature/login",
      });
    }).pipe(Effect.provide(testLayer));
  });
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(noMultiRepoLayer),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
