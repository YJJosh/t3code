// @effect-diagnostics nodeBuiltinImport:off - the nested-repository scan needs typed
// directory entries, lstat and the home folder, which Effect's services don't expose.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  GitCommandError,
  type ProjectInspectMultiRepoFolderResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";

import {
  isTemporaryWorktreeBranch,
  flattenTemporaryWorktreeBranchName,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";
import { initializeWorkspaceSubmodules } from "./initializeWorkspaceSubmodules.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  keepWorklerCloneRefs,
  mapWorklerError,
  sanitizeWorklerWorkspaceName,
} from "./WorklerGitWorkspaceDriver.ts";
import * as WorklerWorkspaceService from "./WorklerWorkspaceService.ts";

export const WORKLER_CONFIG_FILE = ".workler";
export const WORKSPACES_DIR = ".worktrees";
const MAX_WORKSPACE_NAME_ATTEMPTS = 100;

/**
 * Workspaces for multi-repo projects: a plain folder whose `.workler` lists
 * several git repositories (a Workler project group). A workspace clones every
 * member into `.worktrees/<name>/`, all on one branch, and the workspace
 * folder itself is not a repository.
 */
export class MultiRepoWorkspaces extends Context.Service<
  MultiRepoWorkspaces,
  {
    /** Member paths when `cwd` is a project group or one of its workspaces, otherwise null. */
    readonly members: (cwd: string) => Effect.Effect<ReadonlyArray<string> | null>;
    /**
     * Repositories inside the plain folder `cwd`, as `makeGroup` would list
     * them. Empty when `cwd` is inside a repository or has a `.workler`.
     */
    readonly nestedRepositories: (cwd: string) => Effect.Effect<ReadonlyArray<string>>;
    /** Makes the plain folder `cwd` a project group of the repositories inside it; returns its members. */
    readonly makeGroup: (cwd: string) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
    /**
     * What a folder picked for a new multi-repo project holds: repositories to
     * group, room to clone repositories into, or neither. Writes nothing.
     */
    readonly inspectFolder: (folder: string) => Effect.Effect<ProjectInspectMultiRepoFolderResult>;
    /** Fetches `origin` in every member that has one; returns the members whose fetch failed. */
    readonly fetchMembers: (
      cwd: string,
      members: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>>;
    /**
     * Creates a workspace on `newRefName`. Each member starts from its own
     * remote default branch (`origin/HEAD`), since the repositories of a group
     * rarely share a base; from its current branch when any member has none.
     * With a `path`, recreates that missing workspace on `refName`.
     */
    readonly createWorkspace: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    /**
     * Removes a workspace (of a group or a single repository) after copying its
     * branch, tags and checkpoints into the repositories it was cloned from;
     * keeps it when that copy fails.
     */
    readonly removeWorkspace: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Renames the branch in every member of the workspace at `cwd`; finishes or rolls back even if interrupted. */
    readonly renameBranch: (input: {
      readonly cwd: string;
      readonly members: ReadonlyArray<string>;
      readonly oldBranch: string;
      readonly newBranch: string;
      readonly exactName?: boolean;
    }) => Effect.Effect<{ readonly branch: string }, GitCommandError>;
  }
>()("t3/vcs/MultiRepoWorkspaces") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workler = yield* WorklerWorkspaceService.WorklerWorkspaceService;

  const exists = (file: string) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));

  const members: MultiRepoWorkspaces["Service"]["members"] = (cwd) =>
    Effect.gen(function* () {
      // Most projects are repositories; two stats keep them off the Workler worker.
      const [hasConfig, hasGit] = yield* Effect.all([
        exists(path.join(cwd, WORKLER_CONFIG_FILE)),
        exists(path.join(cwd, ".git")),
      ]);
      if (!hasConfig || hasGit) return null;
      const group = yield* workler.inspectGroup(cwd).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Workler could not inspect a possible project group", {
            cwd,
            detail: error.detail,
          }).pipe(Effect.as(null)),
        ),
      );
      return group?.projects ?? null;
    });

  // Like git, a `.git` in `cwd` or any folder above it puts `cwd` in that repository.
  const insideRepository = Effect.fn(function* (cwd: string) {
    for (let dir = path.resolve(cwd); ;) {
      if (yield* exists(path.join(dir, ".git"))) return true;
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  });

  const listFolders = (dir: string) =>
    Effect.tryPromise(() => NodeFSP.readdir(dir, { withFileTypes: true })).pipe(
      Effect.map((entries) =>
        entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  // `lstat`, like Workler: a linked `.git` doesn't make a repository.
  const hasGitFolder = (repository: string) =>
    Effect.tryPromise(() => NodeFSP.lstat(path.join(repository, ".git"))).pipe(
      Effect.map((info) => info.isDirectory()),
      Effect.orElseSucceed(() => false),
    );

  // Mirrors Workler's `discoverProjects`, which its `init` uses: folders with
  // their own `.git` folder directly below `cwd` or one level deeper, skipping
  // symbolic links, hidden folders (so `.worktrees`) and node_modules. Read
  // with async calls here because snapshots ask about every plain project
  // folder; `makeGroup` still lets Workler decide what it writes.
  const findRepositories = (
    dir: string,
    relative: string,
    depth: number,
  ): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const names = yield* listFolders(dir);
      const found = yield* Effect.forEach(
        names.filter((name) => !name.startsWith(".") && name !== "node_modules").toSorted(),
        (name) =>
          Effect.gen(function* () {
            const child = path.join(dir, name);
            const childRelative = relative === "" ? name : `${relative}/${name}`;
            if (yield* hasGitFolder(child)) {
              return WorklerWorkspaceService.canWriteProjectPath(childRelative)
                ? [childRelative]
                : [];
            }
            return depth < 2 ? yield* findRepositories(child, childRelative, depth + 1) : [];
          }),
        { concurrency: 8 },
      );
      return found.flat();
    });

  // Whether `child` is `parent` or inside it. Across Windows drives `relative`
  // is absolute, which is outside.
  const isWithin = (parent: string, child: string) => {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  // A folder holding the home folder (`~`, `/Users`, `/`) is skipped: two levels
  // down reaches Desktop, Documents and Library, and reading those makes macOS
  // ask the desktop app for access.
  const holdsHomeFolder = (cwd: string) => isWithin(cwd, NodeOS.homedir());

  const nestedRepositories: MultiRepoWorkspaces["Service"]["nestedRepositories"] = (cwd) =>
    Effect.gen(function* () {
      if (holdsHomeFolder(cwd)) return [];
      if (yield* exists(path.join(cwd, WORKLER_CONFIG_FILE))) return [];
      if (yield* insideRepository(cwd)) return [];
      return yield* findRepositories(cwd, "", 1);
    });

  const makeGroup: MultiRepoWorkspaces["Service"]["makeGroup"] = Effect.fn(
    "MultiRepoWorkspaces.makeGroup",
  )(function* (cwd) {
    // The header only offers this for eligible folders, but the RPC can be
    // called directly: never write into T3's home (Scratch, worktrees).
    if (isWithin(baseDir, cwd)) {
      return yield* new GitCommandError({
        operation: "MultiRepoWorkspaces.makeGroup",
        command: "workler",
        cwd,
        detail: "Folders inside T3's home cannot become multi-repo projects.",
      });
    }
    // The offer can be up to a minute old, and Workler only checks whether the
    // folder is a repository's top level, not whether it sits inside one.
    if (yield* insideRepository(cwd)) {
      return yield* new GitCommandError({
        operation: "MultiRepoWorkspaces.makeGroup",
        command: "workler",
        cwd,
        detail: `${cwd} is a Git repository or is inside one.`,
      });
    }
    const group = yield* workler
      .initGroup(path.resolve(cwd))
      .pipe(
        Effect.mapError((error) => mapWorklerError("MultiRepoWorkspaces.makeGroup", cwd, error)),
      );
    return group.projects;
  });

  const inspectFolder: MultiRepoWorkspaces["Service"]["inspectFolder"] = Effect.fn(
    "MultiRepoWorkspaces.inspectFolder",
  )(function* (rawFolder) {
    const folder = path.resolve(expandHomePath(rawFolder.trim(), NodeOS.homedir()));
    const result = (
      kind: ProjectInspectMultiRepoFolderResult["kind"],
      repositories: ReadonlyArray<string> = [],
    ): ProjectInspectMultiRepoFolderResult => ({ path: folder, kind, repositories });
    const unavailable = (reason: string): ProjectInspectMultiRepoFolderResult => ({
      ...result("unavailable"),
      reason,
    });

    if (isWithin(baseDir, folder)) {
      return unavailable("T3 Code's own folders can't hold a project.");
    }
    if (holdsHomeFolder(folder)) {
      return unavailable("This is your home folder or holds it. Pick a more specific folder.");
    }
    const info = yield* fileSystem.stat(folder).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type !== "Directory") {
      return unavailable("This is a file, not a folder.");
    }
    const groupMembers = Option.isSome(info) ? yield* members(folder) : null;
    if (groupMembers) return result("group", groupMembers);
    if (yield* insideRepository(folder)) {
      return unavailable("This folder is a Git repository or is inside one.");
    }
    if (Option.isNone(info)) return result("missing");

    const entries = yield* fileSystem
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> | null => null));
    if (entries === null) return unavailable("This folder can't be read.");
    // Finder leaves .DS_Store in folders made with it; clones go into subfolders anyway.
    if (entries.every((entry) => entry === ".DS_Store")) return result("empty");
    if (yield* exists(path.join(folder, WORKLER_CONFIG_FILE))) {
      return unavailable("Its .workler file lists no repositories.");
    }
    const repositories = yield* findRepositories(folder, "", 1);
    if (repositories.length > 0) return result("repositories", repositories);
    return unavailable(
      "This folder has files but no Git repositories. Pick an empty folder to clone repositories into.",
    );
  });

  const fetchMembers: MultiRepoWorkspaces["Service"]["fetchMembers"] = Effect.fn(
    "MultiRepoWorkspaces.fetchMembers",
  )(function* (cwd, memberPaths) {
    const failed = yield* Effect.forEach(
      memberPaths,
      (member) => {
        const memberCwd = path.join(cwd, member);
        return git.remoteExists({ cwd: memberCwd, remoteName: "origin" }).pipe(
          Effect.flatMap((hasOrigin) =>
            hasOrigin ? git.fetchRemote({ cwd: memberCwd, remoteName: "origin" }) : Effect.void,
          ),
          Effect.as(null),
          Effect.catch((error) =>
            Effect.logWarning("Could not fetch a multi-repo member", {
              cwd: memberCwd,
              detail: error.detail,
            }).pipe(Effect.as(member)),
          ),
        );
      },
      { concurrency: 4 },
    );
    return failed.filter((member) => member !== null);
  });

  const createWorkspace: MultiRepoWorkspaces["Service"]["createWorkspace"] = Effect.fn(
    "MultiRepoWorkspaces.createWorkspace",
  )(function* (input, options) {
    const root = path.resolve(input.cwd);
    const workspacesDir = path.join(root, WORKSPACES_DIR);
    let branch = input.newRefName ?? input.refName;
    // Upstream's temporary namespace may be blocked in any member. Use one
    // flattened name for the entire group rather than probing its non-Git root.
    if (input.newRefName !== undefined && isTemporaryWorktreeBranch(branch)) {
      for (const member of (yield* members(root)) ?? []) {
        const existing = yield* git.execute({
          operation: "MultiRepoWorkspaces.temporaryBranch",
          cwd: path.join(root, member),
          args: ["show-ref", "--verify", "--quiet", `refs/heads/${WORKTREE_BRANCH_PREFIX}`],
          allowNonZeroExit: true,
        });
        if (existing.exitCode === 0) {
          branch = flattenTemporaryWorktreeBranchName(branch);
          break;
        }
      }
    }
    let name: string | null = null;
    if (input.path !== null) {
      const requested = path.resolve(root, input.path);
      if (path.dirname(requested) === workspacesDir) name = path.basename(requested);
    } else {
      const baseName = sanitizeWorklerWorkspaceName(branch);
      for (let attempt = 0; attempt < MAX_WORKSPACE_NAME_ATTEMPTS && name === null; attempt += 1) {
        const candidate = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
        if (!(yield* exists(path.join(workspacesDir, candidate)))) name = candidate;
      }
    }
    if (name === null) {
      return yield* new GitCommandError({
        operation: "MultiRepoWorkspaces.createWorkspace",
        command: "workler",
        cwd: input.cwd,
        detail:
          input.path === null
            ? `Could not find an available workspace name for '${branch}'.`
            : "A multi-repo workspace must live in the project's .worktrees folder.",
      });
    }
    // Workler resolves `base` inside each member and checks every member before
    // cloning, so a member without `origin/HEAD` fails with BAD_REF and nothing
    // to undo; then every member starts from its current HEAD as a new branch.
    // A recreate checks out the existing branch: a pushed branch may only be in
    // the remote, so fetch first, and a missing branch fails instead of being
    // made up from HEAD.
    if (input.newRefName === undefined) {
      const memberPaths = yield* members(root);
      if (memberPaths !== null) {
        yield* fetchMembers(root, memberPaths);
        // Workler's checkout also accepts tags and commits, so require a real branch in
        // every member instead of silently restoring one of them detached.
        for (const member of memberPaths) {
          const refs = yield* Effect.forEach(
            [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`],
            (ref) =>
              git.execute({
                operation: "MultiRepoWorkspaces.restoreBranch",
                cwd: path.join(root, member),
                args: ["show-ref", "--verify", "--quiet", ref],
                allowNonZeroExit: true,
              }),
          );
          if (!refs.some((result) => result.exitCode === 0)) {
            return yield* new GitCommandError({
              operation: "MultiRepoWorkspaces.createWorkspace",
              command: "git show-ref",
              cwd: input.cwd,
              detail: `Branch '${branch}' no longer exists in multi-repo member '${member}'.`,
            });
          }
        }
      }
    }
    const create =
      input.newRefName === undefined
        ? workler.createWorkspace({ root, name, checkout: branch })
        : workler.createWorkspace({ root, name, branch, base: "origin/HEAD" }).pipe(
            Effect.catchIf(
              (error) => error.code === "BAD_REF",
              // Without a base Workler reuses an existing branch, possibly in only
              // some members; `HEAD` keeps this a new branch everywhere.
              () => workler.createWorkspace({ root, name, branch, base: "HEAD" }),
            ),
          );
    const created = yield* create.pipe(
      Effect.mapError((error) =>
        mapWorklerError("MultiRepoWorkspaces.createWorkspace", input.cwd, error),
      ),
      // The Workler call finishes even after a cancel, so claim the workspace
      // before the interrupt lands; bootstrap then removes it.
      Effect.tap(
        (workspace) => options?.progress?.onWorktreeClaimed?.(workspace.path) ?? Effect.void,
      ),
      Effect.uninterruptible,
    );
    for (const member of (yield* members(created.path)) ?? []) {
      yield* initializeWorkspaceSubmodules({
        cwd: path.join(created.path, member),
        fileSystem,
        path,
        git,
        options,
      });
    }
    return { worktree: { path: created.path, refName: created.branch ?? branch } };
  });

  const removeWorkspace: MultiRepoWorkspaces["Service"]["removeWorkspace"] = Effect.fn(
    "MultiRepoWorkspaces.removeWorkspace",
  )(function* (input) {
    const root = path.resolve(input.cwd);
    const requested = path.resolve(root, input.path);
    if (path.dirname(requested) !== path.join(root, WORKSPACES_DIR)) {
      return yield* new GitCommandError({
        operation: "MultiRepoWorkspaces.removeWorkspace",
        command: "workler",
        cwd: input.cwd,
        detail: "Only workspaces in the project's .worktrees folder can be removed.",
      });
    }
    const kept = (reason: string) =>
      new GitCommandError({
        operation: "MultiRepoWorkspaces.removeWorkspace",
        command: "workler",
        cwd: input.cwd,
        detail: `Kept ${requested}, because ${reason}`,
      });
    // A single repository's workspace is one clone of the project itself.
    let workspaceMembers = ["."];
    const groupMembers = yield* members(root);
    if (groupMembers !== null) {
      // Workler deletes the whole workspace folder, and an older workspace can
      // hold a repository the project no longer lists. Its own .workler says
      // which clones it holds, so copy back from all of them. A removal that
      // stopped halfway may have deleted that file first: look on disk instead.
      const ownMembers = (yield* members(requested)) ?? (yield* findRepositories(requested, "", 1));
      workspaceMembers = [...new Set([...ownMembers, ...groupMembers])];
    }
    for (const member of workspaceMembers) {
      const clone = path.join(requested, member);
      if (!(yield* exists(path.join(clone, ".git")))) continue;
      const source = path.join(root, member);
      if (!(yield* exists(path.join(source, ".git")))) {
        const name = member === "." ? "the project folder" : member;
        return yield* kept(
          `${name} is no longer a Git repository, so its branch has nowhere to go.`,
        );
      }
      yield* keepWorklerCloneRefs(git, { source, clone });
    }
    yield* workler
      .removeWorkspace({
        root,
        name: path.basename(requested),
        ...(input.force === undefined ? {} : { force: input.force }),
      })
      .pipe(
        Effect.mapError((error) =>
          mapWorklerError("MultiRepoWorkspaces.removeWorkspace", input.cwd, error),
        ),
      );
  });

  const renameBranch: MultiRepoWorkspaces["Service"]["renameBranch"] = Effect.fn(
    "MultiRepoWorkspaces.renameBranch",
  )(function* (input) {
    // Pick one name free in every member first: renaming member by member lets
    // git choose a `-N` name per repository and split the workspace across branches.
    let branch = input.newBranch;
    if (input.oldBranch === branch) return { branch };
    for (let suffix = 0; ; suffix += 1) {
      branch = suffix === 0 ? input.newBranch : `${input.newBranch}-${suffix}`;
      const taken = yield* Effect.forEach(input.members, (member) =>
        git
          .execute({
            operation: "MultiRepoWorkspaces.renameBranch.check",
            cwd: path.join(input.cwd, member),
            args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
            allowNonZeroExit: true,
          })
          .pipe(Effect.map((result) => result.exitCode === 0)),
      );
      if (!taken.some(Boolean)) break;
      if (input.exactName || suffix === MAX_WORKSPACE_NAME_ATTEMPTS) {
        return yield* new GitCommandError({
          operation: "MultiRepoWorkspaces.renameBranch",
          command: "git branch -m",
          cwd: input.cwd,
          detail: `Could not find a shared available branch name for '${input.newBranch}'.`,
        });
      }
    }
    const rename = (cwd: string, from: string, to: string) =>
      git.renameBranch({ cwd, oldBranch: from, newBranch: to, exactName: true });
    const renamed: Array<string> = [];
    for (const member of input.members) {
      const cwd = path.join(input.cwd, member);
      yield* rename(cwd, input.oldBranch, branch).pipe(
        Effect.tapError(() =>
          // Put the members already renamed back, so the workspace keeps one branch.
          Effect.forEach(
            renamed.toReversed(),
            (done) => rename(done, branch, input.oldBranch).pipe(Effect.ignoreCause({ log: true })),
            { discard: true },
          ),
        ),
      );
      renamed.push(cwd);
    }
    return { branch };
  }, Effect.uninterruptible);

  return MultiRepoWorkspaces.of({
    members,
    nestedRepositories,
    makeGroup,
    inspectFolder,
    fetchMembers,
    createWorkspace,
    removeWorkspace,
    renameBranch,
  });
});

export const layer = Layer.effect(MultiRepoWorkspaces, make).pipe(
  Layer.provide(WorklerWorkspaceService.layer),
);
