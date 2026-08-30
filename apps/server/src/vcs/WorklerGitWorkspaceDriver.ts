import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";

import {
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsRef,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import { parseRemoteNames, parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorklerWorkspaceService from "./WorklerWorkspaceService.ts";

const MAX_WORKSPACE_NAME_ATTEMPTS = 100;
const MAX_WORKSPACE_NAME_LENGTH = 96;
const LIST_REFS_PAGE_SIZE = 500;
const LIST_REFS_DEFAULT_LIMIT = 100;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;

export function sanitizeWorklerWorkspaceName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_WORKSPACE_NAME_LENGTH)
    .replace(/[-_]+$/g, "");
  const safeName = sanitized.length === 0 ? "workspace" : sanitized;
  return WINDOWS_RESERVED_NAME.test(safeName) ? `workspace-${safeName}` : safeName;
}

function mapWorklerError(
  operation: string,
  cwd: string,
  error: WorklerWorkspaceService.WorklerWorkspaceError,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: "workler",
    cwd,
    detail: error.detail,
    cause: error,
  });
}

function isPathInside(path: Path.Path, parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeManagedWorkspace(
  path: Path.Path,
  root: string,
  workspace: WorklerWorkspaceService.WorklerWorkspaceSummary,
): WorklerWorkspaceService.WorklerWorkspaceSummary | null {
  if (workspace.isMain || !workspace.isClone || workspace.broken !== null) return null;
  const workspacePath = path.normalize(path.resolve(workspace.path));
  const workspacesRoot = path.join(path.normalize(path.resolve(root)), ".worktrees");
  return isPathInside(path, workspacesRoot, workspacePath)
    ? { ...workspace, path: workspacePath }
    : null;
}

function paginateRefs(
  refs: ReadonlyArray<VcsRef>,
  input: VcsListRefsInput,
): Pick<VcsListRefsResult, "refs" | "nextCursor" | "totalCount"> {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? LIST_REFS_DEFAULT_LIMIT;
  const page = refs.slice(cursor, cursor + limit);
  return {
    refs: page,
    nextCursor: cursor + page.length < refs.length ? cursor + page.length : null,
    totalCount: refs.length,
  };
}

export const withWorklerWorkspaceSupport = (input: {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly workler: WorklerWorkspaceService.WorklerWorkspaceService["Service"];
  readonly path: Path.Path;
  readonly settings?: ServerSettingsService["Service"] | undefined;
}): GitVcsDriver.GitVcsDriver["Service"] => {
  const resolveRoot = Effect.fn("WorklerGitWorkspaceDriver.resolveRoot")(function* (cwd: string) {
    const result = yield* input.git.execute({
      operation: "WorklerGitWorkspaceDriver.resolveRoot",
      cwd,
      args: ["rev-parse", "--show-toplevel"],
      timeoutMs: 10_000,
    });
    return result.stdout.trim() || cwd;
  });

  const worklerEnabled = Effect.fn("WorklerGitWorkspaceDriver.worklerEnabled")(function* (
    cwd: string,
  ) {
    // Focused Git tests and embedded callers that do not provide server settings
    // keep the upstream-native creation strategy.
    if (!input.settings) return false;
    return yield* input.settings.getSettings.pipe(
      Effect.map((value) => value.useWorklerForNewWorkspaces),
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.createWorktree",
            command: "settings",
            cwd,
            detail: "Failed to read the Workler workspace creation setting.",
            cause,
          }),
      ),
    );
  });

  const createWorktree = Effect.fn("WorklerGitWorkspaceDriver.createWorktree")(function* (
    createInput: VcsCreateWorktreeInput,
  ): Effect.fn.Return<VcsCreateWorktreeResult, GitCommandError> {
    if (!(yield* worklerEnabled(createInput.cwd)) || createInput.path !== null) {
      return yield* input.git.createWorktree(createInput);
    }

    const root = yield* resolveRoot(createInput.cwd);
    const existing = yield* input.workler
      .listWorkspaces(root)
      .pipe(
        Effect.mapError((error) =>
          mapWorklerError("GitVcsDriver.createWorktree", createInput.cwd, error),
        ),
      );
    const managedWorkspaces = existing.flatMap((workspace) => {
      const managed = normalizeManagedWorkspace(input.path, root, workspace);
      return managed ? [managed] : [];
    });
    const targetBranch = createInput.newRefName ?? createInput.refName;
    if (managedWorkspaces.some((workspace) => workspace.branch === targetBranch)) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree",
        command: "workler",
        cwd: createInput.cwd,
        detail: `Branch '${targetBranch}' is already checked out in a Workler workspace.`,
      });
    }

    const usedNames = new Set(existing.map((workspace) => workspace.name));
    const baseName = sanitizeWorklerWorkspaceName(targetBranch);
    let workspaceName: string | null = null;
    for (let attempt = 0; attempt < MAX_WORKSPACE_NAME_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
      if (!usedNames.has(candidate)) {
        workspaceName = candidate;
        break;
      }
    }
    if (workspaceName === null) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree",
        command: "workler",
        cwd: createInput.cwd,
        detail: `Could not find an available Workler workspace name for '${baseName}'.`,
      });
    }

    const workspace = yield* input.workler
      .createWorkspace(
        createInput.newRefName
          ? {
              root,
              name: workspaceName,
              branch: createInput.newRefName,
              base: createInput.refName,
            }
          : { root, name: workspaceName, checkout: createInput.refName },
      )
      .pipe(
        Effect.mapError((error) =>
          mapWorklerError("GitVcsDriver.createWorktree", createInput.cwd, error),
        ),
      );
    const managedWorkspace = normalizeManagedWorkspace(input.path, root, {
      ...workspace,
      isMain: false,
      isClone: true,
      broken: null,
    });
    if (!managedWorkspace) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree",
        command: "workler",
        cwd: createInput.cwd,
        detail: "Workler returned a workspace path outside the repository's .worktrees directory.",
      });
    }

    if (createInput.newRefName && createInput.baseRefName) {
      const remoteNames = yield* input.git
        .execute({
          operation: "WorklerGitWorkspaceDriver.remoteNames",
          cwd: createInput.cwd,
          args: ["remote"],
          timeoutMs: 5_000,
        })
        .pipe(
          Effect.map((result) => parseRemoteNames(result.stdout)),
          Effect.orElseSucceed(() => []),
        );
      const remoteBase = parseRemoteRefWithRemoteNames(createInput.baseRefName, remoteNames);
      const baseBranch = remoteBase?.branchName ?? createInput.baseRefName;
      yield* input.git.execute({
        operation: "GitVcsDriver.createWorktree.configureBaseRef",
        cwd: managedWorkspace.path,
        args: ["config", `branch.${createInput.newRefName}.gh-merge-base`, baseBranch],
        timeoutMs: 10_000,
      });
      if (remoteBase && /^[0-9a-f]{40}$/i.test(createInput.refName)) {
        yield* input.git.execute({
          operation: "GitVcsDriver.createWorktree.pinBaseTrackingRef",
          cwd: managedWorkspace.path,
          args: ["update-ref", `refs/remotes/${remoteBase.remoteRef}`, createInput.refName],
          timeoutMs: 10_000,
        });
      }
    }

    return {
      worktree: {
        path: managedWorkspace.path,
        refName: workspace.branch ?? targetBranch,
      },
    };
  });

  const listAllNativeRefs = Effect.fn("WorklerGitWorkspaceDriver.listAllNativeRefs")(function* (
    listInput: VcsListRefsInput,
  ) {
    const { cursor: _cursor, limit: _limit, ...query } = listInput;
    const refs: Array<VcsRef> = [];
    let cursor: number | null = 0;
    let result: VcsListRefsResult | null = null;
    while (cursor !== null) {
      const page: VcsListRefsResult = yield* input.git.listRefs({
        ...query,
        cursor,
        limit: LIST_REFS_PAGE_SIZE,
      });
      refs.push(...page.refs);
      result = page;
      if (page.nextCursor !== null && page.nextCursor <= cursor) {
        return { result: page, refs };
      }
      cursor = page.nextCursor;
    }
    return { result, refs };
  });

  const listRefs = Effect.fn("WorklerGitWorkspaceDriver.listRefs")(function* (
    listInput: VcsListRefsInput,
  ): Effect.fn.Return<VcsListRefsResult, GitCommandError> {
    const nativeRefs = yield* input.git.listRefs(listInput);
    if (!nativeRefs.isRepo || listInput.refKind === "remote") return nativeRefs;

    const root = yield* resolveRoot(listInput.cwd).pipe(Effect.orElseSucceed(() => null));
    if (!root) return nativeRefs;
    const workspaces = yield* input.workler.listWorkspaces(root).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Workler workspace listing failed; using native Git refs", {
          cwd: listInput.cwd,
          detail: error.detail,
        }).pipe(Effect.as([])),
      ),
    );
    const query = listInput.query?.toLowerCase();
    const managedWorkspaces = workspaces.flatMap((workspace) => {
      const managed = normalizeManagedWorkspace(input.path, root, workspace);
      return managed?.branch && (!query || managed.branch.toLowerCase().includes(query))
        ? [managed as typeof managed & { readonly branch: string }]
        : [];
    });
    if (managedWorkspaces.length === 0) return nativeRefs;

    const allNative = yield* listAllNativeRefs(listInput);
    if (!allNative.result?.isRepo) return nativeRefs;
    const workspacePathByBranch = new Map<string, string>();
    for (const workspace of managedWorkspaces) {
      if (!workspacePathByBranch.has(workspace.branch)) {
        workspacePathByBranch.set(workspace.branch, workspace.path);
      }
    }

    const mergedNative = allNative.refs.map((ref) => {
      const worktreePath = !ref.isRemote ? workspacePathByBranch.get(ref.name) : undefined;
      return worktreePath && ref.worktreePath === null ? { ...ref, worktreePath } : ref;
    });
    const nativeLocalNames = new Set(
      mergedNative.filter((ref) => !ref.isRemote).map((ref) => ref.name),
    );
    const worklerRefs: Array<VcsRef> = [...workspacePathByBranch].flatMap(([name, worktreePath]) =>
      nativeLocalNames.has(name)
        ? []
        : [
            {
              name,
              current: false,
              isRemote: false,
              isDefault: false,
              worktreePath,
            },
          ],
    );
    const firstRemoteIndex = mergedNative.findIndex((ref) => ref.isRemote);
    const insertionIndex = firstRemoteIndex === -1 ? mergedNative.length : firstRemoteIndex;
    const merged = [
      ...mergedNative.slice(0, insertionIndex),
      ...worklerRefs,
      ...mergedNative.slice(insertionIndex),
    ];
    const deduplicated = listInput.includeMatchingRemoteRefs
      ? merged
      : dedupeRemoteBranchesWithLocalMatches(merged);
    return {
      ...allNative.result,
      ...paginateRefs(deduplicated, listInput),
    };
  });

  const removeWorktree = Effect.fn("WorklerGitWorkspaceDriver.removeWorktree")(function* (
    removeInput: VcsRemoveWorktreeInput,
  ): Effect.fn.Return<void, GitCommandError> {
    const gitRemoval = yield* input.git.removeWorktree(removeInput).pipe(Effect.result);
    if (Result.isSuccess(gitRemoval)) return;

    const root = yield* resolveRoot(removeInput.cwd).pipe(Effect.orElseSucceed(() => null));
    if (!root) return yield* gitRemoval.failure;
    const workspaces = yield* input.workler
      .listWorkspaces(root)
      .pipe(Effect.orElseSucceed(() => []));
    const requestedPath = input.path.normalize(
      input.path.resolve(removeInput.cwd, removeInput.path),
    );
    const workspace = workspaces.find((candidate) => {
      const managed = normalizeManagedWorkspace(input.path, root, candidate);
      return managed?.path === requestedPath;
    });
    if (!workspace) return yield* gitRemoval.failure;

    return yield* input.workler
      .removeWorkspace({
        root,
        name: workspace.name,
        ...(removeInput.force === undefined ? {} : { force: removeInput.force }),
      })
      .pipe(
        Effect.mapError((error) =>
          mapWorklerError("GitVcsDriver.removeWorktree", removeInput.cwd, error),
        ),
        Effect.asVoid,
      );
  });

  return {
    ...input.git,
    createWorktree,
    listRefs,
    removeWorktree,
  };
};
