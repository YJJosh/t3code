import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";

import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  type VcsCreateWorktreeResult,
  type VcsListRefsResult,
  type VcsRef,
} from "@t3tools/contracts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  sanitizeWorklerWorkspaceName,
  withWorklerWorkspaceSupport,
} from "./WorklerGitWorkspaceDriver.ts";
import * as WorklerWorkspaceService from "./WorklerWorkspaceService.ts";

function normalizePosix(value: string): string {
  const absolute = value.startsWith("/");
  const parts: Array<string> = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const normalized = `${absolute ? "/" : ""}${parts.join("/")}`;
  return normalized || (absolute ? "/" : ".");
}

const path = {
  sep: "/",
  isAbsolute: (value: string) => value.startsWith("/"),
  join: (...values: ReadonlyArray<string>) => normalizePosix(values.join("/")),
  normalize: normalizePosix,
  relative: (from: string, to: string) => {
    const fromParts = normalizePosix(from).split("/").filter(Boolean);
    const toParts = normalizePosix(to).split("/").filter(Boolean);
    let common = 0;
    while (fromParts[common] === toParts[common] && common < fromParts.length) common += 1;
    return [...fromParts.slice(common).map(() => ".."), ...toParts.slice(common)].join("/");
  },
  resolve: (...values: ReadonlyArray<string>) => {
    const lastAbsolute = values.findLastIndex((value) => value.startsWith("/"));
    return normalizePosix(values.slice(Math.max(0, lastAbsolute)).join("/"));
  },
} as unknown as Path.Path;

const successfulExecution = (stdout = "") => ({
  exitCode: 0,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function gitError(detail: string): GitCommandError {
  return new GitCommandError({
    operation: "GitVcsDriver.test",
    command: "git",
    cwd: "/repo",
    detail,
  });
}

function makeSettings(enabled: boolean): ServerSettingsService["Service"] {
  return {
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      useWorklerForNewWorkspaces: enabled,
    }),
  } as unknown as ServerSettingsService["Service"];
}

function makeGit(
  calls: Array<string>,
  overrides: Partial<GitVcsDriver.GitVcsDriver["Service"]> = {},
): GitVcsDriver.GitVcsDriver["Service"] {
  return {
    execute: (input: GitVcsDriver.ExecuteGitInput) => {
      calls.push(`git.execute:${input.args.join(" ")}:${input.cwd}`);
      if (input.args[0] === "rev-parse") return Effect.succeed(successfulExecution("/repo\n"));
      if (input.args[0] === "remote") return Effect.succeed(successfulExecution("origin\n"));
      return Effect.succeed(successfulExecution());
    },
    createWorktree: () => {
      calls.push("git.create");
      return Effect.succeed({ worktree: { path: "/git-worktree", refName: "feature/work" } });
    },
    listRefs: () =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 0,
      }),
    removeWorktree: () => {
      calls.push("git.remove");
      return Effect.void;
    },
    ...overrides,
  } as unknown as GitVcsDriver.GitVcsDriver["Service"];
}

function makeWorkler(
  calls: Array<string>,
  overrides: Partial<WorklerWorkspaceService.WorklerWorkspaceService["Service"]> = {},
): WorklerWorkspaceService.WorklerWorkspaceService["Service"] {
  return {
    listWorkspaces: () => {
      calls.push("workler.list");
      return Effect.succeed([]);
    },
    createWorkspace: (input) => {
      calls.push(`workler.create:${input.name}:${input.branch ?? ""}:${input.base ?? ""}`);
      return Effect.succeed({
        name: input.name,
        path: `/repo/.worktrees/${input.name}`,
        branch: input.branch ?? null,
        head: null,
        detached: false,
      });
    },
    removeWorkspace: (input) => {
      calls.push(`workler.remove:${input.name}:${String(input.force)}`);
      return Effect.succeed({ name: input.name, path: `/repo/.worktrees/${input.name}` });
    },
    ...overrides,
  };
}

function makeDriver(input: {
  readonly calls: Array<string>;
  readonly enabled?: boolean;
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly workler?: Partial<WorklerWorkspaceService.WorklerWorkspaceService["Service"]>;
}) {
  return withWorklerWorkspaceSupport({
    git: makeGit(input.calls, input.git),
    workler: makeWorkler(input.calls, input.workler),
    path,
    ...(input.enabled === undefined ? {} : { settings: makeSettings(input.enabled) }),
  });
}

function listResult(
  refs: ReadonlyArray<VcsRef>,
  input: { cursor?: number | undefined; limit?: number | undefined },
) {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? 100;
  const page = refs.slice(cursor, cursor + limit);
  return {
    refs: page,
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: cursor + page.length < refs.length ? cursor + page.length : null,
    totalCount: refs.length,
  } satisfies VcsListRefsResult;
}

describe("sanitizeWorklerWorkspaceName", () => {
  it("produces a deterministic portable path component", () => {
    assert.equal(sanitizeWorklerWorkspaceName(" feature/Add login?! "), "feature-add-login");
    assert.equal(sanitizeWorklerWorkspaceName("..."), "workspace");
    assert.equal(sanitizeWorklerWorkspaceName("CON"), "workspace-con");
  });
});

describe("WorklerGitWorkspaceDriver creation", () => {
  it.effect("uses Workler only when the compatibility setting is enabled", () => {
    const calls: Array<string> = [];
    const driver = makeDriver({ calls, enabled: true });

    return driver
      .createWorktree({
        cwd: "/repo",
        path: null,
        refName: "origin/main",
        newRefName: "feature/work",
      })
      .pipe(
        Effect.tap((created) =>
          Effect.sync(() => {
            assert.equal(created.worktree.path, "/repo/.worktrees/feature-work");
            assert.deepEqual(calls, [
              "git.execute:rev-parse --show-toplevel:/repo",
              "workler.list",
              "workler.create:feature-work:feature/work:origin/main",
            ]);
          }),
        ),
      );
  });

  it.effect("keeps native Git creation when Workler is disabled or settings are absent", () =>
    Effect.gen(function* () {
      for (const enabled of [false, undefined] as const) {
        const calls: Array<string> = [];
        const created: VcsCreateWorktreeResult = yield* makeDriver({
          calls,
          ...(enabled === undefined ? {} : { enabled }),
        }).createWorktree({
          cwd: "/repo",
          path: null,
          refName: "main",
          newRefName: "feature/work",
        });
        assert.equal(created.worktree.path, "/git-worktree");
        assert.deepEqual(calls, ["git.create"]);
      }
    }),
  );

  it.effect("keeps native Git creation for an explicit path", () => {
    const calls: Array<string> = [];
    const driver = makeDriver({ calls, enabled: true });
    return driver
      .createWorktree({
        cwd: "/repo",
        path: "/chosen/path",
        refName: "main",
        newRefName: "feature/work",
      })
      .pipe(
        Effect.tap((created) =>
          Effect.sync(() => {
            assert.equal(created.worktree.path, "/git-worktree");
            assert.deepEqual(calls, ["git.create"]);
          }),
        ),
      );
  });

  it.effect("rejects a branch already checked out by a managed clone", () => {
    const calls: Array<string> = [];
    const driver = makeDriver({
      calls,
      enabled: true,
      workler: {
        listWorkspaces: () =>
          Effect.succeed([
            {
              name: "existing",
              path: "/repo/.worktrees/existing",
              isMain: false,
              isClone: true,
              broken: null,
              branch: "feature/work",
            },
          ]),
      },
    });

    return driver
      .createWorktree({
        cwd: "/repo",
        path: null,
        refName: "main",
        newRefName: "feature/work",
      })
      .pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            assert.include(error.detail, "already checked out");
            assert.notInclude(calls.join("\n"), "workler.create");
          }),
        ),
      );
  });

  it.effect("preserves remote-base metadata for a pinned origin commit", () => {
    const calls: Array<string> = [];
    const sha = "a".repeat(40);
    const driver = makeDriver({ calls, enabled: true });

    return driver
      .createWorktree({
        cwd: "/repo",
        path: null,
        refName: sha,
        newRefName: "feature/work",
        baseRefName: "origin/main",
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.include(
              calls,
              "git.execute:config branch.feature/work.gh-merge-base main:/repo/.worktrees/feature-work",
            );
            assert.include(
              calls,
              `git.execute:update-ref refs/remotes/origin/main ${sha}:/repo/.worktrees/feature-work`,
            );
          }),
        ),
      );
  });

  it.effect("rejects a library result outside the managed workspace directory", () => {
    const calls: Array<string> = [];
    const driver = makeDriver({
      calls,
      enabled: true,
      workler: {
        createWorkspace: (input) =>
          Effect.succeed({
            name: input.name,
            path: "/outside/workspace",
            branch: input.branch ?? null,
            head: null,
            detached: false,
          }),
      },
    });

    return driver
      .createWorktree({
        cwd: "/repo",
        path: null,
        refName: "main",
        newRefName: "feature/work",
      })
      .pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => assert.include(error.detail, "outside the repository's .worktrees")),
        ),
      );
  });
});

describe("WorklerGitWorkspaceDriver listing", () => {
  const nativeRefs: ReadonlyArray<VcsRef> = [
    {
      name: "main",
      current: true,
      isRemote: false,
      isDefault: true,
      worktreePath: "/repo",
    },
    {
      name: "origin/feature/work",
      remoteName: "origin",
      current: false,
      isRemote: true,
      isDefault: false,
      worktreePath: null,
    },
  ];

  it.effect("adds managed clone branches, deduplicates origin, and paginates the merged list", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const driver = makeDriver({
        calls,
        enabled: false,
        git: {
          listRefs: (input) => Effect.succeed(listResult(nativeRefs, input)),
        },
        workler: {
          listWorkspaces: () =>
            Effect.succeed([
              {
                name: "feature-work",
                path: "/repo/.worktrees/feature-work",
                isMain: false,
                isClone: true,
                broken: null,
                branch: "feature/work",
              },
            ]),
        },
      });

      const first = yield* driver.listRefs({ cwd: "/repo", limit: 1 });
      assert.equal(first.totalCount, 2);
      assert.equal(first.nextCursor, 1);
      assert.deepEqual(
        first.refs.map((ref) => ref.name),
        ["main"],
      );

      const second = yield* driver.listRefs({ cwd: "/repo", cursor: 1, limit: 1 });
      assert.equal(second.nextCursor, null);
      assert.deepEqual(second.refs, [
        {
          name: "feature/work",
          current: false,
          isRemote: false,
          isDefault: false,
          worktreePath: "/repo/.worktrees/feature-work",
        },
      ]);
    }),
  );

  it.effect("falls back to the native list when Workler inspection fails", () => {
    const calls: Array<string> = [];
    const native = listResult(nativeRefs, { limit: 1 });
    const driver = makeDriver({
      calls,
      git: { listRefs: () => Effect.succeed(native) },
      workler: {
        listWorkspaces: () =>
          Effect.fail(
            new WorklerWorkspaceService.WorklerWorkspaceError({
              operation: "list",
              root: "/repo",
              code: "UNEXPECTED",
              detail: "failed",
            }),
          ),
      },
    });

    return driver
      .listRefs({ cwd: "/repo", limit: 1 })
      .pipe(Effect.tap((result) => Effect.sync(() => assert.deepEqual(result, native))));
  });
});

describe("WorklerGitWorkspaceDriver removal", () => {
  it.effect("lets native Git remove registered worktrees first", () => {
    const calls: Array<string> = [];
    const driver = makeDriver({ calls, enabled: true });
    return driver.removeWorktree({ cwd: "/repo", path: "/git-worktree" }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepEqual(calls, ["git.remove"]);
        }),
      ),
    );
  });

  it.effect("removes an exact contained managed clone after native Git rejects it", () => {
    const calls: Array<string> = [];
    const driver = makeDriver({
      calls,
      enabled: false,
      git: {
        removeWorktree: () => {
          calls.push("git.remove");
          return Effect.fail(gitError("not a registered worktree"));
        },
      },
      workler: {
        listWorkspaces: () =>
          Effect.succeed([
            {
              name: "feature-work",
              path: "/repo/.worktrees/feature-work",
              isMain: false,
              isClone: true,
              broken: null,
              branch: "feature/work",
            },
          ]),
      },
    });

    return driver
      .removeWorktree({
        cwd: "/repo",
        path: "/repo/.worktrees/other/../feature-work",
        force: true,
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.include(calls, "workler.remove:feature-work:true");
          }),
        ),
      );
  });

  it.effect("never turns an outside path into a Workler deletion", () => {
    const calls: Array<string> = [];
    const nativeError = gitError("not a registered worktree");
    const driver = makeDriver({
      calls,
      git: {
        removeWorktree: () => {
          calls.push("git.remove");
          return Effect.fail(nativeError);
        },
      },
      workler: {
        listWorkspaces: () =>
          Effect.succeed([
            {
              name: "outside",
              path: "/outside/workspace",
              isMain: false,
              isClone: true,
              broken: null,
              branch: "feature/outside",
            },
          ]),
      },
    });

    return driver.removeWorktree({ cwd: "/repo", path: "/outside/workspace" }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          assert.strictEqual(error, nativeError);
          assert.notInclude(calls.join("\n"), "workler.remove");
        }),
      ),
    );
  });
});
