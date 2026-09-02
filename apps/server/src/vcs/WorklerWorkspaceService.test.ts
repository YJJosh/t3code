import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as WorklerWorkspaceService from "./WorklerWorkspaceService.ts";

class StubWorklerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function makeLibrary(): {
  readonly library: WorklerWorkspaceService.WorklerLibrary;
  readonly calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }>;
} {
  const calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }> = [];
  const library = {
    createWorkspace: (
      root: string,
      options: { readonly name: string; readonly branch?: string },
    ) => {
      calls.push({ method: "createWorkspace", args: [root, options] });
      return {
        name: options.name,
        path: `${root}/.worktrees/${options.name}`,
        root,
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        head: "deadbeef",
        detached: false,
        rules: { results: [] },
      };
    },
    listWorkspaces: (root: string) => {
      calls.push({ method: "listWorkspaces", args: [root] });
      return [
        { name: "main", path: root, isMain: true, isClone: true, detached: false },
        {
          name: "feature-a",
          path: `${root}/.worktrees/feature-a`,
          isMain: false,
          isClone: true,
          branch: "feature/a",
          detached: false,
        },
      ];
    },
    removeWorkspace: (root: string, name: string, options?: { readonly force?: boolean }) => {
      calls.push({ method: "removeWorkspace", args: [root, name, options] });
      return { name, path: `${root}/.worktrees/${name}` };
    },
  } as unknown as WorklerWorkspaceService.WorklerLibrary;
  return { calls, library };
}

describe("WorklerWorkspaceService", () => {
  it.effect("keeps branch and filesystem-safe workspace name separate", () =>
    Effect.gen(function* () {
      const stub = makeLibrary();
      const service = WorklerWorkspaceService.makeFromLibrary(Effect.succeed(stub.library));
      const created = yield* service.createWorkspace({
        root: "/repo",
        name: "feature-login",
        branch: "feature/login",
        base: "origin/main",
      });

      assert.deepEqual(stub.calls, [
        {
          method: "createWorkspace",
          args: ["/repo", { name: "feature-login", branch: "feature/login", base: "origin/main" }],
        },
      ]);
      assert.equal(created.branch, "feature/login");
      assert.equal(created.path, "/repo/.worktrees/feature-login");
    }),
  );

  it.effect("normalizes list and remove results at the library boundary", () =>
    Effect.gen(function* () {
      const stub = makeLibrary();
      const service = WorklerWorkspaceService.makeFromLibrary(Effect.succeed(stub.library));

      const workspaces = yield* service.listWorkspaces("/repo");
      assert.equal(workspaces[0]?.branch, null);
      assert.equal(workspaces[0]?.broken, null);
      assert.equal(workspaces[1]?.branch, "feature/a");

      const removed = yield* service.removeWorkspace({
        root: "/repo",
        name: "feature-a",
        force: true,
      });
      assert.deepEqual(removed, { name: "feature-a", path: "/repo/.worktrees/feature-a" });
      assert.deepEqual(stub.calls.at(-1), {
        method: "removeWorkspace",
        args: ["/repo", "feature-a", { force: true }],
      });
    }),
  );

  it.effect("returns a typed unavailable error at the operation boundary", () =>
    Effect.gen(function* () {
      const unavailable = new WorklerWorkspaceService.WorklerWorkspaceError({
        operation: "WorklerWorkspaceService.loadLibrary",
        root: "",
        code: "LIBRARY_UNAVAILABLE",
        detail: "not installed",
      });
      const service = WorklerWorkspaceService.makeFromLibrary(Effect.fail(unavailable));
      const error = yield* service.listWorkspaces("/repo").pipe(Effect.flip);
      assert.equal(error.code, "LIBRARY_UNAVAILABLE");
      assert.equal(error.operation, "WorklerWorkspaceService.listWorkspaces");
      assert.equal(error.root, "/repo");
    }),
  );

  it.effect("normalizes library errors", () =>
    Effect.gen(function* () {
      const library = makeLibrary().library;
      const failing = {
        ...library,
        createWorkspace: () => {
          throw new StubWorklerError("BRANCH_EXISTS", "branch already exists");
        },
      } as unknown as WorklerWorkspaceService.WorklerLibrary;
      const error = yield* WorklerWorkspaceService.makeFromLibrary(Effect.succeed(failing))
        .createWorkspace({ root: "/repo", name: "feature-a" })
        .pipe(Effect.flip);
      assert.equal(error.code, "BRANCH_EXISTS");
      assert.include(error.detail, "already exists");
    }),
  );
});
