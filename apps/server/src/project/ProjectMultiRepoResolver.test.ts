import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MultiRepoWorkspaces from "../vcs/MultiRepoWorkspaces.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectMultiRepoResolver from "./ProjectMultiRepoResolver.ts";

const TestLayer = ProjectMultiRepoResolver.layer.pipe(
  Layer.provide(MultiRepoWorkspaces.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-multi-repo-resolver-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  GitVcsDriver.GitVcsDriver.pipe(
    Effect.flatMap((driver) =>
      driver.execute({ operation: "ProjectMultiRepoResolver.test", cwd, args, timeoutMs: 10_000 }),
    ),
  );

it.layer(TestLayer)("ProjectMultiRepoResolver", (it) => {
  it.effect("lists each member with its origin, without credentials", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolver = yield* ProjectMultiRepoResolver.ProjectMultiRepoResolver;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-multi-repo-root-" });
      for (const member of ["api", "web", "docs"]) {
        yield* fileSystem.makeDirectory(path.join(root, member));
        yield* git(path.join(root, member), ["init"]);
      }
      yield* git(path.join(root, "api"), [
        "remote",
        "add",
        "origin",
        "https://user:token@github.com/acme/api.git",
      ]);
      // Another machine can't clone a local path, so it counts as no remote.
      yield* git(path.join(root, "docs"), ["remote", "add", "origin", "/srv/git/docs.git"]);
      // A linked worktree has a `.git` file rather than a folder.
      yield* git(path.join(root, "api"), [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ]);
      yield* git(path.join(root, "api"), ["worktree", "add", "-b", "linked", "../linked"]);

      // Not a group yet: a plain folder of repositories, which could become one.
      // The linked worktree has no `.git` folder of its own, as in Workler.
      assert.deepEqual(yield* resolver.resolve(root), {
        multiRepo: null,
        nestedRepositories: ["api", "docs", "web"],
      });

      yield* fileSystem.writeFileString(
        path.join(root, ".workler"),
        "project api\nproject web\nproject docs\nproject linked\n",
      );
      assert.deepEqual(yield* resolver.resolve(root, { refresh: true }), {
        multiRepo: {
          members: [
            { path: "api", remoteUrl: "https://github.com/acme/api.git" },
            { path: "web", remoteUrl: null },
            { path: "docs", remoteUrl: null },
            { path: "linked", remoteUrl: "https://github.com/acme/api.git" },
          ],
        },
        nestedRepositories: [],
      });
      assert.deepEqual(yield* resolver.resolve(path.join(root, "api")), {
        multiRepo: null,
        nestedRepositories: [],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("offers no repositories inside a repository or inside T3's own folders", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* ServerConfig.ServerConfig;
      const resolver = yield* ProjectMultiRepoResolver.ProjectMultiRepoResolver;
      const none = { multiRepo: null, nestedRepositories: [] };

      const outer = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-multi-repo-outer-" });
      yield* git(outer, ["init"]);
      yield* fileSystem.makeDirectory(path.join(outer, "vendor", "lib"), { recursive: true });
      yield* git(path.join(outer, "vendor", "lib"), ["init"]);
      assert.deepEqual(yield* resolver.resolve(path.join(outer, "vendor")), none);

      // Scratch threads can hold repositories an agent cloned.
      const scratchThread = path.join(baseDir, "scratch", "thread-1");
      yield* fileSystem.makeDirectory(path.join(scratchThread, "clone"), { recursive: true });
      yield* git(path.join(scratchThread, "clone"), ["init"]);
      assert.deepEqual(yield* resolver.resolve(path.join(baseDir, "scratch")), none);
    }).pipe(Effect.scoped),
  );
});
