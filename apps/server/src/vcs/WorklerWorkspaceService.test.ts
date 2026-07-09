import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as WorklerWorkspaceService from "./WorklerWorkspaceService.ts";

interface RecordedCall {
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
}

class StubWorklerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function makeStubLibrary(input?: {
  readonly initialized?: boolean;
  readonly failCreateWith?: unknown;
}) {
  const calls: RecordedCall[] = [];
  const initialized = input?.initialized ?? false;
  const library: WorklerWorkspaceService.WorklerLibrary = {
    inspectProject: (root) => {
      calls.push({ method: "inspectProject", args: [root] });
      return {
        root,
        exists: true,
        gitRepo: true,
        marked: initialized,
        configFileExists: initialized,
        workspacesDirExists: initialized,
        initialized,
      };
    },
    initProject: (root) => {
      calls.push({ method: "initProject", args: [root] });
      return {
        root,
        configPath: `${root}/.workler`,
        configCreated: true,
        workspacesPath: `${root}/.worktrees`,
        gitRepo: true,
      };
    },
    createWorkspace: (root, options) => {
      calls.push({ method: "createWorkspace", args: [root, options] });
      if (input?.failCreateWith !== undefined) {
        throw input.failCreateWith;
      }
      return {
        name: options.name,
        path: `${root}/.worktrees/${options.name}`,
        root,
        branch: options.branch ?? options.name,
        head: "0000000000000000000000000000000000000000",
        detached: false,
      };
    },
    listWorkspaces: (root) => {
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
          clean: true,
        },
      ];
    },
    removeWorkspace: (root, name, options) => {
      calls.push({ method: "removeWorkspace", args: [root, name, options] });
      return { name, path: `${root}/.worktrees/${name}` };
    },
  };
  return { library, calls };
}

const withService = <A, E>(
  library: WorklerWorkspaceService.WorklerLibrary,
  use: (service: WorklerWorkspaceService.WorklerWorkspaceService["Service"]) => Effect.Effect<A, E>,
) => use(WorklerWorkspaceService.makeFromLibrary(Effect.succeed(library)));

describe("WorklerWorkspaceService", () => {
  it.effect("ensureProject initializes only uninitialized projects", () =>
    Effect.gen(function* () {
      const uninitialized = makeStubLibrary({ initialized: false });
      yield* withService(uninitialized.library, (service) => service.ensureProject("/repo"));
      assert.deepEqual(
        uninitialized.calls.map((call) => call.method),
        ["inspectProject", "initProject"],
      );

      const initialized = makeStubLibrary({ initialized: true });
      yield* withService(initialized.library, (service) => service.ensureProject("/repo"));
      assert.deepEqual(
        initialized.calls.map((call) => call.method),
        ["inspectProject"],
      );
    }),
  );

  it.effect("passes base and branch through to the library separately from the name", () =>
    Effect.gen(function* () {
      const stub = makeStubLibrary({ initialized: true });
      const created = yield* withService(stub.library, (service) =>
        service.createWorkspace({
          root: "/repo",
          name: "feature-a",
          branch: "feature/a",
          base: "origin/main",
        }),
      );

      assert.deepEqual(stub.calls, [
        {
          method: "createWorkspace",
          args: ["/repo", { name: "feature-a", branch: "feature/a", base: "origin/main" }],
        },
      ]);
      assert.equal(created.path, "/repo/.worktrees/feature-a");
      assert.equal(created.branch, "feature/a");
    }),
  );

  it.effect("maps library errors to typed workspace errors with their code", () =>
    Effect.gen(function* () {
      const stub = makeStubLibrary({
        initialized: true,
        failCreateWith: new StubWorklerError("BRANCH_EXISTS", 'branch "feature/a" already exists'),
      });

      const error = yield* withService(stub.library, (service) =>
        service.createWorkspace({ root: "/repo", name: "feature-a", branch: "feature/a" }),
      ).pipe(Effect.flip);

      assert.equal(error._tag, "WorklerWorkspaceError");
      assert.equal(error.code, "BRANCH_EXISTS");
      assert.equal(error.root, "/repo");
      assert.include(error.detail, "already exists");
    }),
  );

  it.effect("wraps non-workler defects as unexpected errors", () =>
    Effect.gen(function* () {
      const stub = makeStubLibrary({ initialized: true, failCreateWith: "boom" });

      const error = yield* withService(stub.library, (service) =>
        service.createWorkspace({ root: "/repo", name: "feature-a" }),
      ).pipe(Effect.flip);

      assert.equal(error._tag, "WorklerWorkspaceError");
      assert.equal(error.code, "UNEXPECTED");
    }),
  );

  it.effect("normalizes optional workspace listing fields", () =>
    Effect.gen(function* () {
      const stub = makeStubLibrary({ initialized: true });
      const workspaces = yield* withService(stub.library, (service) =>
        service.listWorkspaces("/repo"),
      );

      assert.deepEqual(workspaces, [
        {
          name: "main",
          path: "/repo",
          isMain: true,
          isClone: true,
          broken: null,
          branch: null,
        },
        {
          name: "feature-a",
          path: "/repo/.worktrees/feature-a",
          isMain: false,
          isClone: true,
          broken: null,
          branch: "feature/a",
        },
      ]);
    }),
  );

  it.effect("fails operations with a typed error when the library is unavailable", () =>
    Effect.gen(function* () {
      const unavailable = new WorklerWorkspaceService.WorklerWorkspaceError({
        operation: "WorklerWorkspaceService.loadLibrary",
        root: "",
        code: "LIBRARY_UNAVAILABLE",
        detail: "The `workler` package is not installed.",
      });
      const service = WorklerWorkspaceService.makeFromLibrary(Effect.fail(unavailable));

      const error = yield* service.listWorkspaces("/repo").pipe(Effect.flip);
      assert.equal(error.code, "LIBRARY_UNAVAILABLE");
      assert.equal(error.operation, "WorklerWorkspaceService.listWorkspaces");
      assert.equal(error.root, "/repo");
    }),
  );
});
