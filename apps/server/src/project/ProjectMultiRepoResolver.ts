import type { ProjectMultiRepo } from "@t3tools/contracts";
import {
  isNetworkGitRemoteUrl,
  parseOriginUrlFromGitConfig,
  redactGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MultiRepoWorkspaces from "../vcs/MultiRepoWorkspaces.ts";

const CACHE_CAPACITY = 512;
// Snapshots resolve every project. A finished "Set up on this PC" clone and
// "Make multi-repo project" refresh their entry. A `.workler` written, edited
// or deleted by hand shows within this lifetime; re-checking a group is one
// worker call plus a read of each member's `.git/config`.
const CACHE_TTL = Duration.minutes(1);

/** The repositories a project folder groups, or could group. */
export interface ProjectFolderRepositories {
  /** The folder's multi-repo project, or null. */
  readonly multiRepo: ProjectMultiRepo | null;
  /** Repositories inside a plain folder that is not a multi-repo project yet; otherwise empty. */
  readonly nestedRepositories: ReadonlyArray<string>;
}

const NOT_A_MULTI_REPO_FOLDER: ProjectFolderRepositories = {
  multiRepo: null,
  nestedRepositories: [],
};

/**
 * Whether a project folder is a multi-repo project, with each member's remote.
 * Clients use the remotes to show the same project on every environment as
 * one, and to clone it onto another one, so a local-path remote counts as none.
 * For a plain folder it lists the repositories inside, so clients can offer to
 * make it a multi-repo project.
 */
export class ProjectMultiRepoResolver extends Context.Service<
  ProjectMultiRepoResolver,
  {
    readonly resolve: (
      workspaceRoot: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<ProjectFolderRepositories>;
  }
>()("t3/project/ProjectMultiRepoResolver") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
  const git = yield* GitVcsDriver.GitVcsDriver;

  // Members are usually full clones, so their remotes are in `.git/config` and
  // reading it spares a git process. A linked worktree or submodule has a
  // `.git` file instead; only then ask git, which would otherwise walk up into
  // a repository around the group.
  const readRemoteUrl = (repository: string) =>
    Effect.gen(function* () {
      const dotGit = path.join(repository, ".git");
      const info = yield* fileSystem.stat(dotGit);
      if (info.type === "Directory") {
        return parseOriginUrlFromGitConfig(
          yield* fileSystem.readFileString(path.join(dotGit, "config")),
        );
      }
      return info.type === "File"
        ? yield* git.readConfigValue(repository, "remote.origin.url")
        : null;
    });

  const remoteUrl = (repository: string) =>
    readRemoteUrl(repository).pipe(
      Effect.map((url) =>
        url === null || !isNetworkGitRemoteUrl(url) ? null : redactGitRemoteUrl(url),
      ),
      Effect.orElseSucceed(() => null),
    );

  // Scratch and T3's worktrees are T3's own folders, never a group, even when
  // an agent cloned repositories into one.
  const insideT3Home = (workspaceRoot: string) => {
    const relative = path.relative(baseDir, path.resolve(workspaceRoot));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const describe = (workspaceRoot: string) =>
    Effect.gen(function* () {
      const members = yield* workspaces.members(workspaceRoot);
      if (members === null) {
        if (insideT3Home(workspaceRoot)) return NOT_A_MULTI_REPO_FOLDER;
        return {
          multiRepo: null,
          nestedRepositories: yield* workspaces.nestedRepositories(workspaceRoot),
        };
      }
      return {
        multiRepo: {
          members: yield* Effect.forEach(members, (member) =>
            remoteUrl(path.join(workspaceRoot, member)).pipe(
              Effect.map((url) => ({ path: member, remoteUrl: url })),
            ),
          ),
        },
        nestedRepositories: [],
      };
    });

  const cache = yield* Cache.makeWith<string, ProjectFolderRepositories>(describe, {
    capacity: CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? CACHE_TTL : Duration.zero),
  });

  // Untraced because almost every call is a cache hit.
  const resolve: ProjectMultiRepoResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (workspaceRoot, options) {
      if (options?.refresh) yield* Cache.invalidate(cache, workspaceRoot);
      return yield* Cache.get(cache, workspaceRoot);
    },
  );

  return ProjectMultiRepoResolver.of({ resolve });
});

export const layer = Layer.effect(ProjectMultiRepoResolver, make);
