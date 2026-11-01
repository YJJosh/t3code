import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { workerThreadEnvironment } from "../process/workerThreadEnvironment.ts";

type WorklerMethod =
  | "createWorkspace"
  | "discoverProjects"
  | "initProject"
  | "inspectProject"
  | "listWorkspaces"
  | "removeWorkspace";

/** A lazy, server-local adapter for Workler's workspace library. */
export type WorklerLibrary = Pick<typeof import("workler"), WorklerMethod>;

export type WorklerWorkspaceErrorCode =
  | import("workler").WorklerErrorCode
  | "LIBRARY_UNAVAILABLE"
  | "NOT_A_PLAIN_FOLDER"
  | "NO_REPOSITORIES"
  | "UNEXPECTED";

/** What one Workler library call threw, in a form that survives a worker thread. */
class WorklerCallFailure extends Data.TaggedError("WorklerCallFailure")<{
  readonly code: WorklerWorkspaceErrorCode;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/** Runs one Workler library call. */
export type WorklerRunner = <M extends WorklerMethod>(
  method: M,
  args: Parameters<WorklerLibrary[M]>,
) => Effect.Effect<ReturnType<WorklerLibrary[M]>, WorklerCallFailure>;

export class WorklerWorkspaceError extends Data.TaggedError("WorklerWorkspaceError")<{
  readonly operation: string;
  readonly root: string;
  readonly code: WorklerWorkspaceErrorCode;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `Workler workspace operation failed in ${this.operation} (${this.root}): ${this.detail}`;
  }
}

export interface WorklerCreateWorkspaceInput {
  readonly root: string;
  readonly name: string;
  readonly base?: string | undefined;
  readonly branch?: string | undefined;
  readonly checkout?: string | undefined;
}

export interface WorklerWorkspaceSummary {
  readonly name: string;
  readonly path: string;
  readonly isMain: boolean;
  readonly isClone: boolean;
  readonly broken: string | null;
  readonly branch: string | null;
}

export interface WorklerCreatedWorkspace {
  readonly name: string;
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
}

/** A plain folder whose `.workler` lists member repositories (a Workler project group). */
export interface WorklerGroup {
  /** Member paths relative to the group root, as written in `.workler`. */
  readonly projects: ReadonlyArray<string>;
}

export class WorklerWorkspaceService extends Context.Service<
  WorklerWorkspaceService,
  {
    readonly createWorkspace: (
      input: WorklerCreateWorkspaceInput,
    ) => Effect.Effect<WorklerCreatedWorkspace, WorklerWorkspaceError>;
    readonly listWorkspaces: (
      root: string,
    ) => Effect.Effect<ReadonlyArray<WorklerWorkspaceSummary>, WorklerWorkspaceError>;
    readonly removeWorkspace: (input: {
      readonly root: string;
      readonly name: string;
      readonly force?: boolean | undefined;
    }) => Effect.Effect<{ readonly name: string; readonly path: string }, WorklerWorkspaceError>;
    /** The group at `root`, or null when `root` is a repository or a plain folder. */
    readonly inspectGroup: (
      root: string,
    ) => Effect.Effect<WorklerGroup | null, WorklerWorkspaceError>;
    /**
     * Makes the plain folder at `root` a group of the repositories inside it,
     * as `workler init` does. Returns an existing group unchanged.
     */
    readonly initGroup: (root: string) => Effect.Effect<WorklerGroup, WorklerWorkspaceError>;
  }
>()("t3/vcs/WorklerWorkspaceService") {}

/**
 * Workler's `canWriteConfigPath`: a member path a `.workler` line can hold.
 * Its `init` skips other repositories, and with none left writes a
 * single-repository template instead of a group.
 */
export function canWriteProjectPath(value: string): boolean {
  return !/[\r\n\\]/.test(value) && !(value.includes('"') && value.includes("'"));
}

const UNEXPECTED_DETAIL = "Workler workspace operation failed unexpectedly.";

/** Drops Workler's last line telling the user the partial workspace is still there. */
function withoutLeftInPlaceHint(detail: string): string {
  const lines = detail.split("\n");
  return lines.length > 1 && lines.at(-1)?.includes("left in place")
    ? lines.slice(0, -1).join("\n")
    : detail;
}

function toCallFailure(cause: unknown): WorklerCallFailure {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? new WorklerCallFailure({
        code: cause.code as WorklerWorkspaceErrorCode,
        detail: cause.message,
        cause,
      })
    : new WorklerCallFailure({ code: "UNEXPECTED", detail: UNEXPECTED_DETAIL, cause });
}

// Workler fails fast with LOCKED instead of waiting for another write to the
// same project, and a group write also locks its member repositories.
// In-process calls used to serialize writes; on workers they must queue.
// The lock files name this process, so the queue is per process too.
const worklerWrites = Semaphore.makeUnsafe(1);
// Reads hold no lock, but each one starts a thread and several git processes,
// so only a few run at once and rapid branch-picker refreshes wait their turn.
const worklerReads = Semaphore.makeUnsafe(4);

// Waiting for the queue stays interruptible. Once a write starts it always
// finishes, cleanup included: stopping it would leave Workler's project lock
// behind, owned by this still-running process.
const write = <A, E>(effect: Effect.Effect<A, E>) =>
  worklerWrites.withPermits(1)(Effect.uninterruptible(effect));
const read = <A, E>(effect: Effect.Effect<A, E>) => worklerReads.withPermits(1)(effect);

/** Builds the service over a runner; tests use it to control when calls finish. */
export const makeFromRunner = (run: WorklerRunner): WorklerWorkspaceService["Service"] => {
  const call = <M extends WorklerMethod>(
    operation: string,
    root: string,
    method: M,
    args: Parameters<WorklerLibrary[M]>,
  ) =>
    run(method, args).pipe(
      Effect.mapError(
        (failure) =>
          new WorklerWorkspaceError({
            operation,
            root,
            code: failure.code,
            detail: failure.detail,
            cause: failure.cause,
          }),
      ),
    );

  return WorklerWorkspaceService.of({
    createWorkspace: Effect.fn("WorklerWorkspaceService.createWorkspace")((input) =>
      write(
        call("WorklerWorkspaceService.createWorkspace", input.root, "createWorkspace", [
          input.root,
          {
            name: input.name,
            ...(input.base === undefined ? {} : { base: input.base }),
            ...(input.branch === undefined ? {} : { branch: input.branch }),
            ...(input.checkout === undefined ? {} : { checkout: input.checkout }),
            // T3 runs the project's own setup script for new worktrees.
            setup: false,
          },
        ]).pipe(
          Effect.map((created) => ({
            name: created.name,
            path: created.path,
            branch: created.branch ?? null,
            head: created.head ?? null,
            detached: created.detached,
          })),
          // SETUP_FAILED means cloning had begun: Workler's plan already saw the
          // folder was new, and it leaves the partial workspace for inspection.
          // T3 users never see that folder, so remove it.
          Effect.catchIf(
            (error) => error.code === "SETUP_FAILED",
            (error) =>
              call("WorklerWorkspaceService.createWorkspace", input.root, "removeWorkspace", [
                input.root,
                input.name,
                { force: true },
              ]).pipe(
                Effect.matchEffect({
                  onFailure: (cleanup) =>
                    Effect.logWarning("Could not remove a partially created Workler workspace", {
                      root: input.root,
                      name: input.name,
                      detail: cleanup.detail,
                    }).pipe(Effect.andThen(Effect.fail(error))),
                  onSuccess: () =>
                    Effect.fail(
                      new WorklerWorkspaceError({
                        operation: error.operation,
                        root: error.root,
                        code: error.code,
                        detail: withoutLeftInPlaceHint(error.detail),
                        cause: error.cause,
                      }),
                    ),
                }),
              ),
          ),
        ),
      ),
    ),
    listWorkspaces: Effect.fn("WorklerWorkspaceService.listWorkspaces")((root) =>
      read(
        call("WorklerWorkspaceService.listWorkspaces", root, "listWorkspaces", [root]).pipe(
          Effect.map((workspaces) =>
            workspaces.map((workspace) => ({
              name: workspace.name,
              path: workspace.path,
              isMain: workspace.isMain,
              isClone: workspace.isClone,
              broken: workspace.broken ?? null,
              branch: workspace.branch ?? null,
            })),
          ),
        ),
      ),
    ),
    removeWorkspace: Effect.fn("WorklerWorkspaceService.removeWorkspace")((input) =>
      write(
        call("WorklerWorkspaceService.removeWorkspace", input.root, "removeWorkspace", [
          input.root,
          input.name,
          input.force === undefined ? {} : { force: input.force },
        ]).pipe(Effect.map((removed) => ({ name: removed.name, path: removed.path }))),
      ),
    ),
    inspectGroup: Effect.fn("WorklerWorkspaceService.inspectGroup")((root) =>
      read(
        call("WorklerWorkspaceService.inspectGroup", root, "inspectProject", [root]).pipe(
          Effect.map((info) => (info.isGroup ? { projects: info.projects } : null)),
        ),
      ),
    ),
    initGroup: Effect.fn("WorklerWorkspaceService.initGroup")(function* (root) {
      const operation = "WorklerWorkspaceService.initGroup";
      const refuse = (code: WorklerWorkspaceErrorCode, detail: string) =>
        new WorklerWorkspaceError({ operation, root, code, detail });
      const info = yield* read(call(operation, root, "inspectProject", [root]));
      if (info.isGroup) return { projects: info.projects };
      if (!info.exists) return yield* refuse("ROOT_NOT_FOUND", `${root} does not exist.`);
      // `init` writes Workler's single-repository template when it finds
      // nothing to group, so only a plain folder holding repositories gets here.
      if (info.gitRepo) {
        return yield* refuse("NOT_A_PLAIN_FOLDER", `${root} is a Git repository.`);
      }
      if (info.configFileExists) {
        return yield* refuse(
          "NOT_A_PLAIN_FOLDER",
          info.configError ?? `${root} already has a .workler file that lists no repositories.`,
        );
      }
      const found = yield* read(call(operation, root, "discoverProjects", [root]));
      if (!found.some(canWriteProjectPath)) {
        return yield* refuse("NO_REPOSITORIES", `No Git repositories were found in ${root}.`);
      }
      const result = yield* write(call(operation, root, "initProject", [root]));
      return { projects: result.projects };
    }),
  });
};

const runInProcess =
  (library: Effect.Effect<WorklerLibrary, WorklerWorkspaceError>): WorklerRunner =>
  (method, args) =>
    library.pipe(
      Effect.mapError(
        (error) =>
          new WorklerCallFailure({ code: error.code, detail: error.detail, cause: error.cause }),
      ),
      Effect.flatMap((resolved) =>
        Effect.try({
          try: () =>
            (resolved[method] as (...input: ReadonlyArray<unknown>) => unknown)(
              ...args,
            ) as ReturnType<WorklerLibrary[typeof method]>,
          catch: toCallFailure,
        }),
      ),
    );

/** Builds the service over an in-process library; the server uses `make` instead. */
export const makeFromLibrary = (
  library: Effect.Effect<WorklerLibrary, WorklerWorkspaceError>,
): WorklerWorkspaceService["Service"] => makeFromRunner(runInProcess(library));

/** The worker could not start or load Workler, so nothing has run yet. */
class WorklerWorkerUnavailable extends Data.TaggedError("WorklerWorkerUnavailable")<{
  readonly cause: unknown;
}> {}

// Workler shells out to git synchronously. One call can take seconds (cloning
// every member of a group) and even a listing runs several git commands per
// workspace, so each call runs on its own worker thread.
const WORKLER_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
let workler;
try {
  workler = require(workerData.libraryPath);
} catch (error) {
  parentPort.postMessage({
    _tag: "unavailable",
    message: error instanceof Error ? error.message : String(error),
  });
}
if (workler) {
  try {
    const value = workler[workerData.method](...workerData.args);
    parentPort.postMessage({
      _tag: "success",
      value: value === undefined ? null : JSON.parse(JSON.stringify(value)),
    });
  } catch (error) {
    parentPort.postMessage({
      _tag: "failure",
      code: error && typeof error.code === "string" ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
`;

type WorklerWorkerMessage =
  | { readonly _tag: "unavailable"; readonly message: string }
  | { readonly _tag: "success"; readonly value: unknown }
  | { readonly _tag: "failure"; readonly code: string | null; readonly message: string };

/** Runs one Workler call in a fresh worker thread. Exported for tests. */
export const runInWorker = (
  libraryPath: string,
  method: WorklerMethod,
  args: ReadonlyArray<unknown>,
): Effect.Effect<unknown, WorklerCallFailure | WorklerWorkerUnavailable> =>
  Effect.callback<unknown, WorklerCallFailure | WorklerWorkerUnavailable>((resume) => {
    let worker: NodeWorkerThreads.Worker;
    try {
      worker = new NodeWorkerThreads.Worker(WORKLER_WORKER_SOURCE, {
        eval: true,
        env: workerThreadEnvironment(undefined),
        workerData: { libraryPath, method, args },
      });
    } catch (cause) {
      resume(Effect.fail(new WorklerWorkerUnavailable({ cause })));
      return;
    }
    let settled = false;
    let stopped: Promise<unknown> = Promise.resolve();
    const stop = () => {
      if (!settled) {
        settled = true;
        stopped = worker.terminate().catch(() => undefined);
      }
      return stopped;
    };
    const settle = (
      result: Effect.Effect<unknown, WorklerCallFailure | WorklerWorkerUnavailable>,
    ) => {
      if (settled) return;
      void stop();
      resume(result);
    };
    worker.once("message", (message: WorklerWorkerMessage) => {
      switch (message._tag) {
        case "success":
          return settle(Effect.succeed(message.value));
        case "failure":
          return settle(
            Effect.fail(
              message.code === null
                ? new WorklerCallFailure({
                    code: "UNEXPECTED",
                    detail: UNEXPECTED_DETAIL,
                    cause: message.message,
                  })
                : new WorklerCallFailure({
                    code: message.code as WorklerWorkspaceErrorCode,
                    detail: message.message,
                  }),
            ),
          );
        case "unavailable":
          return settle(Effect.fail(new WorklerWorkerUnavailable({ cause: message.message })));
      }
    });
    worker.once("error", (cause) =>
      settle(
        Effect.fail(
          new WorklerCallFailure({ code: "UNEXPECTED", detail: UNEXPECTED_DETAIL, cause }),
        ),
      ),
    );
    worker.once("exit", (code) =>
      settle(
        Effect.fail(
          new WorklerCallFailure({
            code: "UNEXPECTED",
            detail: `The Workler worker exited with code ${code} before replying.`,
          }),
        ),
      ),
    );
    // Only reads can be interrupted (writes run uninterruptibly), and a read
    // holds no lock, so stopping its worker is safe. The worker can only stop
    // once its git call returns, so wait for that: the read keeps its place in
    // the read limit until then.
    return Effect.promise(stop);
  });

// Workler stays external to the CLI bundle because it reads its own
// package.json at load. Inside the Node single-executable (the Windows WSL
// runtime), `import()` cannot load files from disk, while `require` always
// reads the real filesystem.
const requireForWorkler = NodeModule.createRequire(import.meta.url);

/** @public */
export const make = Effect.gen(function* () {
  const library = yield* Effect.cached(
    Effect.try({
      try: () => requireForWorkler("workler") as WorklerLibrary,
      catch: (cause) =>
        new WorklerWorkspaceError({
          operation: "WorklerWorkspaceService.loadLibrary",
          root: "",
          code: "LIBRARY_UNAVAILABLE",
          detail: "The bundled Workler library could not be loaded by this server install.",
          cause,
        }),
    }),
  );
  const inProcess = runInProcess(library);
  const libraryPath = yield* Effect.cached(
    Effect.try({
      try: () => requireForWorkler.resolve("workler"),
      catch: (cause) => new WorklerWorkerUnavailable({ cause }),
    }),
  );
  const run: WorklerRunner = (method, args) =>
    libraryPath.pipe(
      Effect.flatMap((path) => runInWorker(path, method, args)),
      Effect.catchTags({ WorklerWorkerUnavailable: () => inProcess(method, args) }),
    ) as Effect.Effect<ReturnType<WorklerLibrary[typeof method]>, WorklerCallFailure>;
  return makeFromRunner(run);
});

export const layer = Layer.effect(WorklerWorkspaceService, make);
