import type {
  OrchestrationThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ThreadDeletionReactor from "./orchestration/Services/ThreadDeletionReactor.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import { threadHasQueuedTurnStart } from "./orchestration/ThreadSettlementPolicy.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as MultiRepoWorkspaces from "./vcs/MultiRepoWorkspaces.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/storageCleanup") {}

const DAY_MS = 86_400_000;

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

/** Live sessions keep their cwd even when no turn is currently running. */
function storageCleanupThreadIdle(thread: OrchestrationThreadShell, now: number): boolean {
  return (
    thread.branch !== null &&
    thread.worktreePath !== null &&
    (thread.session === null || thread.session.status === "stopped") &&
    thread.latestTurn?.state !== "running" &&
    thread.backgroundLiveness == null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    !threadHasQueuedTurnStart(thread, DateTime.formatIso(DateTime.makeUnsafe(now)))
  );
}

/** PR metadata refreshes must not reset the inactivity clock. */
function storageCleanupActivityAt(thread: OrchestrationThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestTurn?.requestedAt,
      thread.latestTurn?.startedAt,
      thread.latestTurn?.completedAt,
    ].flatMap((value) => (value == null ? [] : [Date.parse(value)])),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const threadDeletion = yield* ThreadDeletionReactor.ThreadDeletionReactor;
  const providers = yield* ProviderService.ProviderService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const multiRepo = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            path.resolve(terminal.worktreePath) === worktreePath) ||
          cwd === worktreePath ||
          inside(worktreePath, cwd)
        );
      });

  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const active = yield* snapshots.getShellSnapshot();
    const archived = yield* snapshots.getArchivedShellSnapshot();
    return { projects: active.projects, threads: [...active.threads, ...archived.threads] };
  });

  // Local threads under another project need not have a worktreePath of their own.
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (projectPath === worktreePath || inside(worktreePath, projectPath)) return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (realPath === worktreePath || inside(worktreePath, realPath)) return true;
    }
    return false;
  });

  // The repositories of the checkout at worktreePath. T3's linked worktrees (in
  // worktreesDir) keep their branch in the project repository. Workler
  // workspaces (in <project>/.worktrees) are whole clones, one or one per
  // member of a multi-repo group, so removing one also deletes its branches.
  const resolveCheckout = Effect.fn("StorageCleanup.resolveCheckout")(function* (
    worktreePath: string,
    workspaceRoot: string,
    worktreesRoot: string | null,
  ) {
    const gitEntry = yield* fs.stat(path.join(worktreePath, ".git")).pipe(
      Effect.map((stat) => stat.type),
      Effect.orElseSucceed(() => null),
    );
    if (worktreesRoot !== null && inside(worktreesRoot, worktreePath)) {
      // A linked worktree has a .git file. Never remove a main checkout.
      return gitEntry === "File"
        ? {
            kind: "linked" as const,
            root: workspaceRoot,
            repos: [worktreePath],
            sources: [path.resolve(workspaceRoot)],
            members: [],
          }
        : null;
    }
    const projectRoot = yield* fs
      .realPath(path.resolve(workspaceRoot))
      .pipe(Effect.orElseSucceed(() => null));
    if (
      projectRoot === null ||
      path.dirname(worktreePath) !== path.join(projectRoot, MultiRepoWorkspaces.WORKSPACES_DIR)
    )
      return null;
    if (gitEntry === "Directory")
      return {
        kind: "clone" as const,
        root: projectRoot,
        repos: [worktreePath],
        sources: [projectRoot],
        members: [],
      };
    if (gitEntry !== null) return null;
    const members = yield* multiRepo.members(worktreePath);
    if (members === null || (yield* multiRepo.members(projectRoot)) === null) return null;
    for (const member of members) {
      const repo = path.join(worktreePath, member);
      // Members are clones, not links or linked worktrees.
      if ((yield* fs.realPath(repo)) !== repo) return null;
      if ((yield* fs.stat(path.join(repo, ".git"))).type !== "Directory") return null;
    }
    return {
      kind: "group" as const,
      root: projectRoot,
      repos: members.map((member) => path.join(worktreePath, member)),
      sources: members.map((member) => path.join(projectRoot, member)),
      members,
    };
  });

  // The HEAD commit when a repository holds nothing worth keeping: it is on the
  // thread's branch with no changes and no ignored files but dependency
  // installs. A clone (with the repository it came from as source) must also
  // hold no commit that only it has: none that a remote-tracking ref or a
  // branch of the source doesn't reach, from any ref but T3's own checkpoints
  // (copied to the project before removal). That covers tags and stashes too.
  const removableHead = Effect.fn("StorageCleanup.removableHead")(function* (
    repo: string,
    branch: string | null,
    source: string | null,
  ) {
    const status = yield* git.statusDetailsLocal(repo);
    if (!status.isRepo || status.branch !== branch || status.hasWorkingTreeChanges) return null;
    const head = yield* git.resolveCommit({ cwd: repo, revision: "HEAD" });
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd: repo,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 64 * 1024,
    });
    // Ignored files can contain secrets or local datasets. Dependency installs
    // are reproducible and Finder's .DS_Store holds only view settings; every
    // other ignored path prevents automatic removal.
    if (ignored.stdoutTruncated) return null;
    for (const entry of ignored.stdout.split("\0")) {
      if (entry === "" || /(^|\/)(node_modules\/|\.DS_Store)$/.test(entry)) continue;
      // Git omits the trailing slash for Workler's linked node_modules.
      // Follow it only to verify a dependency directory; deleting the checkout
      // unlinks it, not its target. A file named node_modules still protects it.
      if (
        /(^|\/)node_modules$/.test(entry) &&
        (yield* fs.stat(path.join(repo, entry)).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        ))
      )
        continue;
      return null;
    }
    if (source !== null) {
      const unpushed = (safe: ReadonlyArray<string>) =>
        git
          .execute({
            operation: "StorageCleanup.unpushedCommits",
            cwd: repo,
            args: [
              "rev-list",
              "--max-count=1",
              "HEAD",
              // Only checkpoints are copied below. Other refs/t3 refs may
              // hold unique work and must prevent deletion just like any other ref.
              "--exclude=refs/t3/checkpoints/*",
              "--all",
              "--not",
              ...safe,
            ],
          })
          .pipe(Effect.map((result) => result.stdout.trim() !== ""));
      // A clone starts with the source's local branches, so a source with no
      // origin, or a main ahead of it, looks unpushed. Commits a source branch
      // reaches survive removal too: mirror the source's branches the way
      // `workler branch-sync` does, only when needed, then check again. Older
      // mirrored refs may be stale, so they only count after this --prune copy.
      if (yield* unpushed(["--exclude=workler-root/*", "--remotes"])) {
        yield* git.execute({
          operation: "StorageCleanup.sourceBranches",
          cwd: repo,
          args: [
            "fetch",
            "--no-recurse-submodules",
            "--no-tags",
            "--no-write-fetch-head",
            "--prune",
            source,
            "+refs/heads/*:refs/remotes/workler-root/*",
          ],
        });
        if (yield* unpushed(["--remotes"])) return null;
      }
    }
    return head.commitSha;
  });

  // A group workspace folder holds its members, the folders leading to them,
  // Workler's unchanged copy of .workler and Finder's .DS_Store files. Anything
  // else there is in no repository.
  const groupFolderHoldsOnlyMembers = Effect.fn("StorageCleanup.groupFolderHoldsOnlyMembers")(
    function* (worktreePath: string, members: ReadonlyArray<string>) {
      // The copy is outside Git, so an edited one (or a link in its place) stays.
      const configPath = path.join(worktreePath, MultiRepoWorkspaces.WORKLER_CONFIG_FILE);
      if ((yield* fs.realPath(configPath)) !== configPath) return false;
      if ((yield* fs.stat(configPath)).type !== "File") return false;
      const originalConfig = path.join(
        path.dirname(path.dirname(worktreePath)),
        MultiRepoWorkspaces.WORKLER_CONFIG_FILE,
      );
      if ((yield* fs.readFileString(configPath)) !== (yield* fs.readFileString(originalConfig)))
        return false;
      const memberSegments = members.map((member) => member.split(/[\\/]/));
      const startsWith = (member: ReadonlyArray<string>, prefix: ReadonlyArray<string>) =>
        prefix.every((segment, index) => member[index] === segment);
      const visit = Effect.fn("StorageCleanup.visitGroupFolder")(function* (
        prefix: ReadonlyArray<string>,
      ): Effect.fn.Return<boolean, PlatformError> {
        const directory = path.join(worktreePath, ...prefix);
        for (const name of yield* fs.readDirectory(directory)) {
          if (prefix.length === 0 && name === MultiRepoWorkspaces.WORKLER_CONFIG_FILE) continue;
          if (name === ".DS_Store" && (yield* fs.stat(path.join(directory, name))).type === "File")
            continue;
          // Only dependency directories (or links to them) are disposable; a regular file
          // named node_modules is group-level data.
          if (
            prefix.length === 0 &&
            name === "node_modules" &&
            (yield* fs.stat(path.join(directory, name)).pipe(
              Effect.map((info) => info.type === "Directory"),
              Effect.orElseSucceed(() => false),
            ))
          )
            continue;
          const next = [...prefix, name];
          if (
            memberSegments.some(
              (member) => member.length === next.length && startsWith(member, next),
            )
          )
            continue;
          if (
            !memberSegments.some(
              (member) => member.length > next.length && startsWith(member, next),
            )
          )
            return false;
          const target = path.join(directory, name);
          if ((yield* fs.realPath(target)) !== target) return false;
          if (!(yield* visit(next))) return false;
        }
        return true;
      });
      return yield* visit([]);
    },
  );

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    const hasDeleteRule = anyWorktreePolicy(serverSettings, (rules) => rules.worktreeOnDelete);
    const deletedThreads = hasDeleteRule
      ? (yield* snapshots.getDeletedWorktreeThreads()).filter(
          (thread) => resolveWorktreeCleanup(serverSettings, thread.projectId).worktreeOnDelete,
        )
      : [];
    if (deletedThreads.length > 0) {
      // Read tombstones before taking this fence. A later deletion waits for the
      // next sweep; every captured deletion must finish stopping its resources.
      const { snapshotSequence } = yield* snapshots.getSnapshotSequence();
      yield* threadDeletion.drainThrough(snapshotSequence);
    }
    const snapshot = yield* readThreads();
    const root = (yield* fs.exists(config.worktreesDir))
      ? yield* fs.realPath(config.worktreesDir)
      : null;
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups.values()].flatMap((group) => (group.length === 1 ? [group[0]!] : [])),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath))),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = path.resolve(thread.worktreePath!);
      const deleted = "deletedAt" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      if (
        project === undefined ||
        (!deleted && !storageCleanupThreadIdle(thread, now)) ||
        hasTerminal(worktreePath)
      )
        continue;
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(worktreePath))) return;
        if ((yield* fs.realPath(worktreePath)) !== worktreePath) return;
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects])) return;
        const checkout = yield* resolveCheckout(worktreePath, project.workspaceRoot, root);
        if (checkout === null) return;
        const clone = checkout.kind !== "linked";
        const removableSource = (index: number) => (clone ? checkout.sources[index]! : null);
        // Resume recreates a clone from the thread's branch, so a detached one stays.
        if (clone && thread.branch === null) return;
        const heads = new Map<string, string>();
        for (const [index, repo] of checkout.repos.entries()) {
          const head = yield* removableHead(repo, thread.branch, removableSource(index));
          if (head === null) return;
          heads.set(repo, head);
        }
        if (
          checkout.kind === "group" &&
          !(yield* groupFolderHoldsOnlyMembers(worktreePath, checkout.members))
        )
          return;
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          storageCleanupActivityAt(thread) < now - settings.worktreeAfterDays * DAY_MS;
        let eligible = deleted || old;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          for (const [index, repo] of checkout.repos.entries()) {
            // Check against the source repository, fetched once per sweep: it then
            // has every commit its default branch reaches, so a head missing there
            // is not merged either.
            const repositoryCwd = checkout.sources[index]!;
            const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
            const branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
            if (branch === null) return;
            const defaultRef = `refs/remotes/${remote}/${branch}`;
            const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
            if (!refreshed.has(defaultRef)) {
              yield* git.fetchRemoteTrackingBranch({
                cwd: repositoryCwd,
                remoteName: remote,
                remoteBranch: branch,
              });
              refreshed.add(defaultRef);
              refreshedDefaultRefs.set(repositoryCwd, refreshed);
            }
            const base = yield* git.resolveCommit({
              cwd: repositoryCwd,
              revision: defaultRef,
            });
            const ancestor = yield* git.execute({
              operation: "StorageCleanup.integratedBranch",
              cwd: repositoryCwd,
              args: ["merge-base", "--is-ancestor", heads.get(repo)!, base.commitSha],
              allowNonZeroExit: true,
            });
            if (ancestor.exitCode !== 0) return;
          }
          eligible = settings.worktreeUnchanged;
          if (!eligible && settings.worktreeOnMerge && thread.branch !== null) {
            // A group's change can be a pull request in any of its members.
            for (const repo of checkout.repos) {
              const pullRequest = yield* gitManager.branchPullRequest(
                { cwd: repo, branch: thread.branch },
                { refresh: true },
              );
              if (pullRequest?.state === "merged") {
                eligible = true;
                break;
              }
            }
          }
        }
        if (!eligible) return;
        // Re-read after Git/host calls so a queued turn, resumed session or new
        // thread sharing this path cancels the removal.
        const latestSnapshot = yield* readThreads();
        if (yield* containsProjectRoot(worktreePath, [project, ...latestSnapshot.projects])) return;
        const latest = latestSnapshot.threads.filter(
          (entry) =>
            entry.worktreePath !== null && path.resolve(entry.worktreePath) === worktreePath,
        );
        if (hasTerminal(worktreePath)) return;
        if (deleted) {
          if (
            latest.length > 0 ||
            !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
              .worktreeOnDelete
          )
            return;
          // A failed session stop is logged by the deletion reactor. Its drain
          // alone is not proof that a provider released this checkout.
          if (
            (yield* providers.listSessions()).some(
              (session) =>
                session.status !== "closed" &&
                (session.threadId === thread.id ||
                  (session.cwd !== undefined &&
                    (path.resolve(session.cwd) === worktreePath ||
                      inside(worktreePath, path.resolve(session.cwd))))),
            )
          )
            return;
        } else if (
          latest.length !== 1 ||
          latest[0]!.id !== thread.id ||
          !storageCleanupThreadIdle(latest[0]!, now) ||
          storageCleanupActivityAt(latest[0]!) !== storageCleanupActivityAt(thread)
        )
          return;
        for (const [index, repo] of checkout.repos.entries()) {
          if (
            (yield* removableHead(repo, thread.branch, removableSource(index))) !== heads.get(repo)
          )
            return;
        }
        if (
          checkout.kind === "group" &&
          !(yield* groupFolderHoldsOnlyMembers(worktreePath, checkout.members))
        )
          return;
        const current = resolveWorktreeCleanup(
          yield* settingsService.getSettings,
          thread.projectId,
        );
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return;
        if (clone) {
          // Removal first copies the clone's branch (the thread's, checked above),
          // tags and checkpoints into the project, where a linked worktree's refs
          // already live, so resume can recreate the checkout offline. When that
          // copy fails, the clone is kept. The checks above replace Workler's own,
          // which also refuse dependency installs.
          yield* multiRepo.removeWorkspace({ cwd: checkout.root, path: worktreePath, force: true });
        } else {
          yield* git.removeWorktree({ cwd: checkout.root, path: worktreePath, force: false });
        }
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Preserve branch and path: ProviderCommandReactor recreates the checkout
        // from that branch when the thread is resumed.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) =>
          Effect.logDebug("storage cleanup skipped worktree", { threadId: thread.id, error }),
        ),
      );
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
  ) {
    if (days === null || !(yield* fs.exists(root))) return;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
          }
        }
      }
    });
    yield* visit(realRoot);
  });

  const sweep = Effect.fn("StorageCleanup.sweep")(function* () {
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const now = yield* Clock.currentTimeMillis;
    yield* cleanWorktrees(serverSettings, now).pipe(
      Effect.catch((error) => Effect.logWarning("worktree cleanup failed", { error })),
    );
    yield* cleanFiles(
      config.browserArtifactsDir,
      settings.browserArtifactsAfterDays,
      now,
      false,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("browser artifact cleanup failed", { error })),
    );
    yield* cleanFiles(config.logsDir, settings.logsAfterDays, now, true).pipe(
      Effect.catch((error) => Effect.logWarning("rotated log cleanup failed", { error })),
    );
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("storage cleanup failed", { cause }),
      ),
    ),
  );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = yield* engine.subscribeDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      worker
        .enqueue(undefined)
        .pipe(
          Effect.andThen(worker.drain),
          Effect.repeat(Schedule.spaced("1 hour")),
          Effect.asVoid,
        ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        event.type === "thread.deleted" &&
        anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ? worker.enqueue(undefined)
          : Effect.void,
      ),
    );
  });
  return { start, drain: worker.drain } satisfies StorageCleanup["Service"];
});

export const layer = Layer.effect(StorageCleanup, make);
