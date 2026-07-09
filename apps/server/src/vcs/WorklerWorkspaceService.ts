import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Thin Effect adapter around the `workler` programmatic library API.
 *
 * Workler manages isolated workspaces as ordinary local Git clones under
 * `<repo>/.worktrees/<name>` and applies the repository's `.workler` rules
 * (linked/copied untracked files) to each new workspace. T3 uses it instead of
 * `git worktree add` for new isolated thread workspaces; pre-existing Git
 * worktrees keep working through the Git driver.
 *
 * The library is loaded lazily so layer construction stays side-effect free;
 * the published package is a regular server dependency.
 */

export type WorklerLibrary = Pick<
  typeof import("workler"),
  "initProject" | "inspectProject" | "createWorkspace" | "listWorkspaces" | "removeWorkspace"
>;

export type WorklerWorkspaceErrorCode =
  | import("workler").WorklerErrorCode
  | "LIBRARY_UNAVAILABLE"
  | "UNEXPECTED";

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
  /**
   * Ref the new branch starts from (branch, tag, or commit). Requires
   * `branch`; mutually exclusive with `checkout`.
   */
  readonly base?: string | undefined;
  /**
   * Git branch to create for the workspace. Kept separate from `name` so a
   * slash-containing branch can live in a filesystem-safe directory.
   */
  readonly branch?: string | undefined;
  /** Existing ref to check out without creating a branch. */
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

export class WorklerWorkspaceService extends Context.Service<
  WorklerWorkspaceService,
  {
    /** Initializes Workler project metadata for `root` if missing (idempotent). */
    readonly ensureProject: (root: string) => Effect.Effect<void, WorklerWorkspaceError>;
    readonly createWorkspace: (
      input: WorklerCreateWorkspaceInput,
    ) => Effect.Effect<WorklerCreatedWorkspace, WorklerWorkspaceError>;
    /** Lists Workler-managed workspaces of `root` (never legacy Git worktrees). */
    readonly listWorkspaces: (
      root: string,
    ) => Effect.Effect<ReadonlyArray<WorklerWorkspaceSummary>, WorklerWorkspaceError>;
    readonly removeWorkspace: (input: {
      readonly root: string;
      readonly name: string;
      readonly force?: boolean | undefined;
    }) => Effect.Effect<{ readonly name: string; readonly path: string }, WorklerWorkspaceError>;
  }
>()("t3/vcs/WorklerWorkspaceService") {}

function isWorklerLibraryError(value: unknown): value is Error & { code: string } {
  return (
    value instanceof Error &&
    "code" in value &&
    typeof (value as { code: unknown }).code === "string"
  );
}

const toWorkspaceError = (operation: string, root: string, cause: unknown): WorklerWorkspaceError =>
  isWorklerLibraryError(cause)
    ? new WorklerWorkspaceError({
        operation,
        root,
        code: cause.code as WorklerWorkspaceErrorCode,
        detail: cause.message,
        cause,
      })
    : new WorklerWorkspaceError({
        operation,
        root,
        code: "UNEXPECTED",
        detail: "Workler workspace operation failed unexpectedly.",
        cause,
      });

export const makeFromLibrary = (
  library: Effect.Effect<WorklerLibrary, WorklerWorkspaceError>,
): WorklerWorkspaceService["Service"] => {
  const withLibrary = <A>(
    operation: string,
    root: string,
    run: (library: WorklerLibrary) => A,
  ): Effect.Effect<A, WorklerWorkspaceError> =>
    library.pipe(
      Effect.mapError(
        (error) =>
          new WorklerWorkspaceError({
            operation,
            root,
            code: error.code,
            detail: error.detail,
            cause: error.cause,
          }),
      ),
      Effect.flatMap((resolved) =>
        Effect.try({
          try: () => run(resolved),
          catch: (cause) => toWorkspaceError(operation, root, cause),
        }),
      ),
    );

  return WorklerWorkspaceService.of({
    ensureProject: (root) =>
      withLibrary("WorklerWorkspaceService.ensureProject", root, (workler) => {
        if (!workler.inspectProject(root).initialized) {
          workler.initProject(root);
        }
      }),

    createWorkspace: (input) =>
      withLibrary("WorklerWorkspaceService.createWorkspace", input.root, (workler) => {
        const created = workler.createWorkspace(input.root, {
          name: input.name,
          ...(input.base !== undefined ? { base: input.base } : {}),
          ...(input.branch !== undefined ? { branch: input.branch } : {}),
          ...(input.checkout !== undefined ? { checkout: input.checkout } : {}),
        });
        return {
          name: created.name,
          path: created.path,
          branch: created.branch ?? null,
          head: created.head ?? null,
          detached: created.detached,
        };
      }),

    listWorkspaces: (root) =>
      withLibrary("WorklerWorkspaceService.listWorkspaces", root, (workler) =>
        workler.listWorkspaces(root).map((workspace) => ({
          name: workspace.name,
          path: workspace.path,
          isMain: workspace.isMain,
          isClone: workspace.isClone,
          broken: workspace.broken ?? null,
          branch: workspace.branch ?? null,
        })),
      ),

    removeWorkspace: (input) =>
      withLibrary("WorklerWorkspaceService.removeWorkspace", input.root, (workler) => {
        const removed = workler.removeWorkspace(
          input.root,
          input.name,
          input.force !== undefined ? { force: input.force } : {},
        );
        return { name: removed.name, path: removed.path };
      }),
  });
};

export const make = Effect.gen(function* () {
  // Resolve on first use. A missing/corrupt production installation still
  // becomes a typed operation failure rather than a layer-construction defect.
  const library = yield* Effect.cached(
    Effect.tryPromise({
      try: () => import(/* @vite-ignore */ "workler") as Promise<WorklerLibrary>,
      catch: (cause) =>
        new WorklerWorkspaceError({
          operation: "WorklerWorkspaceService.loadLibrary",
          root: "",
          code: "LIBRARY_UNAVAILABLE",
          detail:
            "The `workler` package is not installed; isolated workspace management is unavailable.",
          cause,
        }),
    }),
  );
  return makeFromLibrary(library);
});

export const layer = Layer.effect(WorklerWorkspaceService, make);

export const layerFromLibrary = (library: WorklerLibrary) =>
  Layer.succeed(WorklerWorkspaceService, makeFromLibrary(Effect.succeed(library)));
