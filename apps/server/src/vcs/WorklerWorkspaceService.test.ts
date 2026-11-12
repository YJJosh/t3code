// @effect-diagnostics nodeBuiltinImport:off - the cancel test needs a real FIFO and a child process that blocks a worker thread.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

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
          args: [
            "/repo",
            { name: "feature-login", branch: "feature/login", base: "origin/main", setup: false },
          ],
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

  it.effect("removes a workspace that failed after cloning began, and only then", () =>
    Effect.gen(function* () {
      const stub = makeLibrary();
      let code = "SETUP_FAILED";
      const failing = {
        ...stub.library,
        createWorkspace: () => {
          throw new StubWorklerError(
            code,
            "projects/web: clone failed for /group/.worktrees/feat/projects/web: boom\n" +
              "the partial workspace was left in place so you can inspect it, or run `workler remove feat --force`",
          );
        },
      } as unknown as WorklerWorkspaceService.WorklerLibrary;
      const service = WorklerWorkspaceService.makeFromLibrary(Effect.succeed(failing));

      const error = yield* service
        .createWorkspace({ root: "/group", name: "feat", branch: "feat" })
        .pipe(Effect.flip);
      assert.equal(error.code, "SETUP_FAILED");
      assert.equal(
        error.detail,
        "projects/web: clone failed for /group/.worktrees/feat/projects/web: boom",
      );
      assert.deepEqual(stub.calls, [
        { method: "removeWorkspace", args: ["/group", "feat", { force: true }] },
      ]);

      // Plan failures happen before Workler creates anything; a folder at the
      // name may belong to someone else.
      stub.calls.length = 0;
      code = "WORKSPACE_EXISTS";
      yield* service.createWorkspace({ root: "/group", name: "feat" }).pipe(Effect.flip);
      assert.deepEqual(stub.calls, []);
    }),
  );

  it.effect("lets a write that is still waiting for the queue be cancelled", () =>
    Effect.gen(function* () {
      const started: Array<string> = [];
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const service = WorklerWorkspaceService.makeFromRunner(((_method, args) =>
        Effect.gen(function* () {
          const name = (args[1] as { readonly name: string }).name;
          started.push(name);
          if (name === "first") {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          }
          return {
            name,
            path: `/repo/.worktrees/${name}`,
            root: "/repo",
            head: "deadbeef",
            detached: false,
            rules: { results: [] },
          };
        })) as WorklerWorkspaceService.WorklerRunner);

      const first = yield* Effect.forkChild(
        service.createWorkspace({ root: "/repo", name: "first" }),
        { startImmediately: true },
      );
      yield* Deferred.await(firstStarted);
      const second = yield* Effect.forkChild(
        service.createWorkspace({ root: "/repo", name: "second" }),
        { startImmediately: true },
      );
      const cancelling = yield* Effect.forkChild(Fiber.interrupt(second), {
        startImmediately: true,
      });
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(cancelling);

      assert.deepEqual(started, ["first"]);
    }),
  );

  it.effect("runs at most four reads at once", () =>
    Effect.gen(function* () {
      let running = 0;
      const release = yield* Deferred.make<void>();
      const service = WorklerWorkspaceService.makeFromRunner((() =>
        Effect.gen(function* () {
          running += 1;
          yield* Deferred.await(release);
          return [];
        })) as unknown as WorklerWorkspaceService.WorklerRunner);

      const reads = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
        Effect.forkChild(service.listWorkspaces("/repo"), { startImmediately: true }),
      );
      assert.equal(running, 4);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(reads, Fiber.join);
      assert.equal(running, 5);
    }),
  );

  // A worker stuck in a git call can only stop once that call returns, so a
  // cancelled read must hold its place in the read limit until then.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "waits for a cancelled worker to stop before the cancel finishes",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workler-cancel-"));
        const started = NodePath.join(dir, "started");
        const release = NodePath.join(dir, "release");
        NodeChildProcess.execFileSync("mkfifo", [started, release]);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            // Unblock the child if the test failed before releasing it.
            try {
              const fd = NodeFS.openSync(
                release,
                NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK,
              );
              NodeFS.closeSync(fd);
            } catch {}
            NodeFS.rmSync(dir, { recursive: true, force: true });
          }),
        );
        // Stands in for a git call: the child says it's running, then blocks
        // until the test writes to `release`.
        const library = NodePath.join(dir, "blocking-workler.cjs");
        NodeFS.writeFileSync(
          library,
          [
            'const { spawnSync } = require("node:child_process");',
            "exports.listWorkspaces = (started, release) => {",
            '  spawnSync("sh", ["-c", \'echo running > "$0"; cat "$1" > /dev/null\', started, release]);',
            "  return [];",
            "};",
          ].join("\n"),
        );

        const read = yield* Effect.forkChild(
          WorklerWorkspaceService.runInWorker(library, "listWorkspaces", [started, release]),
          { startImmediately: true },
        );
        yield* Effect.promise(() => NodeFS.promises.readFile(started, "utf8"));
        const cancelling = yield* Effect.forkChild(Fiber.interrupt(read), {
          startImmediately: true,
        });
        assert.equal(cancelling.pollUnsafe(), undefined);

        yield* Effect.promise(() => NodeFS.promises.writeFile(release, "go"));
        yield* Fiber.join(cancelling);
      }),
  );
});
